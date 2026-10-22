"""Annotations contract: exact scope, full extraction, lossless malformed data."""
import copy
import importlib
import json
from pathlib import Path
import tempfile
import unittest
from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch

from context_fixtures import invoke, payload
from test_core import core, CurlBoundary


def selected(body):
    return body['document']['children'][1]['children'][0]['children'][0]


class AnnotationsTests(unittest.TestCase):
    def test_annotations_casefolds_full_scope_before_inline_limit(self):
        code, result, transport = invoke(['annotations', 'Key', '--node', '2-1', '--query', 'STRASSE', '--limit', '1'], [(200, payload(), {})])
        self.assertEqual(code, 0)
        self.assertEqual(result['coverage']['scanned_nodes'], 2)
        self.assertEqual(result['coverage']['total_annotations'], 2)
        self.assertEqual(result['coverage']['matched_annotations'], 2)
        self.assertEqual(result['coverage']['returned'], 1)
        self.assertEqual(result['data']['annotations'][0]['node']['id'], '2:1')
        self.assertEqual(result['data']['annotations'][0]['raw']['properties'], [{'type': 'width'}])
        self.assertFalse(result['coverage']['complete'])
        self.assertTrue(result['coverage']['truncated'])
        self.assertEqual(len(transport.calls), 1)
        url = transport.calls[0][0][-1]
        self.assertEqual(parse_qs(urlsplit(url).query), {'ids': ['2:1']})

    def test_output_retains_all_matches_and_markdown_category(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'annotations.json'
            code, summary, _ = invoke(['annotations', 'Key', '--node', '2:1', '--limit', '1', '--output', str(path)], [(200, payload(), {})])
            result = json.loads(path.read_text())
        self.assertEqual(code, 0)
        self.assertIn('artifact', summary['data'])
        self.assertEqual(result['coverage']['returned'], 2)
        self.assertFalse(result['coverage']['truncated'])
        self.assertEqual(result['data']['annotations'][1]['raw'], {'labelMarkdown': 'STRASSE markdown', 'categoryId': 'category'})

    def test_no_query_keeps_properties_only_and_excludes_dependencies(self):
        code, result, _ = invoke(['annotations', 'Key', '--node', '2:0'], [(200, payload(), {})])
        self.assertEqual(code, 0)
        self.assertEqual([r['node']['id'] for r in result['data']['annotations']], ['2:1', 'I2:1;3:1', '2:2'])
        self.assertIsNone(result['data']['annotations'][2]['label'])
        self.assertEqual(result['data']['annotations'][2]['properties'], [{'type': 'height'}])
        self.assertEqual(result['coverage']['nodes_with_empty_annotations'], 1)
        self.assertEqual(result['coverage']['nodes_with_annotations_field'], 4)
        self.assertEqual(result['coverage']['nodes_without_annotations_field'], 0)
        self.assertEqual(result['coverage']['scope'], 'loaded-subtree')
        self.assertEqual(result['coverage']['root']['id'], '2:0')

    def test_missing_field_is_ok_with_missing_coverage_and_warning(self):
        body = payload()
        del selected(body)['annotations']
        code, result, _ = invoke(['annotations', 'Key', '--node', '2:1'], [(200, body, {})])
        self.assertEqual((code, result['status']), (0, 'ok'))
        self.assertEqual(result['coverage']['nodes_without_annotations_field'], 1)
        self.assertEqual(result['coverage']['nodes_with_annotations_field'], 1)
        self.assertIn('fields_not_returned', result['warnings'])
        self.assertFalse(result['coverage']['complete'])

    def test_explicit_empty_is_counted_separately_without_missing_warning(self):
        body = payload()
        selected(body)['annotations'] = []
        code, result, _ = invoke(['annotations', 'Key', '--node', '2:1'], [(200, body, {})])
        self.assertEqual((code, result['status']), (0, 'ok'))
        self.assertEqual(result['coverage']['nodes_with_empty_annotations'], 1)
        self.assertEqual(result['coverage']['total_annotations'], 1)
        self.assertNotIn('fields_not_returned', result['warnings'])

    def test_null_or_wrong_field_type_is_partial_with_useful_descendant(self):
        for malformed in (None, {}, 'bad', 7):
            with self.subTest(malformed=malformed):
                body = payload()
                selected(body)['annotations'] = malformed
                code, result, _ = invoke(['annotations', 'Key', '--node', '2:1'], [(200, body, {})])
                self.assertEqual((code, result['status']), (0, 'partial'))
                self.assertEqual(result['coverage']['nodes_with_invalid_annotations'], 1)
                self.assertEqual(result['coverage']['nodes_without_annotations_field'], 0)
                self.assertEqual(result['data']['annotations'][0]['node']['id'], 'I2:1;3:1')
                self.assertTrue(result['warnings'])

    def test_malformed_items_preserve_raw_identity_and_useful_records(self):
        body = payload()
        selected(body)['annotations'] += [None, 'wrong', {'label': 5, 'properties': 'wrong'}]
        code, result, _ = invoke(['annotations', 'Key', '--node', '2:1'], [(200, body, {})])
        self.assertEqual((code, result['status']), (0, 'partial'))
        records = result['data']['annotations']
        self.assertEqual([r['annotation_index'] for r in records], [0, 1, 2, 3, 0])
        self.assertEqual([r['raw'] for r in records[1:4]], [None, 'wrong', {'label': 5, 'properties': 'wrong'}])
        for record in records[1:4]:
            self.assertEqual(record['node']['id'], '2:1')
            self.assertIsNone(record['label'])
            self.assertIsNone(record['properties'])
        self.assertEqual(result['coverage']['total_annotations'], 5)
        self.assertTrue(result['warnings'])

    def test_query_does_not_match_nontext_malformed_item(self):
        body = payload()
        selected(body)['annotations'] = [None, 'STRASSE', {'label': ['STRASSE']}, {'label': 'Straße'}]
        code, result, _ = invoke(['annotations', 'Key', '--node', '2:1', '--query', 'STRASSE'], [(200, body, {})])
        self.assertEqual((code, result['status']), (0, 'partial'))
        self.assertEqual(result['coverage']['total_annotations'], 5)
        self.assertEqual(result['coverage']['matched_annotations'], 2)
        self.assertEqual([r['annotation_index'] for r in result['data']['annotations']], [3, 0])

    def test_query_is_literal_not_regex(self):
        _, result, _ = invoke(['annotations', 'Key', '--node', '2:1', '--query', '.*'], [(200, payload(), {})])
        self.assertEqual(result['coverage']['matched_annotations'], 0)
        self.assertEqual(result['coverage']['total_annotations'], 2)

    def test_branch_composite_identity_and_provenance(self):
        code, result, transport = invoke(['annotations', 'https://figma.com/design/Main/branch/Branch/Name?node-id=I2%3A1%3B3%3A1'], [(200, payload(), {})])
        self.assertEqual(code, 0)
        record = result['data']['annotations'][0]
        self.assertEqual(record['node'], {
            'id': 'I2:1;3:1', 'name': 'Text', 'type': 'TEXT',
            'path': ['Document', 'Page', 'Frame', 'Instance', 'Text'],
            'page': {'id': '1:0', 'name': 'Page', 'type': 'CANVAS'},
            'url': 'https://www.figma.com/design/Branch/?node-id=I2%3A1%3B3%3A1'})
        self.assertEqual(record['provenance'], {
            'source': 'figma-rest', 'file_key': 'Branch', 'node_id': 'I2:1;3:1',
            'json_pointer': '/annotations/0', 'fetched_at': result['fetched_at'], 'version': 'v1'})
        self.assertIn('/files/Branch?', transport.calls[0][0][-1])

    def test_invalid_arguments_stop_before_transport(self):
        for argv in (['annotations', 'Key'], ['annotations', 'Key', '--node', '2:1', '--query', ' '],
                     ['annotations', 'Key', '--node', '2:1', '--limit', '0']):
            with self.subTest(argv=argv):
                code, result, transport = invoke(argv, [])
                self.assertEqual((code, result['error']['code']), (2, 'invalid_argument'))
                self.assertEqual(transport.calls, [])

    def test_missing_source_is_error(self):
        code, result, _ = invoke(['annotations', 'Key', '--node', 'missing'], [(200, payload(), {})])
        self.assertEqual((code, result['status'], result['error']['code']), (1, 'error', 'not_found_or_inaccessible'))


class ScopeTests(unittest.TestCase):
    def setUp(self):
        self.scope_module = importlib.import_module('figma_ops_scope')
        self.annotations_module = importlib.import_module('figma_ops_annotations')

    def load(self, root_id=None):
        transport = CurlBoundary([(200, payload(), {})])
        with patch('subprocess.run', transport):
            loaded = self.scope_module.load_scope(core.Client(token='synthetic-secret', no_cache=True), core.Target('Key', '2:1'), root_id=root_id)
        return loaded, transport

    def test_root_ancestor_loaded_once_and_normalized(self):
        loaded, transport = self.load('2-0')
        self.assertEqual((loaded.source['id'], loaded.root['id']), ('2:1', '2:0'))
        self.assertEqual([a['id'] for a in loaded.source_ancestors], ['0:0', '1:0', '2:0'])
        self.assertEqual([a['id'] for a in loaded.root_ancestors], ['0:0', '1:0'])
        self.assertEqual(len(transport.calls), 1)
        self.assertEqual(parse_qs(urlsplit(transport.calls[0][0][-1]).query), {'ids': ['2:1,2:0']})

    def test_equal_root_id_not_duplicated(self):
        loaded, transport = self.load('2-1')
        self.assertEqual(loaded.source, loaded.root)
        self.assertEqual(parse_qs(urlsplit(transport.calls[0][0][-1]).query), {'ids': ['2:1']})

    def test_sibling_root_rejected(self):
        with self.assertRaises(core.OpsError) as caught:
            self.load('2:2')
        self.assertEqual(caught.exception.code, 'scope_mismatch')

    def test_missing_root_rejected(self):
        with self.assertRaises(core.OpsError) as caught:
            self.load('absent')
        self.assertEqual(caught.exception.code, 'not_found_or_inaccessible')

    def test_extraction_is_pure_and_projection_does_not_mutate_response(self):
        loaded, _ = self.load()
        before = copy.deepcopy(loaded.response.payload)
        collected = self.annotations_module.extract_annotations(loaded)
        self.assertEqual(len(collected.data['annotations']), 2)
        self.assertEqual(loaded.response.payload, before)
        self.assertFalse(collected.partial)

    def test_deep_scope_uses_iterative_walk(self):
        tree = {'id': 'deep', 'name': 'Deep', 'type': 'FRAME', 'annotations': []}
        current = tree
        for number in range(1200):
            child = {'id': str(number), 'name': 'Nested', 'type': 'FRAME', 'annotations': []}
            current['children'] = [child]
            current = child
        current['annotations'] = [{'label': 'Deep note'}]
        response = core.ApiResponse({'document': tree, 'version': 'deep-v1'}, '2026-01-01T00:00:00Z', 'bypass')
        class InMemoryClient:
            def get_json(self, path, params):
                return response
        loaded = self.scope_module.load_scope(InMemoryClient(), core.Target('Key', 'deep'))
        collected = self.annotations_module.extract_annotations(loaded)
        self.assertEqual(collected.coverage['scanned_nodes'], 1201)
        self.assertEqual(collected.data['annotations'][0]['node']['id'], '1199')
        self.assertEqual(len(collected.data['annotations'][0]['node']['path']), 1201)


if __name__ == '__main__':
    unittest.main()
