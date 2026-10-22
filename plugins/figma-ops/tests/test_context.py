"""REST dossier contracts using synthetic trees and the real transport boundary."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from context_fixtures import payload, comment_payload, interaction_payload, invoke
from test_core import core


TARGET = 'https://figma.com/design/Key/Test?node-id=2-1'


class ContextTests(unittest.TestCase):
    def run_context(self, arguments=(), body=None, comments=None):
        responses = [(200, body if body is not None else payload(), {})]
        if '--without-comments' not in arguments:
            responses.append(comments if comments is not None else (200, comment_payload(), {}))
        return invoke(['context', TARGET, *arguments, '--no-cache'], responses)

    def test_context_preserves_source_root_and_full_thread_with_two_gets(self):
        code, result, transport = self.run_context(['--scope-root', '2:0'])
        self.assertEqual((code, result['status']), (0, 'ok'))
        data = result['data']
        self.assertEqual(data['source_node']['id'], '2:1')
        self.assertEqual(data['scope_root']['id'], '2:0')
        self.assertEqual(data['url_node_id'], '2:1')
        self.assertEqual([n['id'] for n in data['ancestors']], ['0:0', '1:0', '2:0'])
        self.assertEqual(data['page'], {'id': '1:0', 'name': 'Page', 'type': 'CANVAS'})
        self.assertEqual([n['id'] for n in data['suggested_context_roots']], ['2:0'])
        comments = data['sections']['comments']
        self.assertEqual(comments['data']['threads'][0]['root']['id'], 'thread-root')
        self.assertEqual(len(comments['data']['threads'][0]['replies']), 2)
        self.assertEqual(comments['coverage']['unassigned_count'], 1)
        self.assertEqual(comments['coverage']['total_threads'], 3)
        self.assertEqual([urlsplit(c[0][-1]).path for c in transport.calls],
                         ['/v1/files/Key', '/v1/files/Key/comments'])
        self.assertEqual(parse_qs(urlsplit(transport.calls[0][0][-1]).query), {'ids': ['2:1,2:0']})
        self.assertEqual(data['snapshot_consistency'], 'independent-requests')
        self.assertIsNone(comments['version'])
        self.assertEqual(data['sections']['motion']['state'], 'not_collected')
        self.assertFalse(result['coverage']['complete'])
        for section in data['sections'].values():
            self.assertTrue({'state', 'source', 'fetched_at', 'version', 'coverage', 'data', 'warnings', 'error'} <= section.keys())
        structure = data['sections']['structure']['data']
        self.assertEqual(structure['total_nodes'], 4)
        self.assertEqual(structure['type_counts'], {'FRAME': 1, 'INSTANCE': 1, 'TEXT': 2})
        self.assertEqual(len(structure['direct_children']), 2)
        self.assertEqual(structure['texts'][0]['characters'], 'Synthetic text')

    def test_node_override_preserves_unexamined_url_node_id(self):
        code, result, transport = invoke(['context', TARGET.replace('2-1', '2-2'), '--node', '2:1',
                                         '--without-comments'], [(200, payload(), {})])
        self.assertEqual(code, 0)
        self.assertEqual(result['data']['source_node']['id'], '2:1')
        self.assertEqual(result['data']['url_node_id'], '2:2')
        self.assertEqual(parse_qs(urlsplit(transport.calls[0][0][-1]).query), {'ids': ['2:1']})
        self.assertEqual([t['node']['id'] for t in result['data']['sections']['structure']['data']['texts']], ['I2:1;3:1'])

    def test_scope_mismatch_and_missing_source_or_root_are_errors(self):
        for arguments, error in ((['--scope-root', '2:2'], 'scope_mismatch'),
                                 (['--scope-root', '7:0'], 'not_found_or_inaccessible'),
                                 (['--node', '7:0'], 'not_found_or_inaccessible')):
            with self.subTest(arguments=arguments):
                code, result, transport = self.run_context(arguments)
                self.assertEqual((code, result['error']['code']), (1, error))
                self.assertEqual(len(transport.calls), 1)

    def test_without_comments_and_host_hints_do_not_make_partial(self):
        code, result, transport = self.run_context(['--without-comments'])
        self.assertEqual((code, result['status'], len(transport.calls)), (0, 'ok', 1))
        sections = result['data']['sections']
        self.assertEqual(sections['comments']['state'], 'not_requested')
        for name in ('comments', 'motion', 'canvas_visual'):
            for field in ('fetched_at', 'version', 'data', 'error'):
                self.assertIsNone(sections[name][field])
        for name in ('motion', 'canvas_visual'):
            self.assertEqual(sections[name]['source'], 'figma-mcp')
            self.assertEqual(sections[name]['reason'], 'requires-host-tool')
        actions = result['data']['next_actions']
        self.assertEqual([a['kind'] for a in actions], ['motion_context', 'canvas_visual'])
        self.assertTrue(all(a['file_key'] == 'Key' and a['node_id'] == '2:1'
                            and a['purpose'] and a['prerequisites'] for a in actions))
        self.assertIn('get_motion_context', json.dumps(actions))

    def test_comments_failures_only_fail_comments_section(self):
        for status, body, error in ((403, {}, 'forbidden'), (200, {'comments': None}, 'invalid_response')):
            with self.subTest(error=error):
                code, result, transport = self.run_context(comments=(status, body, {}))
                self.assertEqual((code, result['status']), (0, 'partial'))
                sections = result['data']['sections']
                self.assertEqual(sections['comments']['state'], 'failed')
                self.assertEqual(sections['comments']['error']['code'], error)
                self.assertEqual(sections['structure']['state'], 'collected')
                self.assertEqual(sections['annotations']['state'], 'collected')
                self.assertEqual(len(transport.calls), 2)

    def test_missing_fields_are_collected_but_malformed_annotations_are_partial(self):
        body = payload()
        root = body['document']['children'][1]['children'][0]['children'][0]
        root.pop('annotations')
        root['children'][0].pop('annotations')
        code, result, _ = self.run_context(['--without-comments'], body)
        sections = result['data']['sections']
        self.assertEqual((code, result['status']), (0, 'ok'))
        for name, field in (('annotations', 'annotations'), ('prototype', 'interactions')):
            self.assertEqual(sections[name]['state'], 'collected')
            self.assertEqual(sections[name]['coverage']['nodes_without_' + field + '_field'], 2)
            self.assertIn('fields_not_returned', sections[name]['warnings'])
        root['annotations'] = None
        code, result, _ = self.run_context(['--without-comments'], body)
        self.assertEqual((code, result['status']), (0, 'partial'))
        self.assertEqual(result['data']['sections']['annotations']['state'], 'partial')

    def test_initial_metadata_and_independent_comment_timestamp_and_version(self):
        comments = comment_payload()
        comments['version'] = 'not-document-version'
        times = ['2026-01-01T01:00:00Z', '2026-01-01T02:00:00Z']
        with patch('figma_ops_core._utc', side_effect=times):
            code, result, _ = self.run_context(comments=(200, comments, {}))
        self.assertEqual(code, 0)
        sections = result['data']['sections']
        for name in ('structure', 'annotations', 'prototype'):
            self.assertEqual(sections[name]['fetched_at'], times[0])
            self.assertEqual(sections[name]['version'], 'v1')
        self.assertEqual(sections['comments']['fetched_at'], times[1])
        self.assertIsNone(sections['comments']['version'])

    def rich_payload(self):
        body = interaction_payload()
        root = body['document']['children'][1]['children'][0]
        child = root['children'][0]
        root['absoluteBoundingBox'] = {'x': 10, 'y': 20, 'width': 100, 'height': 200}
        child['absoluteBoundingBox'] = {'x': 1, 'y': 2, 'width': 3, 'height': 4}
        child['interactions'].append({'trigger': {'type': 'ON_HOVER'}, 'actions': [{'type': 'BACK'}]})
        return body

    def test_limits_are_per_list_keep_full_counts_and_replies_and_bbox_observation(self):
        comments = comment_payload()
        extra = copy.deepcopy(comments['comments'][0])
        extra['id'] = 'second-root'
        extra['created_at'] = '2026-01-01T04:00:00Z'
        comments['comments'].append(extra)
        body = self.rich_payload()
        original = copy.deepcopy(body)
        code, result, transport = self.run_context(['--scope-root', '2:0', '--limit', '1'], body,
                                                  (200, comments, {}))
        self.assertEqual(code, 0)
        sections = result['data']['sections']
        for name, collection, total in (('structure', 'texts', 2), ('structure', 'direct_children', 2),
                                        ('annotations', 'annotations', 3), ('prototype', 'interactions', 2),
                                        ('comments', 'threads', 2)):
            self.assertEqual(len(sections[name]['data'][collection]), 1)
            self.assertEqual(sections[name]['coverage']['collections'][collection],
                             {'total': total, 'returned': 1, 'truncated': True})
        self.assertEqual(len(sections['comments']['data']['threads'][0]['replies']), 2)
        self.assertEqual(len(result['data']['ancestors']), 3)
        self.assertEqual(sections['structure']['data']['direct_children'][0]['bbox'],
                         {'x': 1, 'y': 2, 'width': 3, 'height': 4})
        self.assertEqual(sections['annotations']['data']['annotations'][0]['properties'], [{'type': 'width'}])
        self.assertEqual(body, original)
        self.assertEqual(len(transport.calls), 2)
        self.assertEqual(sections['prototype']['data']['frontier'][0]['reason'], 'depth_limit')
        self.assertEqual(sections['prototype']['state'], 'partial')

    def test_output_saves_every_record_and_stdout_is_artifact_summary(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'context.json'
            comments = comment_payload()
            extra = copy.deepcopy(comments['comments'][0])
            extra.update(id='second-root', created_at='2026-01-01T04:00:00Z')
            comments['comments'].append(extra)
            code, summary, transport = self.run_context(['--scope-root', '2:0', '--limit', '1', '--output', str(output)],
                                                       self.rich_payload(), (200, comments, {}))
            self.assertEqual(code, 0)
            full = json.loads(output.read_text())
            self.assertEqual(summary['data'], {'artifact': str(output.resolve()), 'bytes': output.stat().st_size})
            for name, collection, total in (('structure', 'texts', 2), ('structure', 'direct_children', 2),
                                            ('annotations', 'annotations', 3), ('prototype', 'interactions', 2),
                                            ('comments', 'threads', 2)):
                self.assertEqual(len(full['data']['sections'][name]['data'][collection]), total)
                self.assertFalse(full['data']['sections'][name]['coverage']['collections'][collection]['truncated'])
            self.assertEqual(len(transport.calls), 2)

    def test_invalid_arguments_fail_before_get(self):
        for arguments in (['context', 'Key'], ['context', 'Key', '--scope-root', '2:0'],
                          ['context', TARGET, '--limit', '0'], ['context', TARGET, '--scope-root', '']):
            code, result, transport = invoke(arguments, [])
            self.assertEqual((code, result['error']['code']), (2, 'invalid_argument'))
            self.assertEqual(transport.calls, [])

    def test_raw_timing_warning_does_not_make_partial_without_frontier(self):
        body = self.rich_payload()
        node = body['document']['children'][1]['children'][0]['children'][0]
        node['interactions'] = [{'trigger': {'type': 'ON_CLICK'}, 'actions': [
            {'type': 'NODE', 'destinationId': None, 'navigation': 'CHANGE_TO',
             'transition': {'type': 'SMART_ANIMATE', 'duration': 0.2}}]}]
        code, result, transport = self.run_context(['--without-comments'], body)
        self.assertEqual((code, result['status']), (0, 'ok'))
        self.assertIn('timing_units_unverified', result['warnings'])
        self.assertEqual(result['data']['sections']['prototype']['state'], 'collected')
        self.assertEqual(len(transport.calls), 1)

    def test_context_does_not_mutate_loaded_response_or_comments_objects(self):
        import figma_ops as cli
        body, comments = self.rich_payload(), comment_payload()
        original = copy.deepcopy((body, comments))
        client = core.Client(token='synthetic-secret', no_cache=True)
        args = cli.build_parser().parse_args(['context', TARGET, '--scope-root', '2:0', '--limit', '1'])
        with patch.object(client, 'get_json', side_effect=[core.ApiResponse(body, 'source-time', 'hit'),
                                                          core.ApiResponse(comments, 'comments-time', 'hit')]):
            result = args.handler(args, client)
        self.assertEqual((body, comments), original)
        # Even consumer edits to projected raw records cannot corrupt cached inputs.
        result['data']['sections']['annotations']['data']['annotations'][0]['raw']['properties'].clear()
        result['data']['sections']['comments']['data']['threads'][0]['root']['client_meta'].clear()
        self.assertEqual((body, comments), original)
