"""Small read-only Figma REST client using Python stdlib and system curl."""
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
from urllib.parse import parse_qs, unquote, urlencode, urlsplit

API_ORIGIN = 'https://api.figma.com/v1/'
CACHE_TTL = 300


def _reject_json_constant(value):
    raise ValueError('Nonfinite JSON number.')


class OpsError(Exception):
    def __init__(self, code: str, message: str, http_status: int | None = None,
                 retry_after: str | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = http_status
        self.retry_after = retry_after


@dataclass(frozen=True)
class Target:
    file_key: str
    node_id: str | None


@dataclass(frozen=True)
class ApiResponse:
    payload: dict
    fetched_at: str
    cache: str


def _utc(timestamp: float | None = None) -> str:
    return datetime.fromtimestamp(time.time() if timestamp is None else timestamp,
                                  timezone.utc).isoformat().replace('+00:00', 'Z')


def _node(value: str) -> str:
    if not value or value != value.strip() or any(ord(char) < 32 for char in value):
        raise OpsError('invalid_argument', 'Node ID must be nonempty and contain no whitespace controls.')
    return value.replace('-', ':') if re.fullmatch(r'\d+[-:]\d+', value) else value


def parse_target(value: str, node: str | None = None) -> Target:
    """Resolve main/branch file identity while preserving composite instance IDs."""
    if not isinstance(value, str) or not value or any(ord(char) < 33 for char in value):
        raise OpsError('invalid_argument', 'A file key or HTTPS Figma URL is required.')
    url_node = None
    if re.fullmatch(r'[A-Za-z0-9_-]+', value):
        key = value
    else:
        try:
            parsed = urlsplit(value)
            if (parsed.scheme != 'https' or parsed.netloc not in ('figma.com', 'www.figma.com')
                    or parsed.username or parsed.password):
                raise ValueError
            parts = parsed.path.strip('/').split('/')
            if len(parts) < 2 or parts[0] not in ('design', 'file', 'proto'):
                raise ValueError
            key = parts[1]
            if 'branch' in parts[2:]:
                index = parts.index('branch', 2)
                if index != 2 or index + 1 >= len(parts):
                    raise ValueError
                key = parts[index + 1]
            if not re.fullmatch(r'[A-Za-z0-9_-]+', key):
                raise ValueError
            query = parse_qs(parsed.query, keep_blank_values=True)
            if 'node-id' in query:
                url_node = _node(query['node-id'][0])
        except ValueError:
            raise OpsError('invalid_argument', 'Unsupported Figma target URL.') from None
    return Target(key, _node(node) if node is not None else url_node)


def _validate_token(token: str) -> str:
    if not token or any(ord(char) < 32 or ord(char) == 127 for char in token):
        raise OpsError('credential_missing', 'A valid Figma credential is required.')
    return token


def resolve_token() -> tuple[str, str]:
    """Use only the explicit environment credential or the approved Keychain item."""
    if os.environ.get('FIGMA_TOKEN'):
        return _validate_token(os.environ['FIGMA_TOKEN']), 'FIGMA_TOKEN'
    if sys.platform == 'darwin':
        try:
            result = subprocess.run(
                ['security', 'find-generic-password', '-s', 'figma-rest', '-a', 'figma', '-w'],
                capture_output=True, text=True, timeout=35, check=False)
            if result.returncode == 0 and result.stdout.strip():
                return _validate_token(result.stdout.strip()), 'Keychain'
        except (OSError, subprocess.SubprocessError):
            pass
    raise OpsError('credential_missing', 'Set FIGMA_TOKEN or configure the approved Figma Keychain item.')


def atomic_write(path: Path, content: bytes) -> None:
    """Replace a complete artifact atomically with owner-only file permissions."""
    path = Path(path)
    temporary = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.' + path.name + '.',
                                         suffix='.tmp', delete=False) as stream:
            temporary = Path(stream.name)
            os.chmod(temporary, 0o600)
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _http_error(status: int, retry_after: str | None = None) -> OpsError:
    codes = {
        401: ('auth_failed', 'Figma API authentication failed.'),
        403: ('forbidden', 'Figma API access is forbidden.'),
        404: ('not_found_or_inaccessible', 'Figma resource was not found or is inaccessible.'),
        429: ('rate_limited', 'Figma API rate limit reached.'),
    }
    code, message = codes.get(status, ('network_error', 'Figma API request failed.')
                              if status >= 500 else ('invalid_response', 'Unexpected HTTP response.'))
    return OpsError(code, message, status, retry_after if status == 429 else None)


