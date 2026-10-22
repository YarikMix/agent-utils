"""Full-thread semantics with synthetic discussion data and a fake curl boundary."""
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from test_core import CurlBoundary, core
from test_nodes import document
import figma_ops as cli
from figma_ops_comments import load_threads, select_threads


def comment(cid, parent='', message='', author='A', created='2026-01-01T10:00:00Z',
            resolved=None, meta=None):
    return {'id': cid, 'parent_id': parent, 'message': message,
            'user': {'id': author, 'handle': author, 'img_url': 'https://example.invalid/avatar'},
            'created_at': created, 'resolved_at': resolved,
            'client_meta': meta if meta is not None else {'node_id': '2:2', 'node_offset': {'x': 1, 'y': 2}},
            'file_key': 'Key', 'order_id': '1'}


def discussion():
    return {'comments': [
        comment('12', '10', 'Straße reply', 'B', '2026-01-01T10:02:00Z'),
        comment('20', message='Sibling', meta={'node_id': '2:5'}),
        comment('10', message='Root'),
        comment('11', '10', 'Earlier', 'C', '2026-01-01T10:01:00Z'),
        comment('30', message='Done', resolved='2026-01-02T11:00:00Z', meta={'node_id': '2:3'}),
        comment('40', message='Coordinate only', meta={'x': 10, 'y': 20}),
        comment('50', message='Detached', meta={})]}


