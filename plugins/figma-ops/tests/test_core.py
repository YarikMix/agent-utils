"""Synthetic REST-boundary tests: never execute real curl or Keychain."""
import importlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
try:
    core = importlib.import_module('figma_ops_core')
except ModuleNotFoundError:
    core = None


class CurlBoundary:
    """Write response files as curl would; collect outgoing request arguments."""
    def __init__(self, responses=None):
        self.responses = list(responses or [(200, {'id': 'synthetic-user'}, {})])
        self.calls = []

    def __call__(self, argv, **kwargs):
        self.calls.append((argv, kwargs))
        if not self.responses:
            raise AssertionError('Unexpected extra transport request')
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        status, body, headers = response
        if not isinstance(body, bytes):
            body = json.dumps(body).encode()
        Path(argv[argv.index('--output') + 1]).write_bytes(body)
        header_text = 'HTTP/2 ' + str(status) + '\r\n'
        header_text += ''.join(f'{key}: {value}\r\n' for key, value in headers.items())
        Path(argv[argv.index('--dump-header') + 1]).write_text(header_text + '\r\n')
        return subprocess.CompletedProcess(argv, 0, str(status), '')


class CoreTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(core, 'REST core is not implemented')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.cache = Path(self.temp.name) / 'cache'
        self.boundary = CurlBoundary()
        self.run = patch('subprocess.run', self.boundary).start()
        self.addCleanup(patch.stopall)

    def client(self, token='synthetic-secret', **kwargs):
        return core.Client(token=token, cache_dir=self.cache, **kwargs)

    def test_branch_url_selects_branch_key_and_normalizes_node(self):
        self.assertEqual(core.parse_target('https://www.figma.com/design/Main/branch/BranchKey/Example?node-id=12-34'), core.Target('BranchKey', '12:34'))

    def test_supported_urls_and_raw_key(self):
        for kind in ('design', 'file', 'proto'):
            self.assertEqual(core.parse_target(f'https://figma.com/{kind}/Key/Name'), core.Target('Key', None))
        self.assertEqual(core.parse_target('Key'), core.Target('Key', None))

    def test_instance_id_is_preserved_and_explicit_node_wins(self):
        self.assertEqual(core.parse_target('https://figma.com/file/Key/Name?node-id=I12%3A34%3B56%3A78').node_id, 'I12:34;56:78')
        self.assertEqual(core.parse_target('https://figma.com/file/Key/Name?node-id=1-2', '3-4').node_id, '3:4')

    def test_rejects_invalid_target_without_transport(self):
        for value in ('https://evil.example/design/Key/X', 'http://figma.com/file/Key/X', 'https://figma.com.evil/file/Key/X', 'https://figma.com/file/Key/X?node-id=', 'https://figma.com/file/Key/branch/', 'https://user@figma.com/file/Key/X', '../bad', ''):
            with self.subTest(value=value), self.assertRaises(core.OpsError) as caught:
                core.parse_target(value)
            self.assertEqual(caught.exception.code, 'invalid_argument')
        self.assertEqual(self.boundary.calls, [])

    def test_empty_explicit_node_is_rejected(self):
        with self.assertRaises(core.OpsError):
            core.parse_target('Key', '')

    def test_credentials_are_lazy(self):
        with patch.object(core, 'resolve_token', side_effect=AssertionError('must stay lazy')):
            core.Client(cache_dir=self.cache)

    def test_environment_token_precedes_keychain(self):
        with patch.dict(os.environ, {'FIGMA_TOKEN': 'synthetic-env'}):
            self.assertEqual(core.resolve_token(), ('synthetic-env', 'FIGMA_TOKEN'))
        self.assertEqual(self.boundary.calls, [])

    def test_missing_credentials_is_safe(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(core.sys, 'platform', 'linux'):
            with self.assertRaises(core.OpsError) as caught:
                core.resolve_token()
        self.assertEqual(caught.exception.code, 'credential_missing')

    def test_keychain_uses_only_approved_service(self):
        def keychain(argv, **kwargs):
            self.assertEqual(argv, ['security', 'find-generic-password', '-s', 'figma-rest', '-a', 'figma', '-w'])
            return subprocess.CompletedProcess(argv, 0, 'synthetic-keychain\n', '')
        with patch.dict(os.environ, {}, clear=True), patch.object(core.sys, 'platform', 'darwin'), patch('subprocess.run', keychain):
            self.assertEqual(core.resolve_token(), ('synthetic-keychain', 'Keychain'))

    def test_authenticated_request_uses_stdin_and_fixed_https_origin(self):
        result = self.client().get_json('/me', {'version': 'v 1'})
        self.assertEqual(result.payload, {'id': 'synthetic-user'})
        argv, options = self.boundary.calls[0]
        self.assertEqual(argv[0:2], ['curl', '-q'])
        self.assertIn('https://api.figma.com/v1/me?version=v+1', argv)
        self.assertNotIn('synthetic-secret', ' '.join(argv))
        self.assertIn('X-Figma-Token: synthetic-secret', options['input'])
        self.assertNotIn('-k', argv)
        self.assertNotIn('-L', argv)
        self.assertNotIn('--location', argv)
        self.assertIn('35', argv)

    def test_absolute_and_escaping_api_paths_rejected(self):
        for path in ('https://evil.example/me', '//evil.example/me', '../me', '/me?token=bad', 'me#fragment', 'https://[bad'):
            with self.subTest(path=path), self.assertRaises(core.OpsError):
                self.client().get_json(path)
        self.assertEqual(self.boundary.calls, [])

    def test_http_errors_are_classified_without_response_body(self):
        cases = [(401, 'auth_failed'), (403, 'forbidden'), (404, 'not_found_or_inaccessible'), (429, 'rate_limited'), (500, 'network_error'), (302, 'invalid_response')]
        self.boundary.responses = [(status, b'synthetic-secret echoed HTML', {'Retry-After': '7'}) for status, _ in cases]
        for status, code in cases:
            with self.subTest(status=status), self.assertRaises(core.OpsError) as caught:
                self.client(no_cache=True).get_json('me')
            error = caught.exception
            self.assertEqual(error.code, code)
            self.assertEqual(error.http_status, status)
            self.assertNotIn('synthetic-secret', str(error))
            if status == 429:
                self.assertEqual(error.retry_after, '7')
        self.assertFalse(self.cache.exists())

    def test_invalid_json_and_non_object_payload(self):
        self.boundary.responses = [(200, b'<html>synthetic-secret</html>', {}), (200, [], {})]
        for _ in range(2):
            with self.assertRaises(core.OpsError) as caught:
                self.client(no_cache=True).get_json('me')
            self.assertEqual(caught.exception.code, 'invalid_response')
            self.assertNotIn('synthetic-secret', str(caught.exception))

    def test_nonfinite_json_numbers_are_invalid_response(self):
        self.boundary.responses = [(200, b'{"number": NaN}', {})]
        with self.assertRaises(core.OpsError) as caught:
            self.client(no_cache=True).get_json('me')
        self.assertEqual(caught.exception.code, 'invalid_response')

    def test_exponent_overflow_in_nested_json_is_invalid_and_not_cached(self):
        for number in ('1e999', '-1e999'):
            self.boundary.responses = [(200, ('{"nested": [{"number": ' + number + '}]}').encode(), {})]
            with self.subTest(number=number):
                with self.assertRaises(core.OpsError) as caught:
                    self.client().get_json('me')
                self.assertEqual(caught.exception.code, 'invalid_response')
                self.assertFalse(self.cache.exists())

    def test_exponent_overflow_in_cached_payload_refetches(self):
        self.boundary.responses = [(200, {'number': 1}, {}), (200, {'number': 2}, {})]
        self.client().get_json('me')
        cache_file = next(self.cache.glob('*.json'))
        cache_file.write_text(cache_file.read_text().replace('"number": 1', '"number": 1e999'))
        result = self.client().get_json('me')
        self.assertEqual((result.cache, result.payload['number']), ('miss', 2))

    def test_large_finite_json_float_is_supported(self):
        self.boundary.responses = [(200, b'{"number": 1e308}', {})]
        result = self.client(no_cache=True).get_json('me')
        self.assertEqual(result.payload['number'], 1e308)

    def test_network_failures_are_redacted(self):
        self.boundary.responses = [subprocess.TimeoutExpired(['curl'], 35, stderr='synthetic-secret'), OSError('synthetic-secret')]
        for _ in range(2):
            with self.assertRaises(core.OpsError) as caught:
                self.client().get_json('me')
            self.assertEqual(caught.exception.code, 'network_error')
            self.assertNotIn('synthetic-secret', str(caught.exception))

    def test_curl_nonzero_exit_does_not_echo_stderr(self):
        with patch('subprocess.run', return_value=subprocess.CompletedProcess([], 60, '', 'synthetic-secret')):
            with self.assertRaises(core.OpsError) as caught:
                self.client().get_json('me')
        self.assertEqual(caught.exception.code, 'network_error')
        self.assertNotIn('synthetic-secret', str(caught.exception))

    def test_asset_download_has_no_auth_and_https_redirect_policy(self):
        self.boundary.responses = [(200, b'asset bytes', {})]
        with patch.object(core, 'resolve_token', side_effect=AssertionError('download needs no credentials')):
            self.assertEqual(core.Client().download('https://assets.example/image'), b'asset bytes')
        argv, options = self.boundary.calls[0]
        self.assertNotIn('X-Figma-Token', options.get('input', ''))
        self.assertIn('--location', argv)
        self.assertEqual(argv[argv.index('--proto-redir') + 1], '=https')

    def test_asset_rejects_http_before_transport(self):
        with self.assertRaises(core.OpsError):
            self.client().download('http://assets.example/image')
        self.assertEqual(self.boundary.calls, [])

    def test_cache_hit_preserves_timestamp_and_private_permissions(self):
        first = self.client().get_json('me')
        second = self.client().get_json('me')
        self.assertEqual((first.cache, second.cache), ('miss', 'hit'))
        self.assertEqual(first.fetched_at, second.fetched_at)
        self.assertEqual(len(self.boundary.calls), 1)
        self.assertEqual(stat.S_IMODE(self.cache.stat().st_mode), 0o700)
        entries = list(self.cache.glob('*.json'))
        self.assertEqual(len(entries), 1)
        self.assertEqual(stat.S_IMODE(entries[0].stat().st_mode), 0o600)
        self.assertNotIn('synthetic-secret', entries[0].read_text())

    def test_cache_hit_restores_private_permissions(self):
        self.client().get_json('me')
        cache_file = next(self.cache.glob('*.json'))
        self.cache.chmod(0o755)
        cache_file.chmod(0o644)
        self.assertEqual(self.client().get_json('me').cache, 'hit')
        self.assertEqual(stat.S_IMODE(self.cache.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(cache_file.stat().st_mode), 0o600)

    def test_corrupted_cache_timestamp_refetches(self):
        self.boundary.responses = [(200, {'id': 'old'}, {}), (200, {'id': 'new'}, {})]
        self.client().get_json('me')
        cache_file = next(self.cache.glob('*.json'))
        data = json.loads(cache_file.read_text())
        data['fetched_at'] = '2000-01-01T00:00:00+03:00'
        cache_file.write_text(json.dumps(data))
        self.assertEqual(self.client().get_json('me').payload['id'], 'new')

    def test_header_control_injection_rejected_without_transport(self):
        with self.assertRaises(core.OpsError):
            self.client('unsafe\nX-Figma-Token: other').get_json('me')
        self.assertEqual(self.boundary.calls, [])

    def test_failure_is_not_cached(self):
        self.boundary.responses = [(403, {}, {}), (200, {'id': 'recovered'}, {})]
        with self.assertRaises(core.OpsError):
            self.client().get_json('me')
        self.assertEqual(self.client().get_json('me').payload['id'], 'recovered')
        self.assertEqual(len(self.boundary.calls), 2)

    def test_invalid_http_status_is_safe(self):
        with patch('subprocess.run', return_value=subprocess.CompletedProcess([], 0, 'synthetic-secret', '')):
            with self.assertRaises(core.OpsError) as caught:
                self.client(no_cache=True).get_json('me')
        self.assertEqual(caught.exception.code, 'invalid_response')
        self.assertNotIn('synthetic-secret', str(caught.exception))

    def test_cache_isolates_explicit_token_identity_and_query(self):
        self.boundary.responses = [(200, {'id': value}, {}) for value in ('a', 'b', 'version')]
        self.assertEqual(self.client('token-a').get_json('me').payload['id'], 'a')
        self.assertEqual(self.client('token-b').get_json('me').payload['id'], 'b')
        self.assertEqual(self.client('token-a').get_json('me', {'version': '2'}).payload['id'], 'version')
        self.assertEqual(self.client('token-a').get_json('me').payload['id'], 'a')

    def test_cache_expiry_refetches(self):
        now = time.time()
        self.boundary.responses = [(200, {'id': 'old'}, {}), (200, {'id': 'new'}, {})]
        with patch('time.time', return_value=now):
            self.client().get_json('me')
        with patch('time.time', return_value=now + 301):
            result = self.client().get_json('me')
        self.assertEqual((result.cache, result.payload['id']), ('miss', 'new'))

    def test_corrupted_cache_refetches(self):
        self.boundary.responses = [(200, {'id': 'old'}, {}), (200, {'id': 'new'}, {})]
        self.client().get_json('me')
        next(self.cache.glob('*.json')).write_text('not JSON')
        self.assertEqual(self.client().get_json('me').payload['id'], 'new')

    def test_expired_cache_error_never_returns_stale(self):
        now = time.time()
        self.boundary.responses = [(200, {'id': 'old'}, {}), (403, {}, {})]
        with patch('time.time', return_value=now):
            self.client().get_json('me')
        with patch('time.time', return_value=now + 301), self.assertRaises(core.OpsError):
            self.client().get_json('me')

    def test_no_cache_never_reads_or_writes(self):
        self.assertEqual(self.client(no_cache=True).get_json('me').cache, 'bypass')
        self.assertFalse(self.cache.exists())

    def test_refresh_fetches_and_replaces_cache(self):
        self.boundary.responses = [(200, {'id': 'old'}, {}), (200, {'id': 'new'}, {})]
        self.client().get_json('me')
        self.assertEqual(self.client(refresh=True).get_json('me').cache, 'bypass')
        self.assertEqual(self.client().get_json('me').payload['id'], 'new')

    def test_envelope_provenance_and_error_fields(self):
        response = core.ApiResponse({'id': 'x'}, '2026-10-22T10:00:00Z', 'hit')
        result = core.envelope('inspect', 'Key', {'id': 'x'}, response=response, coverage={'scope': 'node'}, version='v2')
        self.assertEqual(set(result), {'schema_version', 'status', 'operation', 'source', 'file_key', 'version', 'fetched_at', 'cache', 'coverage', 'data', 'warnings', 'error'})
        self.assertEqual((result['schema_version'], result['source'], result['fetched_at'], result['cache']), (1, 'figma-rest', '2026-10-22T10:00:00Z', 'hit'))
        self.assertEqual((result['version'], result['coverage'], result['warnings'], result['error']), ('v2', {'scope': 'node'}, [], None))