class Client:
    def __init__(self, token: str | None = None, cache_dir: str | Path | None = None,
                 refresh: bool = False, no_cache: bool = False):
        self._token = token
        self.credential_source = 'explicit' if token is not None else None
        self.cache_dir = Path(cache_dir) if cache_dir is not None else Path.home() / '.cache' / 'figma-ops'
        self.refresh = refresh
        self.no_cache = no_cache

    def _credentials(self) -> str:
        if self._token is None:
            self._token, self.credential_source = resolve_token()
        return _validate_token(self._token)

    def _request(self, url: str, token: str | None = None) -> bytes:
        """Curl configuration is stdin-only; stderr and response bodies never enter errors."""
        with tempfile.TemporaryDirectory(prefix='figma-ops-') as directory:
            body_path = Path(directory) / 'body'
            headers_path = Path(directory) / 'headers'
            argv = ['curl', '-q', '--silent', '--show-error', '--max-time', '35',
                    '--proto', '=https', '--globoff', '--dump-header', str(headers_path),
                    '--output', str(body_path), '--write-out', '%{http_code}']
            config = ''
            if token is not None:
                escaped = token.replace('\\', '\\\\').replace('"', '\\"')
                config = f'header = "X-Figma-Token: {escaped}"\n'
                argv += ['--config', '-']
            else:
                argv += ['--location', '--max-redirs', '5', '--proto-redir', '=https']
            argv += ['--url', url]
            try:
                result = subprocess.run(argv, input=config, capture_output=True, text=True,
                                        timeout=40, check=False)
                if result.returncode:
                    raise OpsError('network_error', 'HTTPS request failed.')
                try:
                    status = int(result.stdout.strip())
                except (TypeError, ValueError):
                    raise OpsError('invalid_response', 'HTTP status was not available.') from None
                retry_after = None
                if headers_path.exists():
                    for line in headers_path.read_text(errors='replace').splitlines():
                        if line.lower().startswith('retry-after:'):
                            value = line.split(':', 1)[1].strip()
                            # Only return HTTP Retry-After grammar, never arbitrary echoed content.
                            if re.fullmatch(r'\d+|[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT', value):
                                retry_after = value
                if status < 200 or status >= 300:
                    raise _http_error(status, retry_after)
                return body_path.read_bytes()
            except (OSError, subprocess.SubprocessError):
                raise OpsError('network_error', 'HTTPS request could not be completed.') from None

    def get_json(self, path: str, params: dict | None = None) -> ApiResponse:
        try:
            parsed = urlsplit(path)
        except ValueError:
            raise OpsError('invalid_argument', 'Only relative Figma API paths are accepted.') from None
        relative = path.lstrip('/')
        if (not relative or path.startswith('//') or parsed.scheme or parsed.netloc
                or parsed.query or parsed.fragment or any(ord(char) < 33 for char in path)
                or any(unquote(part) in ('.', '..') for part in relative.split('/'))):
            raise OpsError('invalid_argument', 'Only relative Figma API paths are accepted.')
        query = urlencode(sorted((params or {}).items()), doseq=True)
        url = API_ORIGIN + relative + ('?' + query if query else '')
        token = self._credentials()
        identity = hashlib.sha256(token.encode()).hexdigest()
        cache_key = hashlib.sha256((identity + '\n' + url).encode()).hexdigest()
        cache_path = self.cache_dir / (cache_key + '.json')
        if not self.no_cache and not self.refresh:
            try:
                os.chmod(self.cache_dir, 0o700)
                os.chmod(cache_path, 0o600)
                entry = json.loads(cache_path.read_text(), parse_constant=_reject_json_constant)
                age = time.time() - entry['stored_at']
                fetched = datetime.fromisoformat(entry['fetched_at'].replace('Z', '+00:00'))
                if (isinstance(entry['stored_at'], (int, float)) and math.isfinite(age)
                        and 0 <= age < CACHE_TTL and isinstance(entry['payload'], dict)
                        and isinstance(entry['fetched_at'], str)
                        and fetched.utcoffset() is not None
                        and fetched.utcoffset().total_seconds() == 0
                        and abs(fetched.timestamp() - entry['stored_at']) < 1):
                    return ApiResponse(entry['payload'], entry['fetched_at'], 'hit')
            except (OSError, ValueError, TypeError, KeyError, OverflowError, AttributeError):
                pass
        body = self._request(url, token)
        try:
            payload = json.loads(body, parse_constant=_reject_json_constant)
            if not isinstance(payload, dict):
                raise ValueError
        except (ValueError, UnicodeDecodeError):
            raise OpsError('invalid_response', 'Figma API returned an invalid JSON object.') from None
        now = time.time()
        response = ApiResponse(payload, _utc(now), 'bypass' if self.no_cache or self.refresh else 'miss')
        if not self.no_cache:
            try:
                self.cache_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
                os.chmod(self.cache_dir, 0o700)
                atomic_write(cache_path, json.dumps({'stored_at': now, 'fetched_at': response.fetched_at,
                                                    'payload': payload}, ensure_ascii=False).encode())
            except OSError:
                raise OpsError('cache_error', 'Could not write the private response cache.') from None
        return response

    def download(self, url: str) -> bytes:
        try:
            parsed = urlsplit(url)
            if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
                    or any(ord(char) < 33 for char in url)):
                raise ValueError
        except ValueError:
            raise OpsError('invalid_argument', 'Assets require a valid HTTPS URL.') from None
        return self._request(url)


def envelope(operation: str, file_key: str | None, data: object,
             response: ApiResponse | None = None, coverage: dict | None = None,
             warnings: list | None = None, status: str = 'ok', error: dict | None = None,
             version: str | None = None) -> dict:
    return {'schema_version': 1, 'status': status, 'operation': operation, 'source': 'figma-rest',
            'file_key': file_key, 'version': version,
            'fetched_at': response.fetched_at if response else _utc(),
            'cache': response.cache if response else 'bypass', 'coverage': coverage or {},
            'data': data, 'warnings': warnings or [], 'error': error}
