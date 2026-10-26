"""Run published JS/Python recipes; catch unsafe export and host-save boundaries."""
import base64
from copy import deepcopy
from pathlib import Path
import tempfile
import unittest

from recipe_harness import NODE, load_recipe, run_js_recipe

REFERENCE = Path(__file__).resolve().parents[1] / 'skills/figma-ops/references/native-assets.md'


@unittest.skipUnless(NODE, 'Node is unavailable; executable Markdown recipes require Node')
class NativeExportTest(unittest.TestCase):
    def run_recipe(self, fixture=None, **inputs):
        return run_js_recipe(REFERENCE, 'native-png-export', fixture or {'nodes': [
            {'id': 'I12:3;45:6', 'width': 10, 'height': 20, 'exportBytes': [1, 2, 3]}]},
            {'expectedFileKey': 'DemoFile', 'nodeId': 'I12:3;45:6', **inputs})

    def test_native_export_defaults_exact_id_and_no_mutations(self):
        # Catches ID splitting, wrong SCALE settings and traversal instead of exact lookup.
        out = self.run_recipe()
        result = out['result']
        self.assertEqual(['I12:3;45:6'], out['accesses'])
        self.assertEqual([{'nodeId': 'I12:3;45:6', 'settings': {
            'format': 'PNG', 'constraint': {'type': 'SCALE', 'value': 2}}}], out['export_calls'])
        self.assertEqual(1, out['base64_calls'])
        self.assertEqual({'status': 'ok', 'fileKey': 'DemoFile', 'nodeId': 'I12:3;45:6',
                          'version': None, 'source': {'width': 10, 'height': 20, 'render_bounds': None},
                          'scale_requested': 2, 'format': 'png', 'byte_count': 3,
                          'max_bytes': 1048576, 'reason': None, 'base64': 'AQID'}, result)

    def test_wrong_file_guard_precedes_lookup(self):
        out = self.run_recipe({'fileKey': 'Other', 'nodes': []})
        self.assertIn('file_mismatch', out['error'])
        self.assertEqual([], out['accesses'])
        self.assertEqual([], out['export_calls'])

    def test_export_bounds_reject_before_lookup(self):
        for key, values in [('scale', [None, False, '2', 0, .009, 4.01, float('inf'), float('nan')]),
                            ('maxBytes', [None, False, '8', 0, 1.5, 4194305]),
                            ('nodeId', [None, '', ' ', 12]),
                            ('expectedFileKey', [None, '', ' ', 12])]:
            for value in values:
                with self.subTest(key=key, value=value):
                    out = self.run_recipe(**{key: value})
                    self.assertIn('invalid_', out['error'])
                    self.assertEqual([], out['accesses'])
                    self.assertEqual([], out['export_calls'])
        for scale, cap in [(.01, 1), (4, 4194304)]:
            with self.subTest(scale=scale, cap=cap):
                out = self.run_recipe(scale=scale, maxBytes=cap)
                self.assertEqual(scale, out['export_calls'][0]['settings']['constraint']['value'])
                self.assertEqual(cap, out['result']['max_bytes'])

    def test_export_cap_omits_binary_without_resizing(self):
        out = self.run_recipe(scale=3, maxBytes=2)
        self.assertEqual('partial', out['result']['status'])
        self.assertEqual('export_size_limit', out['result']['reason'])
        self.assertEqual(3, out['result']['byte_count'])
        self.assertNotIn('base64', out['result'])
        self.assertEqual(0, out['base64_calls'])
        self.assertEqual([{'nodeId': 'I12:3;45:6', 'settings': {
            'format': 'PNG', 'constraint': {'type': 'SCALE', 'value': 3}}}], out['export_calls'])
        boundary = self.run_recipe(maxBytes=3)
        self.assertEqual('ok', boundary['result']['status'])
        self.assertEqual(b'\x01\x02\x03', base64.b64decode(boundary['result']['base64']))

    def test_missing_unsupported_empty_and_api_rejection_are_errors(self):
        for nodes, expected in [([], 'node_not_found'),
                                ([{'id': 'I12:3;45:6'}], 'unsupported_export'),
                                ([{'id': 'I12:3;45:6', 'exportBytes': []}], 'empty_export'),
                                ([{'id': 'I12:3;45:6', 'exportError': '429 retry_after=9'}], '429 retry_after=9'),
                                ([{'id': 'I12:3;45:6', 'exportError': 'policy_denied'}], 'policy_denied')]:
            with self.subTest(expected=expected):
                out = self.run_recipe({'nodes': nodes})
                self.assertIn(expected, out['error'])
                self.assertNotIn('result', out)
                self.assertEqual(0, out['base64_calls'])
                self.assertLessEqual(len(out['export_calls']), 1)

    def test_unavailable_geometry_does_not_block_export_or_invent_pixels(self):
        fixture = {'nodes': [{'id': 'I12:3;45:6', 'throwFields': [
            'width', 'height', 'absoluteRenderBounds'], 'exportBytes': [9]}]}
        result = self.run_recipe(fixture)['result']
        self.assertEqual('ok', result['status'])
        self.assertEqual({'width': None, 'height': None, 'render_bounds': None}, result['source'])
        fixture['nodes'][0].update(throwFields=[], width=1.5, height=2,
                                  absoluteRenderBounds={'x': -1, 'y': 2, 'width': 3.5, 'height': 4})
        result = self.run_recipe(fixture)['result']
        self.assertEqual({'width': 1.5, 'height': 2,
                          'render_bounds': {'x': -1, 'y': 2, 'width': 3.5, 'height': 4}}, result['source'])
        self.assertNotIn('alpha', result)
        self.assertNotIn('verified', result)


