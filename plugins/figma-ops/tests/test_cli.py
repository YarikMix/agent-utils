"""CLI integration against fake subprocess boundary, without live secrets."""
from contextlib import redirect_stderr, redirect_stdout
import importlib
import io
import json
import os
from pathlib import Path
import runpy
import sys
import tempfile
import unittest
from unittest.mock import patch

from test_core import CurlBoundary, SCRIPTS

try:
    cli = importlib.import_module('figma_ops')
except ModuleNotFoundError:
    cli = None


class CliTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(cli, 'CLI is not implemented')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.boundary = CurlBoundary()
        patch('subprocess.run', self.boundary).start()
        patch.dict(os.environ, {'FIGMA_TOKEN': 'synthetic-secret'}).start()
        self.addCleanup(patch.stopall)

    def invoke(self, args):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = cli.main(args)
        self.assertNotIn('synthetic-secret', out.getvalue() + err.getvalue())
        return code, json.loads(out.getvalue()), err.getvalue()

    def test_doctor_declares_endpoint_only_probe(self):
        code, result, _ = self.invoke(['doctor', '--no-cache'])
        self.assertEqual(code, 0)
        self.assertEqual(result['operation'], 'doctor')
        self.assertEqual(result['data']['identity']['id'], 'synthetic-user')
        self.assertEqual(result['data']['credential_source'], 'FIGMA_TOKEN')
        self.assertEqual(result['coverage'], {'endpoint': '/me', 'scopes_checked': False, 'mcp_checked': False})

    def test_mixed_svg_encoding_errors_emit_partial_json_and_save_second_asset(self):
        for encoding in ('UTF-32', 'Shift_JIS', 'UTF-7'):
            with self.subTest(encoding=encoding):
                destination = Path(self.temp.name) / encoding
                self.boundary.responses = [
                    (200, {'images': {'1:2': 'https://assets.example/bad', '2:3': 'https://assets.example/good'}}, {}),
                    (200, ('<?xml version="1.0" encoding="' + encoding + '"?><svg/>').encode(), {}),
                    (200, b'<svg/>', {})]
                code, result, error = self.invoke(['export', 'Synthetic', '--node', '1:2', '--node', '2:3',
                                                 '--format', 'svg', '--dest', str(destination), '--no-cache'])
                self.assertEqual((code, result['status'], error), (0, 'partial', ''))
                self.assertEqual(tuple(result['coverage'][key] for key in ('requested', 'succeeded', 'failed')), (2, 1, 1))
                bad, good = result['data']['files']
                self.assertEqual((bad['node_id'], bad['error']['code']), ('1:2', 'invalid_asset'))
                self.assertEqual((good['node_id'], good['status']), ('2:3', 'ok'))
                self.assertEqual(Path(good['path']).read_bytes(), b'<svg/>')
                self.assertEqual(len(list(destination.iterdir())), 1)

    def test_common_flags_after_command_and_atomic_output(self):
        output = Path(self.temp.name) / 'report.json'
        code, compact, _ = self.invoke(['doctor', '--refresh', '--cache-dir', str(Path(self.temp.name) / 'cache'), '--output', str(output)])
        self.assertEqual(code, 0)
        full = json.loads(output.read_text())
        self.assertEqual(compact['data'], {'artifact': str(output.resolve()), 'bytes': output.stat().st_size})
        self.assertEqual(full['data']['identity']['id'], 'synthetic-user')
        for field in ('status', 'coverage', 'fetched_at', 'cache', 'operation', 'warnings'):
            self.assertEqual(compact[field], full[field])
        self.assertEqual(list(Path(self.temp.name).glob('*.tmp')), [])

    def test_operational_errors_have_safe_envelope(self):
        self.boundary.responses = [(429, b'synthetic-secret', {'Retry-After': '9'})]
        code, result, _ = self.invoke(['doctor', '--no-cache'])
        self.assertEqual(code, 1)
        self.assertEqual(result['status'], 'error')
        self.assertEqual(result['error']['code'], 'rate_limited')
        self.assertEqual(result['error']['http_status'], 429)
        self.assertEqual(result['error']['retry_after'], '9')

    def test_invalid_depth_is_argument_error_before_network(self):
        code, result, _ = self.invoke(['doctor', '--depth', '0'])
        self.assertEqual(code, 2)
        self.assertEqual(result['error']['code'], 'invalid_argument')
        self.assertEqual(self.boundary.calls, [])

    def test_missing_credential_does_not_call_network(self):
        with patch.dict(os.environ, {}, clear=True), patch('sys.platform', 'linux'):
            code, result, _ = self.invoke(['doctor', '--no-cache'])
        self.assertEqual(code, 1)
        self.assertEqual(result['error']['code'], 'credential_missing')
        self.assertEqual(self.boundary.calls, [])

    def test_output_error_is_operational_and_preserves_existing_file(self):
        output = Path(self.temp.name) / 'existing.json'
        output.write_text('existing content')
        with patch('figma_ops_core.os.replace', side_effect=OSError('synthetic-secret')):
            code, result, _ = self.invoke(['doctor', '--no-cache', '--output', str(output)])
        self.assertEqual(code, 1)
        self.assertEqual(result['error']['code'], 'output_error')
        self.assertEqual(output.read_text(), 'existing content')

    def test_operational_error_full_envelope_written_to_output(self):
        output = Path(self.temp.name) / 'error.json'
        self.boundary.responses = [(403, {}, {})]
        code, result, _ = self.invoke(['doctor', '--no-cache', '--output', str(output)])
        self.assertEqual(code, 1)
        self.assertEqual(result['status'], 'error')
        self.assertEqual(json.loads(output.read_text())['error']['code'], 'forbidden')

    def test_exponent_overflow_returns_strict_error_json_and_artifact(self):
        output = Path(self.temp.name) / 'overflow.json'
        self.boundary.responses = [(200, b'{"nested": [{"number": 1e999}]}', {})]
        code, result, _ = self.invoke(['doctor', '--no-cache', '--output', str(output)])
        self.assertEqual(code, 1)
        self.assertEqual(result['error']['code'], 'invalid_response')
        full = json.loads(output.read_text())
        self.assertEqual(full['status'], 'error')
        json.dumps(full, allow_nan=False)

    def test_nonfinite_handler_result_becomes_safe_error_before_serialization(self):
        # A synthetic registered handler exercises the final output boundary even
        # when future command computations produce a nonfinite number locally.
        for extra in ([], ['--output', str(Path(self.temp.name) / 'handler.json')]):
            with self.subTest(extra=extra), patch.object(cli, 'doctor', return_value={
                    'status': 'ok', 'data': {'nested': [float('inf')]}}):
                code, result, _ = self.invoke(['doctor', '--no-cache'] + extra)
            self.assertEqual(code, 1)
            self.assertEqual(result['error']['code'], 'invalid_response')
            json.dumps(result, allow_nan=False)
            if extra:
                full = json.loads(Path(extra[1]).read_text())
                self.assertEqual(full['status'], 'error')
                json.dumps(full, allow_nan=False)

    def test_entrypoint_from_temporary_cwd(self):
        old_cwd = Path.cwd()
        out = io.StringIO()
        try:
            os.chdir(self.temp.name)
            with patch.object(sys, 'argv', [str(SCRIPTS / 'figma_ops.py'), 'doctor', '--no-cache']), redirect_stdout(out), self.assertRaises(SystemExit) as caught:
                runpy.run_path(str(SCRIPTS / 'figma_ops.py'), run_name='__main__')
        finally:
            os.chdir(old_cwd)
        self.assertEqual(caught.exception.code, 0)
        self.assertEqual(json.loads(out.getvalue())['status'], 'ok')

    def test_context_common_flags_after_command_preserve_full_artifact(self):
        from context_fixtures import payload, comment_payload
        output = Path(self.temp.name) / 'context.json'
        self.boundary.responses = [(200, payload(), {}), (200, comment_payload(), {})]
        code, result, error = self.invoke(['context', 'Synthetic', '--node', '2:1', '--scope-root', '2:0',
                                          '--limit', '1', '--no-cache', '--refresh',
                                          '--cache-dir', str(Path(self.temp.name) / 'cache'), '--output', str(output)])
        self.assertEqual((code, error), (0, ''))
        full = json.loads(output.read_text())
        self.assertEqual(full['operation'], 'context')
        self.assertEqual(len(full['data']['sections']['structure']['data']['texts']), 2)
        self.assertEqual(result['data'], {'artifact': str(output.resolve()), 'bytes': output.stat().st_size})
        self.assertEqual(len(self.boundary.calls), 2)


class BindingsCliParserTests(unittest.TestCase):
    def test_bindings_registered_with_all_common_and_scope_flags(self):
        arguments = cli.build_parser().parse_args([
            'bindings', 'BranchKey', '--node', 'I2:1;3:7', '--scope-root', '2:0',
            '--with-variables', '--limit', '1', '--refresh', '--no-cache',
            '--cache-dir', '/tmp/synthetic-cache', '--output', '/tmp/synthetic-result.json'])
        self.assertEqual((arguments.command, arguments.target, arguments.node, arguments.scope_root),
                         ('bindings', 'BranchKey', 'I2:1;3:7', '2:0'))
        self.assertTrue(arguments.with_variables and arguments.refresh and arguments.no_cache)
        self.assertEqual(arguments.limit, 1)
        self.assertEqual(arguments.output, Path('/tmp/synthetic-result.json'))
        self.assertEqual(arguments.cache_dir, Path('/tmp/synthetic-cache'))
