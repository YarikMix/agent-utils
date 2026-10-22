"""Node operations against synthetic REST responses, never live credentials."""
from contextlib import redirect_stdout
import importlib
import io
import json
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from test_core import CurlBoundary, core
import figma_ops as cli


def document():
    return {'name': 'Synthetic file', 'version': 'v7', 'document': {
        'id': '0:0', 'type': 'DOCUMENT', 'name': 'Document', 'children': [
            {'id': '1:1', 'type': 'CANVAS', 'name': 'Dependency', 'children': [
                {'id': '1:2', 'type': 'FRAME', 'name': 'Straße dependency'}]},
            {'id': '2:1', 'type': 'CANVAS', 'name': 'Screens', 'children': [
                {'id': '2:2', 'type': 'FRAME', 'name': 'Screen', 'children': [
                    {'id': '2:3', 'type': 'INSTANCE', 'name': 'Card', 'componentId': '9:1',
                     'relativeTransform': [[1, 0, 10], [0, 1, 20]], 'children': [
                         {'id': 'I2:3;4:5', 'type': 'TEXT', 'name': 'Label', 'characters': 'Straße action'}]},
                    {'id': '2:4', 'type': 'TEXT', 'name': 'Other', 'characters': 'strasse second'}]},
                {'id': '2:5', 'type': 'FRAME', 'name': 'Sibling'}]}]}}