class CommentTests(unittest.TestCase):
    def setUp(self):
        self.payload = discussion()
        self.boundary = CurlBoundary([(200, self.payload, {})])
        patch('subprocess.run', self.boundary).start()
        self.addCleanup(patch.stopall)
        self.client = core.Client(token='synthetic-secret', no_cache=True)

    def invoke(self, argv):
        out = io.StringIO()
        with patch.object(cli, 'Client', return_value=self.client), redirect_stdout(out):
            code = cli.main(argv + ['--no-cache'])
        return code, json.loads(out.getvalue())

    def test_query_in_reply_returns_root_and_every_reply_sorted(self):
        code, result = self.invoke(['comments', 'Key', '--query', 'STRASSE'])
        self.assertEqual(code, 0)
        thread = result['data']['threads'][0]
        self.assertEqual(thread['root']['id'], '10')
        self.assertEqual([r['id'] for r in thread['replies']], ['11', '12'])
        reply = thread['replies'][1]
        self.assertEqual(reply['author']['handle'], 'B')
        self.assertEqual(reply['created_at'], '2026-01-01T10:02:00Z')
        self.assertEqual(reply['parent_id'], '10')
        self.assertEqual(reply['resolved_at'], None)
        self.assertEqual(reply['message'], 'Straße reply')
        self.assertEqual(reply['client_meta'], {'node_id': '2:2', 'node_offset': {'x': 1, 'y': 2}})
        self.assertEqual(result['coverage']['total_comments'], 7)
        self.assertEqual(result['coverage']['total_threads'], 5)
        self.assertEqual(result['coverage']['matched_threads'], 1)
        self.assertEqual(result['coverage']['returned_threads'], 1)
        self.assertFalse(result['coverage']['truncated'])
        self.assertEqual(len(self.boundary.calls), 1)
        self.assertEqual(urlsplit(self.boundary.calls[0][0][-1]).path, '/v1/files/Key/comments')
        self.assertEqual(result['cache'], 'bypass')
        self.assertTrue(result['fetched_at'].endswith('Z'))

    def test_author_reply_match_uses_handle_literal_casefold(self):
        self.payload['comments'][0]['user']['handle'] = 'Straße'
        code, result = self.invoke(['comments', 'Key', '--author', 'STRASSE'])
        self.assertEqual(code, 0)
        self.assertEqual(result['data']['threads'][0]['root']['id'], '10')
        self.assertEqual(len(result['data']['threads'][0]['replies']), 2)

    def test_status_comes_from_root_and_limit_counts_threads(self):
        self.payload['comments'][0]['resolved_at'] = '2026-01-02T11:00:00Z'
        code, result = self.invoke(['comments', 'Key', '--status', 'open', '--limit', '1'])
        self.assertEqual(code, 0)
        self.assertEqual(result['coverage']['matched_threads'], 4)
        self.assertEqual(result['coverage']['returned_threads'], 1)
        self.assertTrue(result['coverage']['truncated'])
        self.assertEqual(len(result['data']['threads'][0]['replies']), 2)

    def test_resolved_filter_returns_resolved_root(self):
        code, result = self.invoke(['comments', 'Key', '--status', 'resolved'])
        self.assertEqual(code, 0)
        self.assertEqual([t['root']['id'] for t in result['data']['threads']], ['30'])

    def test_thread_root_or_reply_id_resolves_full_branch_without_file_content(self):
        for cid in ('10', '12'):
            with self.subTest(cid=cid):
                if cid == '12':
                    self.boundary.responses.append((200, self.payload, {}))
                code, result = self.invoke(['thread', 'https://figma.com/design/Key/Test?node-id=99-9', '--comment', cid])
                self.assertEqual(code, 0)
                self.assertEqual(result['data']['thread']['root']['id'], '10')
                self.assertEqual([r['id'] for r in result['data']['thread']['replies']], ['11', '12'])
        self.assertEqual(len(self.boundary.calls), 2)
        self.assertTrue(all(urlsplit(call[0][-1]).path.endswith('/comments') for call in self.boundary.calls))

    def test_unknown_comment_is_error(self):
        code, result = self.invoke(['thread', 'Key', '--comment', '999'])
        self.assertEqual(code, 1)
        self.assertEqual(result['error']['code'], 'not_found_or_inaccessible')

    def test_orphan_replies_visible_as_partial_thread(self):
        self.payload['comments'].append(comment('91', '90', 'Orphan', 'O'))
        code, result = self.invoke(['comments', 'Key', '--query', 'orphan'])
        self.assertEqual(code, 0)
        self.assertEqual(result['status'], 'partial')
        thread = result['data']['threads'][0]
        self.assertEqual(thread['root'], None)
        self.assertTrue(thread['orphan'])
        self.assertEqual(thread['root_id'], '90')
        self.assertEqual([r['id'] for r in thread['replies']], ['91'])
        self.assertTrue(result['warnings'])

    def test_thread_by_orphan_reply_is_partial(self):
        self.payload['comments'].append(comment('91', '90', 'Orphan', 'O'))
        code, result = self.invoke(['thread', 'Key', '--comment', '91'])
        self.assertEqual(code, 0)
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(result['data']['thread']['root'], None)

    def test_node_filter_uses_exact_subtree_excludes_sibling_and_counts_unassigned(self):
        self.boundary.responses.append((200, document(), {}))
        code, result = self.invoke(['comments', 'https://figma.com/design/Key/Test?node-id=2-2'])
        self.assertEqual(code, 0)
        self.assertEqual([t['root']['id'] for t in result['data']['threads']], ['10', '30'])
        self.assertEqual(result['coverage']['scope'], {'kind': 'node-and-descendants', 'node_id': '2:2'})
        self.assertEqual(result['coverage']['unassigned_count'], 2)
        self.assertEqual(result['coverage']['matched_threads'], 2)
        self.assertTrue(result['warnings'])
        query = parse_qs(urlsplit(self.boundary.calls[1][0][-1]).query)
        self.assertEqual(query, {'ids': ['2:2']})

    def test_reply_pin_does_not_reassign_thread_from_sibling_root(self):
        self.payload['comments'][2]['client_meta'] = {'node_id': '2:5'}
        self.boundary.responses.append((200, document(), {}))
        code, result = self.invoke(['comments', 'Key', '--node', '2:2'])
        self.assertEqual(code, 0)
        self.assertEqual([t['root']['id'] for t in result['data']['threads']], ['30'])

    def test_deleted_node_is_error_and_empty_node_fails_before_network(self):
        code, result = self.invoke(['comments', 'Key', '--node', ''])
        self.assertEqual(code, 2)
        self.assertEqual(self.boundary.calls, [])
        self.boundary.responses.append((200, document(), {}))
        code, result = self.invoke(['comments', 'Key', '--node', '99:9'])
        self.assertEqual(code, 1)
        self.assertEqual(result['error']['code'], 'not_found_or_inaccessible')

    def test_equal_timestamps_tie_break_by_stable_id(self):
        self.payload['comments'][0]['created_at'] = '2026-01-01T10:01:00Z'
        code, result = self.invoke(['thread', 'Key', '--comment', '10'])
        self.assertEqual(code, 0)
        self.assertEqual([r['id'] for r in result['data']['thread']['replies']], ['11', '12'])

    def test_fractional_timestamps_sort_chronologically(self):
        self.payload['comments'][0]['created_at'] = '2026-01-01T10:01:00.100Z'
        code, result = self.invoke(['thread', 'Key', '--comment', '10'])
        self.assertEqual(code, 0)
        self.assertEqual([r['id'] for r in result['data']['thread']['replies']], ['11', '12'])

    def test_default_limit_is_twenty_threads_and_no_reply_truncation(self):
        self.payload['comments'] += [comment(str(i), message='Extra') for i in range(100, 121)]
        code, result = self.invoke(['comments', 'Key'])
        self.assertEqual(code, 0)
        self.assertEqual(result['coverage']['total_threads'], 26)
        self.assertEqual(result['coverage']['returned_threads'], 20)
        self.assertTrue(result['coverage']['truncated'])

    def test_output_artifact_preserves_all_threads_despite_inline_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'comments.json'
            code, summary = self.invoke(['comments', 'Key', '--limit', '1', '--output', str(output)])
            self.assertEqual(code, 0)
            full = json.loads(output.read_text())
            self.assertEqual([thread['root']['id'] for thread in full['data']['threads']],
                             ['10', '20', '30', '40', '50'])
            self.assertEqual([reply['id'] for reply in full['data']['threads'][0]['replies']],
                             ['11', '12'])
            self.assertEqual(full['coverage']['matched_threads'], 5)
            self.assertEqual(full['coverage']['returned_threads'], 5)
            self.assertFalse(full['coverage']['truncated'])
            self.assertEqual(summary['data'], {'artifact': str(output.resolve()),
                                              'bytes': output.stat().st_size})
            self.assertEqual(summary['coverage'], full['coverage'])

    def test_invalid_filters_fail_before_network(self):
        for argv in (['comments', 'Key', '--limit', '0'], ['comments', 'Key', '--status', 'bad'],
                     ['thread', 'Key'], ['thread', 'Key', '--comment', ''],
                     ['comments', 'Key', '--query', ''], ['comments', 'Key', '--author', '']):
            with self.subTest(argv=argv):
                code, result = self.invoke(argv)
                self.assertEqual(code, 2)
                self.assertEqual(result['error']['code'], 'invalid_argument')
        self.assertEqual(self.boundary.calls, [])


