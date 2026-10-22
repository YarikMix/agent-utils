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