class NodeTests(unittest.TestCase):
    def setUp(self):
        self.payload = document()
        self.boundary = CurlBoundary([(200, self.payload, {})])
        patch('subprocess.run', self.boundary).start()
        self.addCleanup(patch.stopall)
        self.client = core.Client(token='synthetic-secret', no_cache=True)

    def invoke(self, argv):
        out = io.StringIO()
        with patch.object(cli, 'Client', return_value=self.client), redirect_stdout(out):
            code = cli.main(argv + ['--no-cache'])
        return code, json.loads(out.getvalue())

    def query(self):
        return parse_qs(urlsplit(self.boundary.calls[0][0][-1]).query)

    def test_inspect_exact_node_retains_source_ancestry_and_ownership(self):
        code, result = self.invoke(['inspect', 'Key', '--node', '2-3'])
        self.assertEqual(code, 0)
        data = result['data']
        self.assertEqual(data['node']['id'], '2:3')
        self.assertEqual(data['node']['componentId'], '9:1')
        self.assertEqual(data['node']['relativeTransform'], [[1, 0, 10], [0, 1, 20]])
        self.assertEqual([n['id'] for n in data['ancestors']], ['0:0', '2:1', '2:2'])
        self.assertEqual(data['page']['id'], '2:1')
        self.assertEqual(data['containing_frame']['id'], '2:2')
        self.assertEqual([n['id'] for n in data['children']], ['I2:3;4:5'])
        self.assertEqual(self.query(), {'ids': ['2:3']})
        self.assertEqual(result['version'], 'v7')
        self.assertEqual(result['cache'], 'bypass')
        self.assertTrue(result['fetched_at'].endswith('Z'))

    def test_inspect_without_node_lists_pages_and_uses_depth_one(self):
        code, result = self.invoke(['inspect', 'Key'])
        self.assertEqual(code, 0)
        self.assertEqual([p['id'] for p in result['data']['pages']], ['1:1', '2:1'])
        self.assertEqual(self.query(), {'depth': ['1']})

    def test_inspect_depth_is_positive_and_passed_to_server(self):
        code, result = self.invoke(['inspect', 'Key', '--node', '2:3', '--depth', '2'])
        self.assertEqual(code, 0)
        self.assertEqual(self.query(), {'ids': ['2:3'], 'depth': ['2']})
        self.assertFalse(result['coverage']['complete'])

    def test_missing_target_is_error(self):
        code, result = self.invoke(['inspect', 'Key', '--node', '99:9'])
        self.assertEqual(code, 1)
        self.assertEqual(result['error']['code'], 'not_found_or_inaccessible')

    def test_search_casefolds_characters_and_preserves_context_and_full_count(self):
        code, result = self.invoke(['search', 'Key', '--query', 'STRASSE', '--limit', '1'])
        self.assertEqual(code, 0)
        self.assertEqual(result['coverage']['total_matches'], 3)
        self.assertEqual(result['coverage']['returned'], 1)
        self.assertTrue(result['coverage']['truncated'])
        self.assertEqual(result['coverage']['scanned_nodes'], 9)
        code, result = self.invoke_second(['search', 'Key', '--query', 'STRASSE', '--type', 'TEXT'])
        self.assertEqual(code, 0)
        row = result['data']['matches'][0]
        self.assertEqual(row['id'], 'I2:3;4:5')
        self.assertEqual(row['matched_fields'], ['characters'])
        self.assertEqual(row['text'], 'Straße action')
        self.assertIn('Straße', row['snippet'])
        self.assertEqual(row['path'], ['Document', 'Screens', 'Screen', 'Card', 'Label'])
        self.assertEqual(row['page']['id'], '2:1')
        self.assertEqual(parse_qs(urlsplit(row['url']).query), {'node-id': ['I2:3;4:5']})

    def invoke_second(self, argv):
        self.boundary.responses.append((200, self.payload, {}))
        return self.invoke(argv)

    def test_page_scope_excludes_extra_dependencies_and_counts_full_subtree(self):
        code, result = self.invoke(['search', 'Key', '--query', 'STRASSE', '--page', '2-1'])
        self.assertEqual(code, 0)
        self.assertEqual(self.query(), {'ids': ['2:1']})
        self.assertEqual(result['coverage']['total_matches'], 2)
        self.assertEqual(result['coverage']['scanned_nodes'], 6)
        self.assertEqual(result['coverage']['scope'], {'kind': 'page', 'node_id': '2:1'})
        self.assertFalse(result['coverage']['complete'])
        self.assertTrue(result['warnings'])

    def test_missing_page_is_error(self):
        code, result = self.invoke(['search', 'Key', '--query', 'x', '--page', '9:9'])
        self.assertEqual(code, 1)
        self.assertEqual(result['error']['code'], 'not_found_or_inaccessible')

    def test_empty_match_never_claims_complete_remote_internals(self):
        code, result = self.invoke(['search', 'Key', '--query', 'absent'])
        self.assertEqual(code, 0)
        self.assertEqual(result['data']['matches'], [])
        self.assertEqual(result['coverage']['total_matches'], 0)
        self.assertFalse(result['coverage']['complete'])

    def test_snippet_contains_late_match_after_unicode_casefold_expansion(self):
        self.payload['document']['children'][1]['children'][0]['children'][1]['characters'] = 'ß' * 300 + ' Needle at end'
        code, result = self.invoke(['search', 'Key', '--query', 'needle'])
        self.assertEqual(code, 0)
        self.assertIn('Needle', result['data']['matches'][0]['snippet'])

    def test_invalid_arguments_fail_before_transport(self):
        for argv in (['inspect', 'Key', '--depth', '0'], ['inspect', 'Key', '--node', ''],
                     ['search', 'Key', '--query', 'x', '--limit', '0'],
                     ['search', 'Key', '--query', ''], ['search', 'Key'],
                     ['search', 'Key', '--query', 'x', '--page', '']):
            with self.subTest(argv=argv):
                code, result = self.invoke(argv)
                self.assertEqual(code, 2)
                self.assertEqual(result['error']['code'], 'invalid_argument')
        self.assertEqual(self.boundary.calls, [])

    def test_iterative_traversal_handles_deep_document(self):
        try:
            nodes = importlib.import_module('figma_ops_nodes')
        except ModuleNotFoundError:
            self.fail('Node traversal is not implemented')
        root = {'id': 'root', 'type': 'DOCUMENT'}
        current = root
        for index in range(1200):
            child = {'id': str(index), 'type': 'FRAME'}
            current['children'] = [child]
            current = child
        self.assertEqual(sum(1 for _ in nodes.walk_nodes(root)), 1201)