class PureSelectionTests(unittest.TestCase):
    def load(self, body):
        transport = CurlBoundary([(200, body, {})])
        with patch('subprocess.run', transport):
            response, threads, count = load_threads(core.Client(token='synthetic-secret', no_cache=True),
                                                    core.parse_target('Key'))
        self.assertEqual(len(transport.calls), 1)
        self.assertEqual(count, len(body['comments']))
        return threads

    def test_reply_query_keeps_full_thread_without_node_scope(self):
        selected = select_threads(self.load(discussion()), query='STRASSE')
        self.assertEqual(selected.data['threads'][0]['root']['id'], '10')
        self.assertEqual([r['id'] for r in selected.data['threads'][0]['replies']], ['11', '12'])
        self.assertEqual(selected.coverage['total_threads'], 5)
        self.assertEqual(selected.coverage['matched_threads'], 1)
        self.assertEqual(selected.coverage['unassigned_count'], 2)
        self.assertFalse(selected.partial)

    def test_scope_uses_root_pin_and_counts_orphan_unassigned(self):
        body = discussion()
        body['comments'][2]['client_meta'] = {'node_id': '2:5'}
        body['comments'].append(comment('91', '90', 'Orphan'))
        selected = select_threads(self.load(body), node_ids={'2:2', '2:3'})
        self.assertEqual([t['root']['id'] for t in selected.data['threads']], ['30'])
        self.assertEqual(selected.coverage['unassigned_count'], 3)
        self.assertTrue(selected.partial)
        self.assertTrue(selected.warnings)

    def test_file_scope_keeps_unassigned_threads_and_root_status(self):
        selected = select_threads(self.load(discussion()))
        self.assertEqual(selected.coverage['matched_threads'], 5)
        resolved = select_threads(selected.data['threads'], status='resolved')
        self.assertEqual([t['root']['id'] for t in resolved.data['threads']], ['30'])