class HostSaveTest(unittest.TestCase):
    def capture(self, content=b'\x00\x01\xff'):
        return {'status': 'ok', 'format': 'png', 'byte_count': len(content),
                'max_bytes': 1048576, 'base64': base64.b64encode(content).decode(),
                'fileKey': 'DemoFile', 'nodeId': 'I12:3;45:6', 'version': None,
                'source': {'width': None, 'height': None, 'render_bounds': None},
                'scale_requested': 2, 'reason': None}

    def save(self, capture, destination):
        namespace = {'capture': capture, 'destination': destination}
        exec(compile(load_recipe(REFERENCE, 'native-png-save', 'python'),
                     str(REFERENCE), 'exec'), namespace)
        return namespace['saved']

    def test_host_save_preflight_and_exclusive_create(self):
        # Catches truncation via wb and trusting receipt counts instead of decoded bytes.
        with tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp) / 'export with spaces.png'
            capture = self.capture()
            original = deepcopy(capture)
            saved = self.save(capture, destination)
            self.assertEqual(b'\x00\x01\xff', destination.read_bytes())
            self.assertEqual(str(destination), saved['path'])
            self.assertEqual(3, saved['bytes'])
            self.assertEqual(original, capture)
            destination.write_bytes(b'keep sentinel')
            with self.assertRaises(FileExistsError):
                self.save(capture, destination)
            self.assertEqual(b'keep sentinel', destination.read_bytes())

    def test_invalid_capture_never_creates_destination(self):
        mutations = [
            {'status': 'partial'}, {'format': 'jpg'}, {'byte_count': True},
            {'max_bytes': True}, {'byte_count': 0}, {'max_bytes': 0},
            {'byte_count': 4194305, 'max_bytes': 4194305}, {'max_bytes': 4194305},
            {'byte_count': 4}, {'max_bytes': 2}, {'byte_count': '3'},
            {'base64': 'AAH!'}, {'base64': 'AAH/\n'}, {'base64': 'A' * 5592408},
            {'base64': 'AA=='}, {'base64': 'AAH/AAAA'}, {'base64': None},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp) / 'must not exist.png'
            for mutation in mutations:
                with self.subTest(mutation={k: str(v)[:30] for k, v in mutation.items()}):
                    with self.assertRaises((ValueError, TypeError)):
                        self.save({**self.capture(), **mutation}, destination)
                    self.assertFalse(destination.exists())
            for invalid in (None, [], {}, {'status': 'ok'}):
                with self.subTest(invalid=invalid):
                    with self.assertRaises((ValueError, TypeError)):
                        self.save(invalid, destination)
                    self.assertFalse(destination.exists())

    def test_capture_strings_are_data_and_destination_is_explicit(self):
        with tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp) / 'chosen.png'
            untrusted = Path(tmp) / 'not chosen'
            capture = self.capture(b'not necessarily PNG')
            capture.update(fileKey='__import__("os").abort()', nodeId=str(untrusted),
                           path=str(untrusted), source={'width': 'raise SystemExit'})
            self.save(capture, destination)
            self.assertEqual(b'not necessarily PNG', destination.read_bytes())
            self.assertFalse(untrusted.exists())

    def test_host_save_accepts_payload_at_raw_cap(self):
        with tempfile.TemporaryDirectory() as tmp:
            content = b'\0' * 4194304
            capture = self.capture(content)
            capture['max_bytes'] = 4194304
            destination = Path(tmp) / 'cap.png'
            self.save(capture, destination)
            self.assertEqual(content, destination.read_bytes())


if __name__ == '__main__':
    unittest.main()
