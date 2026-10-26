"""Offline asset verification checks real PNG pixels without runtime side effects."""
import builtins
from contextlib import ExitStack, redirect_stdout
from datetime import datetime
import hashlib
import importlib
import io
import json
import os
from pathlib import Path
import socket
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True
SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
from test_image import png
import figma_ops_image


class AssetVerifyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='asset verify ')
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        # A missing helper fails here for the intended missing public interface.
        self.verifier = importlib.import_module('figma_asset_verify')

    def asset(self, content=None, name='local asset.dat'):
        path = self.directory / name
        path.write_bytes(png() if content is None else content)
        return path

    def assert_receipt(self, receipt):
        self.assertEqual(set(receipt), {'schema_version', 'operation', 'source', 'status',
                                       'checked_at', 'data', 'warnings', 'error'})
        self.assertEqual(receipt['schema_version'], 1)
        self.assertEqual(receipt['operation'], 'verify-asset')
        self.assertEqual(receipt['source'], 'local-file')
        self.assertTrue(receipt['checked_at'].endswith('Z'))
        self.assertIsNotNone(datetime.fromisoformat(receipt['checked_at'].replace('Z', '+00:00')).tzinfo)
        self.assertEqual(set(receipt['data']), {'path', 'bytes', 'format', 'width', 'height',
                                              'alpha', 'expected', 'checks', 'provenance_verified'})
        self.assertEqual(receipt['data']['format'], 'png')
        self.assertIs(receipt['data']['provenance_verified'], False)
        self.assertEqual(set(receipt['data']['checks']), {'valid_png', 'width', 'height', 'transparency'})
        self.assertTrue(set(receipt['data']['checks'].values()) <=
                        {'passed', 'failed', 'unavailable', 'not_requested'})
        json.dumps(receipt, allow_nan=False)

    def snapshot(self):
        result = {}
        for path in self.directory.rglob('*'):
            mode = path.lstat().st_mode
            digest = None
            if stat.S_ISREG(mode):
                hasher = hashlib.sha256()
                with path.open('rb') as stream:
                    for block in iter(lambda: stream.read(1024 * 1024), b''):
                        hasher.update(block)
                digest = hasher.hexdigest()
            result[str(path.relative_to(self.directory))] = (mode, digest)
        return result

    def test_transparent_png_requirements(self):
        path = self.asset(png(b'\x00\x10\x20\x30\x00'))
        before = self.snapshot()
        receipt = self.verifier.verify_file(path, expect_width=1, expect_height=1,
                                            require_transparency=True)
        self.assert_receipt(receipt)
        self.assertEqual((receipt['status'], receipt['source']), ('ok', 'local-file'))
        self.assertEqual(receipt['data']['checks'], {'valid_png': 'passed', 'width': 'passed',
                                                   'height': 'passed', 'transparency': 'passed'})
        self.assertEqual((receipt['data']['width'], receipt['data']['height']), (1, 1))
        self.assertEqual(receipt['data']['alpha'], 'transparent')
        self.assertEqual(receipt['data']['path'], str(path))
        self.assertEqual(receipt['data']['bytes'], path.stat().st_size)
        self.assertEqual(receipt['data']['expected'], {'width': 1, 'height': 1,
                                                      'require_transparency': True})
        self.assertIsNone(receipt['error'])
        self.assertEqual(self.snapshot(), before)

    def test_opaque_without_requirement(self):
        receipt = self.verifier.verify_file(self.asset())
        self.assert_receipt(receipt)
        self.assertEqual(receipt['status'], 'ok')
        self.assertEqual(receipt['data']['alpha'], 'opaque')
        self.assertEqual(receipt['data']['checks'], {'valid_png': 'passed', 'width': 'not_requested',
                                                   'height': 'not_requested', 'transparency': 'not_requested'})
        self.assertEqual(receipt['data']['expected'], {'width': None, 'height': None,
                                                      'require_transparency': False})

    def test_opaque_requirement_fails(self):
        receipt = self.verifier.verify_file(self.asset(), require_transparency=True)
        self.assertEqual(receipt['status'], 'error')
        self.assertEqual(receipt['error']['code'], 'asset_mismatch')
        self.assertEqual(receipt['data']['checks']['transparency'], 'failed')
        self.assertEqual(receipt['data']['checks']['valid_png'], 'passed')

    def test_dimension_mismatch_retains_metadata(self):
        receipt = self.verifier.verify_file(self.asset(), expect_width=2, expect_height=3,
                                            require_transparency=True)
        self.assertEqual((receipt['status'], receipt['error']['code']), ('error', 'asset_mismatch'))
        self.assertEqual((receipt['data']['width'], receipt['data']['height']), (1, 1))
        self.assertEqual(receipt['data']['checks'], {'valid_png': 'passed', 'width': 'failed',
                                                   'height': 'failed', 'transparency': 'failed'})
        one_mismatch = self.verifier.verify_file(self.asset(), expect_width=1, expect_height=2)
        self.assertEqual(one_mismatch['data']['checks']['width'], 'passed')
        self.assertEqual(one_mismatch['data']['checks']['height'], 'failed')

    def test_input_errors_do_not_write(self):
        missing = self.directory / 'missing'
        sparse = self.directory / 'too large'
        with sparse.open('wb') as stream:
            stream.truncate(64 * 1024 * 1024 + 1)
        cases = [(missing, 'invalid_file'), (self.directory, 'invalid_file'),
                 (sparse, 'asset_too_large'), (None, 'invalid_file'),
                 ('bad\x00path', 'invalid_file')]
        if hasattr(os, 'mkfifo'):
            fifo = self.directory / 'fifo'
            os.mkfifo(fifo)
            cases.append((fifo, 'invalid_file'))
        for path, code in cases:
            with self.subTest(path=path):
                before = self.snapshot()
                receipt = self.verifier.verify_file(path, expect_width=1, expect_height=1,
                                                    require_transparency=True)
                self.assert_receipt(receipt)
                self.assertEqual((receipt['status'], receipt['error']['code']), ('error', code))
                self.assertIsNone(receipt['data']['width'])
                self.assertIsNone(receipt['data']['height'])
                self.assertEqual(receipt['data']['alpha'], 'unknown')
                self.assertEqual(set(receipt['data']['checks'].values()), {'unavailable'})
                self.assertEqual(self.snapshot(), before)
        path = self.asset()
        before = self.snapshot()
        with mock.patch('os.open', side_effect=PermissionError('sensitive detail')):
            receipt = self.verifier.verify_file(path)
        self.assertEqual(receipt['error']['code'], 'file_read_failed')
        self.assertNotIn('sensitive detail', json.dumps(receipt))
        self.assertEqual(self.snapshot(), before)

    def test_input_read_is_bounded(self):
        path = self.asset()
        before = self.snapshot()
        real_fstat, real_fdopen = os.fstat, os.fdopen
        requests = []

        def underestimate_size(fd):
            values = list(real_fstat(fd))
            values[6] = 0  # A file that grew after metadata was observed.
            return os.stat_result(values)

        class ReadTracker:
            def __init__(self, stream):
                self.stream = stream

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return self.stream.__exit__(*args)

            def read(self, size=-1):
                requests.append(size)
                if size < 0 or sum(requests) > 33:
                    raise AssertionError('Read exceeded input cap plus sentinel')
                content = self.stream.read(size)
                # Buffered reads can fetch extra bytes even with a bounded request.
                actual_position = getattr(self.stream, 'raw', self.stream).tell()
                if actual_position > 33:
                    raise AssertionError('Descriptor read ahead beyond input cap plus sentinel')
                return content

        with mock.patch.object(self.verifier, 'MAX_INPUT_BYTES', 32), \
                mock.patch('os.fstat', side_effect=underestimate_size), \
                mock.patch('os.fdopen', side_effect=lambda *a, **kw: ReadTracker(real_fdopen(*a, **kw))):
            receipt = self.verifier.verify_file(path)
        self.assertEqual(receipt['error']['code'], 'asset_too_large')
        self.assertTrue(requests)
        self.assertEqual(sum(requests), 33)
        self.assertEqual(self.snapshot(), before)

    def test_corrupt_png_preserves_decoder_error(self):
        good = png()
        corrupt = bytearray(good)
        corrupt[30] ^= 1
        for content in (b'<html>sensitive body</html>', good[:-4], bytes(corrupt), png(width=2**30)):
            with self.subTest(size=len(content)):
                path = self.asset(content)
                before = self.snapshot()
                with self.assertRaises(figma_ops_image.OpsError) as expected:
                    figma_ops_image.inspect_image(content, 'png')
                receipt = self.verifier.verify_file(path, expect_width=1, expect_height=1)
                self.assert_receipt(receipt)
                self.assertEqual(receipt['error']['code'], expected.exception.code)
                self.assertEqual(receipt['error']['message'], expected.exception.message)
                self.assertEqual(receipt['data']['checks']['valid_png'], 'failed')
                self.assertEqual(receipt['data']['checks']['width'], 'unavailable')
                self.assertIsNone(receipt['data']['width'])
                self.assertEqual(receipt['data']['bytes'], len(content))
                self.assertNotIn('sensitive body', json.dumps(receipt))
                self.assertEqual(self.snapshot(), before)

    def test_unknown_alpha_requirement_uses_real_streaming_decoder(self):
        path = self.asset(png(b'\x00\x10\x20\x30\x00'))
        with mock.patch.object(figma_ops_image, 'MAX_DECODED', 1):
            for required in (False, True):
                receipt = self.verifier.verify_file(path, require_transparency=required)
                self.assertEqual(receipt['data']['alpha'], 'unknown')
                self.assertEqual(receipt['data']['checks']['valid_png'], 'passed')
                self.assertTrue(receipt['warnings'])
                self.assertIn('stream and scanlines verified', receipt['warnings'][0])
                if required:
                    self.assertEqual((receipt['status'], receipt['error']['code']),
                                     ('error', 'verification_unavailable'))
                    self.assertEqual(receipt['data']['checks']['transparency'], 'unavailable')
                else:
                    self.assertEqual(receipt['status'], 'ok')
                    self.assertEqual(receipt['data']['checks']['transparency'], 'not_requested')
            receipt = self.verifier.verify_file(path, expect_width=2, expect_height=1,
                                                require_transparency=True)
            self.assertEqual(receipt['error']['code'], 'asset_mismatch')
            self.assertEqual(receipt['data']['checks'], {'valid_png': 'passed', 'width': 'failed',
                                                       'height': 'passed', 'transparency': 'unavailable'})

    def invoke(self, argv, verifier=None):
        output = io.StringIO()
        with redirect_stdout(output):
            code = (verifier or self.verifier).main(argv)
        receipt = json.loads(output.getvalue(), parse_constant=lambda value: self.fail(value))
        self.assert_receipt(receipt)
        return code, receipt

    def test_cli_argument_and_exit_contract(self):
        path = self.asset()
        for args in ([], [str(path), '--expect-width', '1'],
                     [str(path), '--expect-height', '1'],
                     [str(path), '--expect-width', '0', '--expect-height', '1'],
                     [str(path), '--expect-width', '-1', '--expect-height', '1'],
                     [str(path), '--expect-width', '1.5', '--expect-height', '1'],
                     [str(path), '--expect-width', 'abc', '--expect-height', '1'],
                     [str(path), '--expect-width', '1', '--expect-height', '0'],
                     [str(path), '--expect-w', '1', '--expect-height', '1'],
                     [str(path), '--output', 'sensitive-output'],
                     [str(path), '--token', 'sensitive-token'], [str(path), '--refresh']):
            with self.subTest(args=args):
                code, receipt = self.invoke(args)
                self.assertEqual((code, receipt['error']['code']), (2, 'invalid_argument'))
                self.assertNotIn('sensitive-', json.dumps(receipt))
        for args in ([str(path)], [str(path), '--expect-width', '1', '--expect-height', '1']):
            self.assertEqual(self.invoke(args)[0], 0)
        self.assertEqual(self.invoke([str(path), '--require-transparency'])[0], 1)
        self.assertEqual(self.invoke([str(self.directory / 'missing')])[0], 1)
        path.write_bytes(b'invalid')
        self.assertEqual(self.invoke([str(path)])[0], 1)
        output = io.StringIO()
        with redirect_stdout(output):
            self.assertEqual(self.verifier.main(['--help']), 0)
        self.assertIn('--require-transparency', output.getvalue())

    def test_cli_subprocess_from_other_cwd_with_spaces_and_empty_pat(self):
        path = self.asset(png(b'\x00\x10\x20\x30\x00'))
        before = self.snapshot()
        result = subprocess.run([sys.executable, str(SCRIPTS / 'figma_asset_verify.py'), str(path),
                                 '--expect-width', '1', '--expect-height', '1', '--require-transparency'],
                                cwd=self.directory, env={'FIGMA_TOKEN': '', 'FIGMA_ACCESS_TOKEN': '',
                                                         'PYTHONDONTWRITEBYTECODE': '1'},
                                capture_output=True, text=True, timeout=10, check=False)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stderr, '')
        receipt = json.loads(result.stdout)
        self.assert_receipt(receipt)
        self.assertEqual(receipt['status'], 'ok')
        self.assertEqual(self.snapshot(), before)

    def test_import_and_main_do_not_touch_credentials_or_network(self):
        path = self.asset()
        corrupt = self.asset(b'invalid PNG', name='corrupt')
        missing = self.directory / 'missing'
        inputs = {path, corrupt, missing}
        before = self.snapshot()
        real_getitem = os._Environ.__getitem__
        real_open, real_io_open, real_os_open = builtins.open, io.open, os.open
        real_import = builtins.__import__
        modules = ('figma_asset_verify', 'figma_ops_core', 'figma_ops_image')
        saved = {name: sys.modules.pop(name, None) for name in modules}

        def credential_guard(environ, key):
            if key in ('FIGMA_TOKEN', 'FIGMA_ACCESS_TOKEN'):
                raise AssertionError('Credential environment accessed')
            return real_getitem(environ, key)

        def guarded_open(original):
            def open_read_only(file, mode='r', *args, **kwargs):
                if isinstance(file, int):
                    return original(file, mode, *args, **kwargs)
                candidate = Path(file)
                if candidate not in inputs and not (candidate.parent == SCRIPTS and candidate.suffix == '.py'):
                    raise AssertionError('Unexpected file access')
                if any(flag in mode for flag in 'wax+'):
                    raise AssertionError('Unexpected write')
                return original(file, mode, *args, **kwargs)
            return open_read_only

        def guarded_os_open(file, flags, *args, **kwargs):
            if Path(file) not in inputs or flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC):
                raise AssertionError('Unexpected descriptor access')
            return real_os_open(file, flags, *args, **kwargs)

        def guarded_import(name, *args, **kwargs):
            module = real_import(name, *args, **kwargs)
            if name == 'figma_ops_core':
                module.Client = mock.Mock(side_effect=AssertionError('Client constructed'))
                module.resolve_token = mock.Mock(side_effect=AssertionError('Credentials resolved'))
            return module

        try:
            with ExitStack() as guards:
                guards.enter_context(mock.patch.object(os._Environ, '__getitem__', credential_guard))
                guards.enter_context(mock.patch('builtins.open', guarded_open(real_open)))
                guards.enter_context(mock.patch('io.open', guarded_open(real_io_open)))
                guards.enter_context(mock.patch('os.open', guarded_os_open))
                guards.enter_context(mock.patch('builtins.__import__', guarded_import))
                for target in ('subprocess.run', 'subprocess.Popen', 'socket.socket',
                               'socket.create_connection', 'pathlib.Path.home',
                               'pathlib.Path.write_bytes', 'pathlib.Path.write_text',
                               'pathlib.Path.mkdir', 'os.mkdir', 'os.makedirs', 'os.write',
                               'os.unlink', 'os.remove', 'os.rename', 'os.replace', 'os.rmdir'):
                    guards.enter_context(mock.patch(target, side_effect=AssertionError(target)))
                verifier = importlib.import_module('figma_asset_verify')
                self.assertEqual(self.invoke([str(path)], verifier)[0], 0)
                self.assertEqual(self.invoke([str(path), '--require-transparency'], verifier)[0], 1)
                self.assertEqual(self.invoke([str(corrupt)], verifier)[0], 1)
                self.assertEqual(self.invoke([str(missing)], verifier)[0], 1)
                self.assertEqual(self.invoke([str(path), '--output', 'forbidden'], verifier)[0], 2)
        finally:
            for name, module in saved.items():
                sys.modules.pop(name, None)
                if module is not None:
                    sys.modules[name] = module
        self.assertEqual(self.snapshot(), before)


if __name__ == '__main__':
    unittest.main()
