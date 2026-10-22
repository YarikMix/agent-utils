"""Verified files, scoped image refs, and safe filesystem/API boundaries."""
import argparse
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from figma_ops_core import ApiResponse, Client, OpsError
from test_image import png


class FakeClient:
    def __init__(self, payloads, assets=None):
        self.payloads = payloads
        self.assets = assets or {}
        self.calls = []

    def get_json(self, path, params=None):
        self.calls.append((path, params))
        return ApiResponse(self.payloads[path], '2026-10-22T00:00:00Z', 'bypass')

    def download(self, url):
        if not isinstance(url, str) or not url.startswith('https://'):
            raise OpsError('invalid_argument', 'Assets require HTTPS.')
        content = self.assets[url]
        if isinstance(content, Exception):
            raise content
        return content


def arguments(directory=None, **values):
    return argparse.Namespace(**dict({'target': 'Synthetic', 'node': ['1:2'], 'format': 'png',
                                     'scale': 1., 'dest': directory, 'overwrite': False}, **values))


class AssetsTests(unittest.TestCase):
    def export(self, args, client):
        from figma_ops_assets import export
        return export(args, client)

    def fills(self, args, client):
        from figma_ops_assets import fills
        return fills(args, client)

    def test_mixed_null_valid_render_is_partial_after_pixel_verification(self):
        with tempfile.TemporaryDirectory() as directory:
            client = FakeClient({'images/Synthetic': {'images': {'1:2': 'https://assets.example/a', '2:3': None}}}, {'https://assets.example/a': png()})
            result = self.export(arguments(directory, node=['1:2','2:3'], scale=2.), client)
            self.assertEqual(result['status'], 'partial')
            self.assertEqual((result['coverage']['requested'], result['coverage']['succeeded'], result['coverage']['failed']), (2,1,1))
            self.assertEqual(client.calls, [('images/Synthetic', {'ids': '1:2,2:3', 'format': 'png', 'scale': 2., 'contents_only': 'true'})])
            good, bad = result['data']['files']
            self.assertEqual(Path(good['path']).read_bytes(), png())
            self.assertEqual((good['alpha'], good['width'], good['height'], good['scale_requested']), ('opaque',1,1,2.))
            self.assertEqual(bad['status'], 'error')
            self.assertTrue(any('downscale' in w for w in result['warnings']))

    def test_unknown_svg_encoding_does_not_abort_following_valid_asset(self):
        # A parser LookupError must stay a per-node error, so the next file is saved.
        with tempfile.TemporaryDirectory() as directory:
            client = FakeClient({'images/Synthetic': {'images': {
                '1:2': 'https://assets.example/bad', '2:3': 'https://assets.example/good'}}}, {
                'https://assets.example/bad': b'<?xml version="1.0" encoding="unknown"?><svg/>',
                'https://assets.example/good': b'<svg/>'})
            result = self.export(arguments(directory, node=['1:2','2:3'], format='svg'), client)
            self.assertEqual(result['status'], 'partial')
            self.assertEqual((result['coverage']['requested'], result['coverage']['succeeded'],
                              result['coverage']['failed']), (2,1,1))
            bad, good = result['data']['files']
            self.assertEqual((bad['node_id'], bad['status'], bad['error']['code']),
                             ('1:2','error','invalid_asset'))
            self.assertEqual((good['node_id'],good['status']), ('2:3','ok'))
            self.assertEqual(Path(good['path']).read_bytes(), b'<svg/>')
            self.assertEqual(len(list(Path(directory).iterdir())), 1)
            from figma_ops_core import serialize_json
            self.assertIn('"status": "partial"', serialize_json(result))

    def test_no_url_or_failed_download_never_counts_as_export(self):
        for asset in [None, OpsError('network_error','Failed'), b'<html>error</html>']:
            with self.subTest(asset=type(asset).__name__), tempfile.TemporaryDirectory() as directory:
                client = FakeClient({'images/Synthetic': {'images': {'1:2': None if asset is None else 'https://assets.example/a'}}}, {'https://assets.example/a': asset})
                result = self.export(arguments(directory), client)
                self.assertEqual(result['status'], 'error')
                self.assertEqual(result['coverage']['succeeded'], 0)
                self.assertFalse(list(Path(directory).iterdir()))

    def test_unsafe_instance_id_stays_inside_destination_and_distinct(self):
        ids = ['I1:2;3:4', '../../escape', '..\\escape', '1/2', '1_2']
        with tempfile.TemporaryDirectory() as directory:
            client = FakeClient({'images/Synthetic': {'images': dict.fromkeys(ids,'https://assets.example/a')}}, {'https://assets.example/a': png()})
            result = self.export(arguments(directory, node=ids), client)
            paths = [Path(item['path']) for item in result['data']['files']]
            self.assertEqual(result['status'], 'ok')
            self.assertEqual(len(set(paths)), 5)
            self.assertTrue(all(p.parent == Path(directory).resolve() for p in paths))

    def test_existing_file_is_unchanged_unless_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            client = FakeClient({'images/Synthetic': {'images': {'1:2':'https://assets.example/a'}}}, {'https://assets.example/a': png()})
            first = self.export(arguments(directory), client)
            path = Path(first['data']['files'][0]['path'])
            path.write_bytes(b'keep existing')
            result = self.export(arguments(directory), client)
            self.assertEqual(result['status'], 'error')
            self.assertEqual(path.read_bytes(), b'keep existing')
            self.assertEqual(self.export(arguments(directory, overwrite=True), client)['status'], 'ok')
            self.assertEqual(path.read_bytes(), png())
            self.assertEqual(len(list(Path(directory).iterdir())), 1)

    def test_failed_atomic_publication_preserves_existing_and_cleans_temp(self):
        with tempfile.TemporaryDirectory() as directory:
            client = FakeClient({'images/Synthetic': {'images': {'1:2':'https://assets.example/a'}}}, {'https://assets.example/a': png()})
            first = self.export(arguments(directory), client)
            path = Path(first['data']['files'][0]['path'])
            path.write_bytes(b'keep')
            with patch('os.replace', side_effect=OSError('disk error')):
                result = self.export(arguments(directory, overwrite=True), client)
            self.assertEqual(result['status'], 'error')
            self.assertEqual(path.read_bytes(), b'keep')
            self.assertEqual([p.resolve() for p in Path(directory).iterdir()], [path])

    def test_node_and_scale_boundaries_reject_before_api(self):
        for values in [{'node': []}, {'node':['1:2']*21}, {'scale':0.009}, {'scale':4.01}, {'scale':float('nan')}, {'scale':float('inf')}]:
            client = FakeClient({})
            with self.subTest(values=values), self.assertRaises(OpsError) as raised:
                self.export(arguments('/tmp/not-used', **values), client)
            self.assertEqual(raised.exception.code, 'invalid_argument')
            self.assertEqual(client.calls, [])

    def test_url_node_and_scale_inclusive_bounds(self):
        for scale in [.01, 4.]:
            with tempfile.TemporaryDirectory() as directory:
                client = FakeClient({'images/Synthetic': {'images': {'1:2':'https://assets.example/a'}}}, {'https://assets.example/a': png()})
                result = self.export(arguments(directory,target='https://figma.com/design/Synthetic/?node-id=1-2',node=None,scale=scale), client)
                self.assertEqual(result['status'], 'ok')
                self.assertEqual(result['data']['files'][0]['node_id'], '1:2')

    def test_https_and_credentials_are_enforced_by_real_download(self):
        client = Client(token='synthetic-test-token')
        with patch.object(client, '_request', return_value=png()) as request:
            self.assertEqual(client.download('https://assets.example/a'), png())
            request.assert_called_once_with('https://assets.example/a')
        for url in ['http://assets.example/a', 'https://user:pass@assets.example/a']:
            with self.assertRaises(OpsError):
                client.download(url)

    def fill_client(self, assets=None):
        return FakeClient({'files/Synthetic': {'version':'v1','document': {'id':'0:0','children':[
            {'id':'1:2','fills':[{'type':'IMAGE','imageRef':'inside'}, {'type':'IMAGE','imageRef':'missing'}],
             'children':[{'id':'1:3','fills':[{'type':'IMAGE','imageRef':'inside'}]}]},
            {'id':'9:9','fills':[{'type':'IMAGE','imageRef':'outside'}]}]}},
            'files/Synthetic/images': {'meta': {'images': {'inside':'https://assets.example/a','outside':'https://assets.example/b'}}}}, assets)

    def test_fills_uses_requested_subtree_and_reports_missing_refs(self):
        client = self.fill_client()
        result = self.fills(arguments(node='1:2'), client)
        self.assertEqual(result['status'], 'partial')
        self.assertEqual([item['image_ref'] for item in result['data']['files']], ['inside','missing'])
        self.assertEqual(result['coverage']['requested'], 2)
        self.assertEqual(result['coverage']['urls_available'], 1)
        self.assertEqual(result['coverage']['downloaded'], 0)
        self.assertFalse(result['coverage']['complete'])
        self.assertEqual(client.calls[0], ('files/Synthetic', {'ids':'1:2'}))
        self.assertTrue(result['warnings'])

    def test_image_refs_in_backgrounds_and_strokes_and_missing_ref_count(self):
        client = FakeClient({'files/Synthetic': {'document': {'id':'1:2',
            'fills':[{'type':'IMAGE'}], 'backgrounds':[{'type':'IMAGE','imageRef':'bg'}],
            'strokes':[{'type':'IMAGE','imageRef':'stroke'}]}},
            'files/Synthetic/images': {'meta':{'images': {'bg':'https://assets.example/bg','stroke':'https://assets.example/stroke'}}}})
        result = self.fills(arguments(node='1:2'),client)
        self.assertEqual(result['status'], 'partial')
        self.assertEqual([f['image_ref'] for f in result['data']['files']], ['bg','stroke'])
        self.assertEqual(result['coverage']['unresolved_image_fills'], 1)

    def test_atomic_no_overwrite_protects_file_created_after_download(self):
        with tempfile.TemporaryDirectory() as directory:
            client = FakeClient({'images/Synthetic': {'images': {'1:2':'https://assets.example/a'}}}, {'https://assets.example/a': png()})
            from figma_ops_assets import _filename
            destination = Path(directory) / _filename('1:2','png','node')
            original_download = client.download
            def racing_download(url):
                destination.write_bytes(b'other writer')
                return original_download(url)
            client.download = racing_download
            result = self.export(arguments(directory),client)
            self.assertEqual(result['status'], 'error')
            self.assertEqual(destination.read_bytes(), b'other writer')
            self.assertEqual(len(list(Path(directory).iterdir())),1)

    def test_fills_saves_verified_source_without_claiming_upload_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            client = self.fill_client({'https://assets.example/a':png(b'\x00\x00\x00\x00\x00')})
            result = self.fills(arguments(directory,node='1:2'), client)
            item = result['data']['files'][0]
            self.assertEqual(item['alpha'], 'transparent')
            self.assertIsNone(item['scale_requested'])
            self.assertEqual(Path(item['path']).read_bytes(), png(b'\x00\x00\x00\x00\x00'))
            self.assertEqual(result['data']['source_kind'], 'api-image-fill-source')
            self.assertEqual(result['coverage']['downloaded'], 1)

    def test_fills_common_gif_webp_sources_are_saved_with_unknown_alpha(self):
        for content, fmt in [(b'GIF89a'+struct.pack('<HHBBB',1,1,0,0,0)+b'\x3b','gif'),
                             (b'RIFF'+struct.pack('<I',12)+b'WEBPVP8 '+b'\x00'*4,'webp')]:
            with self.subTest(fmt=fmt), tempfile.TemporaryDirectory() as directory:
                client = self.fill_client({'https://assets.example/a': content})
                result = self.fills(arguments(directory,node='1:2'), client)
                item = result['data']['files'][0]
                self.assertEqual((item['format'],item['alpha']), (fmt,'unknown'))
                self.assertEqual(Path(item['path']).read_bytes(), content)
                self.assertTrue(result['warnings'])

    def test_cli_registers_asset_operations(self):
        from figma_ops import build_parser
        parser = build_parser()
        for argv, operation in [(['export','Synthetic','--node','1:2','--dest','/tmp/unused'], 'export'),
                                (['fills','Synthetic'], 'fills')]:
            args = parser.parse_args(argv)
            self.assertEqual(args.handler.__name__, operation)


if __name__ == '__main__':
    unittest.main()
