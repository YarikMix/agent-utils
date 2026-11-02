"""Real CLI + curl-boundary tests for verified comment writes."""
from copy import deepcopy
from contextlib import redirect_stdout, redirect_stderr
import importlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from test_core import core, CurlBoundary
from test_comments import discussion, comment
import figma_ops as cli
import figma_ops_session as session

try:
    actions = importlib.import_module('figma_ops_comment_actions')
except ModuleNotFoundError:
    actions = None


def changed(payload, cid, **fields):
    result = deepcopy(payload)
    next(c for c in result['comments'] if c['id'] == cid).update(fields)
    return result


def method(call):
    argv = call[0]
    return argv[argv.index('--request') + 1] if '--request' in argv else 'GET'


class ActionsTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(actions, 'Comment actions are not implemented')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        patch.object(Path, 'home', return_value=self.home).start()
        patch.dict('os.environ', {'FIGMA_TOKEN': 'synthetic-pat'}).start()
        self.addCleanup(patch.stopall)
        session.save_session(session.Session('synthetic-cookie', '123'))
        self.body = self.home / 'body.txt'
        self.body.write_bytes('Правка\nстрока 2\n'.encode())
        self.before = discussion()
        self.after = changed(self.before, '10', resolved_at='2026-11-03T00:00:00Z')
        self.boundary = CurlBoundary()
        self.bodies = []
        def run(argv, **kwargs):
            if '--data-binary' in argv:
                self.bodies.append(json.loads(Path(argv[argv.index('--data-binary') + 1][1:]).read_text()))
            return self.boundary(argv, **kwargs)
        patch('subprocess.run', run).start()

    def responses(self, before=None, after=None, write=(200, {'error': False}, {})):
        self.boundary.responses = [(200, before or self.before, {}), write, (200, after or self.after, {})]

    def invoke(self, command='comment-resolve', cid='10', extra=None, target='Key'):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = cli.main([command, target, '--comment', cid, *(extra or [])])
        self.assertNotIn('synthetic-cookie', out.getvalue() + err.getvalue())
        self.assertNotIn('synthetic-pat', out.getvalue() + err.getvalue())
        return code, json.loads(out.getvalue())

    def test_resolve_verifies_public_readback_and_preserves_pin_and_replies(self):
        self.responses()
        code, result = self.invoke()
        self.assertEqual((code, result['status'], result['file_key']), (0, 'ok', 'Key'))
        self.assertEqual(result['data']['comment_id'], '10')
        self.assertEqual((result['data']['changed'], result['data']['verified']), (True, True))
        self.assertEqual([method(c) for c in self.boundary.calls], ['GET', 'PUT', 'GET'])
        self.assertEqual(self.bodies, [{'resolved_at': 'true'}])
        for argv, options in self.boundary.calls:
            if 'https://www.figma.com/api/file/Key/comments/10' in argv:
                self.assertNotIn('synthetic-pat', options['input'])
            else:
                self.assertNotIn('synthetic-cookie', options['input'])

    def test_unresolve_and_edit_root_or_reply_preserve_exact_unicode(self):
        for command, cid, before, after, body in [
            ('comment-unresolve', '10', self.after, self.before, {'resolved_at': None}),
            ('comment-edit', '10', self.before, changed(self.before, '10', message='Правка\nстрока 2\n'), {'message_meta': [{'t': 'Правка\nстрока 2\n'}]}),
            ('comment-edit', '11', self.before, changed(self.before, '11', message='Правка\nстрока 2\n'), {'message_meta': [{'t': 'Правка\nстрока 2\n'}]})]:
            with self.subTest(command=command, cid=cid):
                self.responses(before, after)
                code, result = self.invoke(command, cid, ['--body-file', str(self.body)] if command == 'comment-edit' else [])
                self.assertEqual((code, result['data']['verified']), (0, True))
                self.assertEqual(self.bodies[-1], body)

    def test_already_requested_state_and_text_are_noops_without_session(self):
        session.clear_session()
        for command, payload, extra in [
            ('comment-resolve', self.after, []), ('comment-unresolve', self.before, []),
            ('comment-edit', changed(self.before, '10', message='Правка\nстрока 2\n'), ['--body-file', str(self.body)])]:
            self.boundary.responses = [(200, payload, {})]
            code, result = self.invoke(command, extra=extra)
            self.assertEqual((code, result['data']['changed'], result['data']['verified']), (0, False, True))
        self.assertEqual([method(c) for c in self.boundary.calls], ['GET'] * 3)

    def test_wrong_file_missing_id_reply_resolve_and_orphan_do_not_write(self):
        for cid, payload, target in [('99', self.before, 'Key'), ('11', self.before, 'Key'),
                                     ('10', {'comments': []}, 'Other'),
                                     ('11', {'comments': [comment('11', '10')]}, 'Key')]:
            self.boundary.responses = [(200, payload, {})]
            code, result = self.invoke(cid=cid, target=target)
            self.assertNotEqual(code, 0)
        self.assertFalse(self.bodies)

    def test_path_injection_and_bad_body_file_do_not_reach_network(self):
        for cid in ('10/20', '10%2F20', '10\n', '10?x=y'):
            code, _ = self.invoke(cid=cid)
            self.assertEqual(code, 2)
        for body in (b'', b'  \n', b'\xff'):
            self.body.write_bytes(body)
            code, _ = self.invoke('comment-edit', extra=['--body-file', str(self.body)])
            self.assertNotEqual(code, 0)
        self.body.unlink()
        code, _ = self.invoke('comment-edit', extra=['--body-file', str(self.body)])
        self.assertNotEqual(code, 0)
        self.assertEqual(self.boundary.calls, [])

    def test_missing_session_and_explicit_http_denials_never_retry(self):
        for status, error in [(401, 'auth_failed'), (403, 'forbidden'), (429, 'rate_limited')]:
            self.boundary.calls.clear()
            self.responses(write=(status, {}, {'Retry-After': '7'}))
            code, result = self.invoke()
            self.assertEqual((code, result['error']['code']), (1, error))
            self.assertEqual([method(c) for c in self.boundary.calls], ['GET', 'PUT'])
            if status == 429:
                self.assertEqual(result['error']['retry_after'], '7')
        session.clear_session()
        self.boundary.calls.clear()
        self.boundary.responses = [(200, self.before, {})]
        code, result = self.invoke()
        self.assertEqual((code, result['error']['code']), (1, 'session_missing'))
        self.assertEqual([method(c) for c in self.boundary.calls], ['GET'])

    def test_unknown_write_never_retries_and_readback_determines_result(self):
        for write in [subprocess.TimeoutExpired(['curl'], 35), (500, {}, {})]:
            for after, expected in [(self.after, 0), (self.before, 1)]:
                self.boundary.calls.clear()
                self.responses(after=after, write=write)
                code, result = self.invoke()
                self.assertEqual(code, expected)
                self.assertEqual([method(c) for c in self.boundary.calls], ['GET', 'PUT', 'GET'])
                if expected:
                    self.assertEqual(result['error']['code'], 'write_unconfirmed')
                    self.assertIsNone(result['data']['changed'])
                else:
                    self.assertTrue(result['warnings'])
        self.responses(write=subprocess.TimeoutExpired(['curl'], 35))
        self.boundary.responses[-1] = (503, {}, {})
        code, result = self.invoke()
        self.assertEqual((code, result['error']['code']), (1, 'write_unconfirmed'))
        self.assertEqual((result['file_key'], result['data']['comment_id']), ('Key', '10'))
        self.assertTrue(result['data']['write_attempted'])

    def test_2xx_missing_or_different_state_is_not_success(self):
        for after in (self.before, changed(self.after, '10', client_meta={'x': 5}), {'comments': []}):
            self.responses(after=after)
            code, result = self.invoke()
            self.assertEqual((code, result['error']['code']), (1, 'write_unconfirmed'))
        missing = deepcopy(self.before)
        for c in missing['comments']:
            c.pop('resolved_at', None)
        self.responses(before=self.after, after=missing)
        code, result = self.invoke('comment-unresolve')
        self.assertEqual((code, result['error']['code']), (1, 'write_unconfirmed'))

    def test_concurrent_reply_does_not_invalidate_success(self):
        after = deepcopy(self.after)
        after['comments'].append(comment('13', '10', 'New reply'))
        self.responses(after=after)
        self.assertEqual(self.invoke()[0], 0)

    def test_duplicate_id_and_missing_state_preflight_do_not_write(self):
        duplicate = deepcopy(self.before)
        duplicate['comments'].append(deepcopy(duplicate['comments'][2]))
        missing = deepcopy(self.before)
        next(c for c in missing['comments'] if c['id'] == '10').pop('resolved_at')
        for payload in (duplicate, missing):
            self.boundary.responses = [(200, payload, {})]
            self.assertNotEqual(self.invoke()[0], 0)
        self.assertFalse(self.bodies)

    def test_old_cache_is_not_used_and_normal_read_sees_new_state(self):
        client = core.Client()
        self.boundary.responses = [(200, self.before, {})]
        client.get_json('files/Key/comments')
        self.responses()
        code, result = self.invoke()
        self.assertEqual(code, 0)
        self.assertEqual(client.get_json('files/Key/comments').payload, self.after)
        self.assertEqual(len(self.boundary.calls), 4)

    def test_no_cache_write_removes_existing_stale_entry_even_after_failed_readback(self):
        client = core.Client()
        self.boundary.responses = [(200, self.before, {})]
        client.get_json('files/Key/comments')
        self.responses()
        self.boundary.responses[-1] = (503, {}, {})
        code, _ = self.invoke(extra=['--no-cache'])
        self.assertEqual(code, 1)
        self.boundary.responses = [(200, self.after, {})]
        self.assertEqual(client.get_json('files/Key/comments').payload, self.after)

    def test_invalidation_failure_stops_before_write(self):
        self.boundary.responses = [(200, self.before, {})]
        with patch.object(core.Client, 'invalidate', side_effect=core.OpsError('cache_error', 'Cannot invalidate')):
            code, result = self.invoke()
        self.assertEqual((code, result['error']['code']), (1, 'cache_error'))
        self.assertFalse(self.bodies)

    def test_output_failure_reports_write_receipt_without_retry(self):
        self.responses()
        with patch.object(cli, 'atomic_write', side_effect=OSError('synthetic-cookie')):
            code, result = self.invoke(extra=['--output', str(self.home / 'receipt.json')])
        self.assertEqual((code, result['error']['code']), (1, 'output_error'))
        self.assertTrue(result['data']['write_attempted'])
        self.assertTrue(result['data']['verified'])
        self.assertEqual(result['file_key'], 'Key')

    def test_output_must_not_overwrite_session_credentials(self):
        code, result = self.invoke(extra=['--output', str(session.session_path())])
        self.assertEqual((code, result['error']['code']), (2, 'invalid_argument'))
        self.assertEqual(session.load_session().cookie, 'synthetic-cookie')
        self.assertEqual(self.boundary.calls, [])

    def test_session_cli_without_pat_and_existing_reads_without_session(self):
        with patch.dict('os.environ', {}, clear=True), redirect_stdout(io.StringIO()) as out:
            code = cli.main(['session-logout'])
        self.assertEqual(code, 0)
        self.assertTrue(json.loads(out.getvalue())['data']['removed'])
        with patch.dict('os.environ', {}, clear=True), \
                patch.object(session.sys.stdin, 'isatty', return_value=True), \
                patch.object(session.getpass, 'getpass', return_value='synthetic-cookie'), \
                patch('builtins.input', return_value='123'), redirect_stdout(io.StringIO()) as out, redirect_stderr(io.StringIO()):
            code = cli.main(['session-login'])
        self.assertEqual(code, 0)
        self.assertFalse(json.loads(out.getvalue())['data']['authenticated'])
        session.clear_session()
        self.boundary.responses = [(200, self.before, {})]
        with redirect_stdout(io.StringIO()) as out:
            code = cli.main(['comments', 'Key', '--no-cache'])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out.getvalue())['data']['threads'][0]['root_id'], '10')

    def test_edit_body_required_and_no_cookie_argument(self):
        for args in (['comment-edit', 'Key', '--comment', '10'], ['session-login', '--cookie', 'synthetic-cookie']):
            with redirect_stdout(io.StringIO()) as out:
                code = cli.main(args)
            self.assertEqual(code, 2)
            self.assertNotIn('synthetic-cookie', out.getvalue())

    def test_malformed_readback_identifiers_keep_uncertain_write_receipt(self):
        for field in ('id', 'parent_id'):
            with self.subTest(field=field):
                after = deepcopy(self.after)
                after['comments'][-1][field] = ['invalid']
                self.responses(after=after, write=subprocess.TimeoutExpired(['curl'], 35))
                code, result = self.invoke()
                self.assertEqual((code, result['error']['code']), (1, 'write_unconfirmed'))
                self.assertEqual((result['file_key'], result['data']['comment_id']), ('Key', '10'))
                self.assertTrue(result['data']['write_attempted'])
                self.assertIsNone(result['data']['changed'])
