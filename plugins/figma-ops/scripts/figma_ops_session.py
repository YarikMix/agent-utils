"""Explicit local web session for the three supported comment mutations."""
from dataclasses import dataclass, field
import getpass
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import warnings

from figma_ops_core import OpsError, _http_error, atomic_write, envelope, serialize_json


@dataclass(frozen=True)
class Session:
    cookie: str = field(repr=False)
    user_id: str


def session_path() -> Path:
    return Path.home() / '.config' / 'figma-ops' / 'session.json'


def _validate(session: Session) -> None:
    if (not isinstance(session.cookie, str) or not session.cookie
            or any(ord(c) < 33 or ord(c) > 126 or c == ';' for c in session.cookie)
            or not isinstance(session.user_id, str) or not re.fullmatch(r'[0-9]+', session.user_id)):
        raise OpsError('session_invalid', 'A valid Figma web cookie and numeric user ID are required.')


def _check_storage(path: Path) -> None:
    for candidate in (path.parent.parent, path.parent, path):
        if candidate.is_symlink():
            raise OpsError('session_unsafe', 'Session storage must not use symbolic links.')
    for candidate in (path.parent, path):
        if candidate.exists():
            info = candidate.stat()
            expected = stat.S_ISREG if candidate == path else stat.S_ISDIR
            if not expected(info.st_mode) or (os.name == 'posix' and
                    (info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077)):
                raise OpsError('session_unsafe', 'Session storage must be private and owned by this user.')


def save_session(session: Session) -> None:
    _validate(session)
    path = session_path()
    try:
        _check_storage(path)
        path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
        atomic_write(path, serialize_json({'cookie': session.cookie, 'user_id': session.user_id}).encode())
    except OSError:
        raise OpsError('session_storage_error', 'Could not save the local Figma session.') from None


def load_session() -> Session:
    path = session_path()
    try:
        _check_storage(path)
        fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
        with os.fdopen(fd, 'r', encoding='utf-8') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or (os.name == 'posix' and
                    (info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077)):
                raise OpsError('session_unsafe', 'Session file must be private and owned by this user.')
            data = json.load(stream)
        value = Session(data['cookie'], data['user_id'])
        _validate(value)
        return value
    except FileNotFoundError:
        raise OpsError('session_missing', 'Run session-login locally to configure a Figma web session.') from None
    except (ValueError, TypeError, KeyError, UnicodeError):
        raise OpsError('session_invalid', 'Invalid local Figma session; run session-login again.') from None
    except OSError:
        raise OpsError('session_storage_error', 'Could not read the local Figma session.') from None


def clear_session() -> bool:
    path = session_path()
    try:
        _check_storage(path)
        if not path.exists():
            return False
        path.unlink()
        return True
    except OSError:
        raise OpsError('session_storage_error', 'Could not remove the local Figma session.') from None


def session_login(args, client) -> dict:
    if not sys.stdin.isatty():
        raise OpsError('interactive_required', 'Run session-login in an interactive terminal; do not pass secrets in arguments.')
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', getpass.GetPassWarning)
            cookie = getpass.getpass('Figma __Host-figma.authn (hidden): ')
        print('Figma user ID: ', end='', file=sys.stderr, flush=True)
        user_id = input().strip()
        save_session(Session(cookie, user_id))
    except (EOFError, KeyboardInterrupt, getpass.GetPassWarning):
        raise OpsError('session_input_cancelled', 'Session setup cancelled or hidden input unavailable; nothing saved.') from None
    result = envelope('session-login', None, {'stored': True, 'authenticated': False})
    result['source'] = 'local-session'
    return result


def session_logout(args, client) -> dict:
    result = envelope('session-logout', None, {'removed': clear_session()})
    result['source'] = 'local-session'
    return result


def validate_comment_target(file_key: str, comment_id: str) -> None:
    if (not re.fullmatch(r'[A-Za-z0-9_-]+', file_key)
            or not re.fullmatch(r'[0-9]+', comment_id)):
        raise OpsError('invalid_argument', 'Expected a Figma file key and numeric comment ID.')


def put_comment(file_key: str, comment_id: str, payload: dict, session: Session) -> None:
    """One internal request; callers must verify the mutation through public REST.

    Protocol reference: github.com/dannykeane/figmanage/src/operations/comments.ts.
    """
    validate_comment_target(file_key, comment_id)
    _validate(session)
    resolve = set(payload) == {'resolved_at'} and (payload['resolved_at'] is None or payload['resolved_at'] == 'true')
    parts = payload.get('message_meta')
    edit = (set(payload) == {'message_meta'} and isinstance(parts, list) and len(parts) == 1
            and isinstance(parts[0], dict) and set(parts[0]) == {'t'}
            and isinstance(parts[0]['t'], str) and bool(parts[0]['t'].strip()))
    if not (resolve or edit):
        raise OpsError('invalid_argument', 'Only comment resolve, unresolve and plain-text edit are supported.')
    headers = {'Cookie': '__Host-figma.authn=' + session.cookie, 'X-Figma-User-Id': session.user_id,
               'X-CSRF-Bypass': 'yes', 'Content-Type': 'application/json', 'Accept': 'application/json'}
    config = ''.join('header = "' + (key + ': ' + value).replace('\\', '\\\\').replace('"', '\\"') + '"\n'
                     for key, value in headers.items())
    try:
        with tempfile.TemporaryDirectory(prefix='figma-comment-') as directory:
            body, response, response_headers = (Path(directory) / name for name in ('body', 'response', 'headers'))
            atomic_write(body, serialize_json(payload).encode())
            argv = ['curl', '-q', '--silent', '--show-error', '--max-time', '35', '--proto', '=https',
                    '--globoff', '--config', '-', '--request', 'PUT', '--data-binary', '@' + str(body),
                    '--output', str(response), '--dump-header', str(response_headers), '--write-out', '%{http_code}',
                    '--url', f'https://www.figma.com/api/file/{file_key}/comments/{comment_id}']
            result = subprocess.run(argv, input=config, capture_output=True, text=True, timeout=40, check=False)
            if result.returncode:
                raise OpsError('network_error', 'Comment write response was not received; verify state before retrying.')
            try:
                status = int(result.stdout.strip())
            except ValueError:
                raise OpsError('invalid_response', 'Comment write HTTP status was unavailable.') from None
            retry_after = None
            for line in response_headers.read_text(errors='replace').splitlines():
                if line.lower().startswith('retry-after:'):
                    value = line.split(':', 1)[1].strip()
                    if re.fullmatch(r'\d+|[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT', value):
                        retry_after = value
            if not 200 <= status < 300:
                raise _http_error(status, retry_after)
            raw = response.read_bytes()
            if raw.strip():
                try:
                    result_body = json.loads(raw)
                except (ValueError, UnicodeError):
                    raise OpsError('invalid_response', 'Comment write response was not valid JSON.') from None
                if not isinstance(result_body, dict) or result_body.get('error'):
                    raise OpsError('invalid_response', 'Figma did not confirm the comment write response.')
    except (OSError, subprocess.SubprocessError):
        raise OpsError('network_error', 'Comment write response was not received; verify state before retrying.') from None
