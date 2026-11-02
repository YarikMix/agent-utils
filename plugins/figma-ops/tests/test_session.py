"""Local session boundary: temporary homes and synthetic credentials only."""
import importlib
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
import warnings
from unittest.mock import patch

from test_core import core, CurlBoundary

try:
    session = importlib.import_module('figma_ops_session')
except ModuleNotFoundError:
    session = None


class SessionTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(session, 'Session support is not implemented')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.path = self.home / '.config/figma-ops/session.json'
        patch.object(Path, 'home', return_value=self.home).start()
        self.addCleanup(patch.stopall)
        self.secret = session.Session('synthetic-cookie', '123')

    def test_roundtrip_private_storage_and_logout(self):
        session.save_session(self.secret)
        self.assertEqual(session.load_session(), self.secret)
        self.assertNotIn('synthetic-cookie', repr(session.load_session()))
        if os.name == 'posix':
            self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(self.path.parent.stat().st_mode), 0o700)
        self.assertTrue(session.clear_session())
        self.assertFalse(session.clear_session())

    def test_missing_malformed_and_invalid_credentials_are_safe(self):
        with self.assertRaises(core.OpsError) as caught:
            session.load_session()
        self.assertEqual(caught.exception.code, 'session_missing')
        self.path.parent.mkdir(parents=True, mode=0o700)
        for value in ('bad synthetic-cookie', '[]', '{"cookie":"synthetic-cookie"}'):
            self.path.write_text(value)
            self.path.chmod(0o600)
            with self.assertRaises(core.OpsError) as caught:
                session.load_session()
            self.assertNotIn('synthetic-cookie', str(caught.exception))
        for cookie, uid in [('', '123'), ('x\r\ny', '123'), ('x;y', '123'), ('x', '1\n2'), ('x', 'abc')]:
            with self.subTest(cookie=cookie, uid=uid), self.assertRaises(core.OpsError):
                session.save_session(session.Session(cookie, uid))

    def test_failed_save_preserves_existing_credentials(self):
        session.save_session(self.secret)
        with patch('figma_ops_core.os.replace', side_effect=OSError('synthetic-cookie')):
            with self.assertRaises(core.OpsError) as caught:
                session.save_session(session.Session('replacement', '123'))
        self.assertNotIn('synthetic-cookie', str(caught.exception))
        self.assertEqual(session.load_session(), self.secret)

    def test_rejects_symlinked_storage_without_touching_target(self):
        target = self.home / 'other.json'
        target.write_text('untouched')
        self.path.parent.mkdir(parents=True, mode=0o700)
        self.path.symlink_to(target)
        for action in (session.load_session, lambda: session.save_session(self.secret), session.clear_session):
            with self.assertRaises(core.OpsError):
                action()
        self.assertEqual(target.read_text(), 'untouched')
        self.path.unlink()
        self.path.parent.rmdir()
        self.path.parent.symlink_to(self.home, target_is_directory=True)
        with self.assertRaises(core.OpsError):
            session.save_session(self.secret)

    @unittest.skipUnless(os.name == 'posix', 'POSIX modes')
    def test_rejects_insecure_file_or_directory(self):
        session.save_session(self.secret)
        for path in (self.path, self.path.parent):
            previous = stat.S_IMODE(path.stat().st_mode)
            path.chmod(0o777)
            with self.assertRaises(core.OpsError):
                session.load_session()
            path.chmod(previous)

    def test_login_hides_cookie_and_does_not_claim_authentication(self):
        with patch.object(session.sys.stdin, 'isatty', return_value=True), \
                patch.object(session.getpass, 'getpass', return_value='synthetic-cookie'), \
                patch('builtins.input', return_value='123'):
            result = session.session_login(None, None)
        self.assertEqual(result['data'], {'stored': True, 'authenticated': False})
        self.assertNotIn('synthetic-cookie', json.dumps(result))
        self.assertEqual(session.load_session(), self.secret)
        self.assertTrue(session.session_logout(None, None)['data']['removed'])

    def test_login_rejects_noninteractive_echo_fallback_and_cancellation(self):
        with patch.object(session.sys.stdin, 'isatty', return_value=False):
            with self.assertRaises(core.OpsError):
                session.session_login(None, None)
        def fallback(*args, **kwargs):
            warnings.warn('Cannot hide input', session.getpass.GetPassWarning)
        for effect in (fallback, EOFError(), KeyboardInterrupt()):
            with patch.object(session.sys.stdin, 'isatty', return_value=True), \
                    patch.object(session.getpass, 'getpass', side_effect=effect):
                with self.assertRaises(core.OpsError):
                    session.session_login(None, None)
        self.assertFalse(self.path.exists())


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(hasattr(session, 'put_comment'), 'Comment PUT transport is not implemented')
        self.secret = session.Session('synthetic-cookie', '123')

    def test_put_has_exact_payload_fixed_origin_and_no_secret_in_argv(self):
        boundary = CurlBoundary([(200, {'error': False}, {})])
        bodies = []
        def run(argv, **kwargs):
            bodies.append(json.loads(Path(argv[argv.index('--data-binary') + 1][1:]).read_text()))
            return boundary(argv, **kwargs)
        with patch('subprocess.run', run):
            session.put_comment('Key', '10', {'resolved_at': 'true'}, self.secret)
        argv, options = boundary.calls[0]
        self.assertEqual(bodies, [{'resolved_at': 'true'}])
        self.assertEqual(argv[argv.index('--request') + 1], 'PUT')
        self.assertEqual(argv[argv.index('--url') + 1], 'https://www.figma.com/api/file/Key/comments/10')
        self.assertIn('Cookie: __Host-figma.authn=synthetic-cookie', options['input'])
        self.assertIn('X-Figma-User-Id: 123', options['input'])
        self.assertNotIn('synthetic-cookie', ' '.join(argv))
        self.assertNotIn('X-Figma-Token', options['input'])
        for option in ('--location', '-L', '-k', '--insecure', '--retry'):
            self.assertNotIn(option, argv)

    def test_cookie_quotes_are_escaped_in_curl_config(self):
        boundary = CurlBoundary()
        with patch('subprocess.run', boundary):
            session.put_comment('Key', '10', {'resolved_at': None}, session.Session('a"b\\c', '123'))
        self.assertIn('a\\"b\\\\c', boundary.calls[0][1]['input'])

    def test_rejects_escaping_paths_and_unsupported_payload_before_network(self):
        boundary = CurlBoundary()
        cases = [('Key/Other', '10', {'resolved_at': None}), ('Key', '10%2F20', {'resolved_at': None}),
                 ('Key', '10\n', {'resolved_at': None}), ('Key', '10', {'resolved_at': True}),
                 ('Key', '10', {'message': 'x'}), ('Key', '10', {'message_meta': [{'t': ''}]}),
                 ('Key', '10', {'resolved_at': None, 'delete': True})]
        with patch('subprocess.run', boundary):
            for key, cid, body in cases:
                with self.subTest(key=key, cid=cid), self.assertRaises(core.OpsError):
                    session.put_comment(key, cid, body, self.secret)
        self.assertEqual(boundary.calls, [])

    def test_http_errors_never_retry_or_echo_response(self):
        for status, code in [(302, 'invalid_response'), (401, 'auth_failed'), (403, 'forbidden'),
                             (429, 'rate_limited'), (500, 'network_error')]:
            boundary = CurlBoundary([(status, b'synthetic-cookie', {'Retry-After': '5'})])
            with self.subTest(status=status), patch('subprocess.run', boundary):
                with self.assertRaises(core.OpsError) as caught:
                    session.put_comment('Key', '10', {'resolved_at': 'true'}, self.secret)
                self.assertEqual(caught.exception.code, code)
                self.assertNotIn('synthetic-cookie', str(caught.exception))
                if status == 429:
                    self.assertEqual(caught.exception.retry_after, '5')
            self.assertEqual(len(boundary.calls), 1)

    def test_timeout_nonzero_and_internal_errors_are_safe(self):
        cases = [subprocess.TimeoutExpired(['curl'], 35, stderr='synthetic-cookie'),
                 OSError('synthetic-cookie'), (200, {'error': True, 'message': 'synthetic-cookie'}, {}),
                 (200, b'<html>synthetic-cookie</html>', {})]
        for response in cases:
            with self.subTest(response=type(response).__name__), patch('subprocess.run', CurlBoundary([response])):
                with self.assertRaises(core.OpsError) as caught:
                    session.put_comment('Key', '10', {'resolved_at': None}, self.secret)
                self.assertNotIn('synthetic-cookie', str(caught.exception))
        with patch('subprocess.run', return_value=subprocess.CompletedProcess([], 60, '', 'synthetic-cookie')):
            with self.assertRaises(core.OpsError) as caught:
                session.put_comment('Key', '10', {'resolved_at': None}, self.secret)
            self.assertEqual(caught.exception.code, 'network_error')
