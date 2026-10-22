"""CLI follow0 is exact, limits copies only and retains full output artifacts."""
import copy
import importlib
import json
from pathlib import Path
import tempfile
import subprocess
import unittest
from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch

from test_core import CurlBoundary, core

from context_fixtures import graph_payload, interaction_payload, invoke
from test_interactions import scope_for, selected


class PrototypeTests(unittest.TestCase):
    def test_follow0_reports_external_destinations_even_returned_dependencies(self):
        body = interaction_payload()
        body['document']['children'][0]['children'].append({'id': '3:0', 'type': 'FRAME', 'interactions': []})
        code, result, transport = invoke(['prototype', 'Key', '--node', '2-1'], [(200, body, {})])
        self.assertEqual((code, result['status']), (0, 'partial'))
        self.assertEqual(result['schema_version'], 1)
        self.assertEqual(result['version'], 'v1')
        self.assertEqual([(e['destination_id'], e['reason']) for e in result['data']['frontier']], [('3:0', 'depth_limit'), ('4:0', 'depth_limit')])
        self.assertEqual(result['coverage']['scanned_nodes'], 2)
        self.assertEqual(len(transport.calls), 1)
        self.assertEqual(parse_qs(urlsplit(transport.calls[0][0][-1]).query), {'ids': ['2:1']})

    def test_loaded_internal_destination_has_no_frontier_and_timing_warning_is_ok(self):
        body = interaction_payload()
        selected(body)['interactions'][0]['actions'][0]['destinationId'] = 'I2:1;3:1'
        selected(body)['interactions'][0]['actions'][1]['conditionalBlocks'][0]['actions'][1]['destinationId'] = '2:1'
        code, result, transport = invoke(['prototype', 'Key', '--node', '2:1'], [(200, body, {})])
        self.assertEqual((code, result['status']), (0, 'ok'))
        self.assertEqual(result['data']['frontier'], [])
        self.assertIn('timing_units_unverified', result['warnings'])
        self.assertFalse(result['coverage']['complete'])
        self.assertEqual(len(transport.calls), 1)

    def test_inline_limits_each_list_after_full_extraction(self):
        code, result, _ = invoke(['prototype', 'Key', '--node', '2:1', '--limit', '1'], [(200, interaction_payload(), {})])
        self.assertEqual(code, 0)
        for name, total in [('interactions', 1), ('actions', 6), ('edges', 2), ('timings', 2), ('legacy', 0), ('frontier', 2)]:
            counter = result['coverage']['collections'][name]
            self.assertEqual(counter, {'total': total, 'returned': min(total, 1), 'truncated': total > 1})
        self.assertEqual(len(result['data']['interactions'][0]['raw']['actions']), 4)
        self.assertEqual(len(result['data']['actions'][0]['raw']['transition']['easing']['easingFunctionCubicBezier']), 4)

    def test_output_limit_one_preserves_all_lists(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'prototype.json'
            code, summary, _ = invoke(['prototype', 'Key', '--node', '2:1', '--limit', '1', '--output', str(path)], [(200, interaction_payload(), {})])
            result = json.loads(path.read_text())
        self.assertEqual(code, 0)
        self.assertIn('artifact', summary['data'])
        self.assertEqual([len(result['data'][name]) for name in ('interactions', 'actions', 'edges', 'timings', 'frontier')], [1, 6, 2, 2, 2])
        self.assertFalse(any(counter['truncated'] for counter in result['coverage']['collections'].values()))

    def test_projection_does_not_mutate_payload_or_collection(self):
        body = interaction_payload()
        before = copy.deepcopy(body)
        extractor = importlib.import_module('figma_ops_interactions').extract_interactions
        projector = importlib.import_module('figma_ops_prototype').project_prototype
        collected = extractor(scope_for(body))
        projected = projector(collected, 1)
        self.assertEqual(body, before)
        self.assertEqual(len(collected.data['actions']), 6)
        self.assertEqual(len(projected.data['actions']), 1)
        self.assertNotIn('collections', collected.coverage)
        projected.data['interactions'][0]['raw']['trigger']['type'] = 'CHANGED'
        self.assertEqual(body, before)
        self.assertEqual(collected.data['interactions'][0]['raw']['trigger']['type'], 'ON_CLICK')

    def test_missing_empty_invalid_field_statuses(self):
        for value, status in [('missing', 'ok'), ([], 'ok'), (None, 'partial')]:
            with self.subTest(value=value):
                body = interaction_payload()
                node = selected(body)
                if value == 'missing':
                    node.pop('interactions')
                else:
                    node['interactions'] = value
                code, result, _ = invoke(['prototype', 'Key', '--node', '2:1'], [(200, body, {})])
                self.assertEqual((code, result['status']), (0, status))

    def test_invalid_arguments_are_rejected_before_network(self):
        for argv in (['prototype', 'Key'], ['prototype', 'Key', '--node', '2:1', '--limit', '0'],
                     ['prototype', 'Key', '--node', '2:1', '--limit', '-1']):
            with self.subTest(argv=argv):
                code, result, transport = invoke(argv, [])
                self.assertEqual((code, result['error']['code']), (2, 'invalid_argument'))
                self.assertEqual(transport.calls, [])


class PrototypeGraphTests(unittest.TestCase):
    """Catch unbounded/depth-first requests and dependency/failure data loss."""
    def requests(self, transport):
        queries = [parse_qs(urlsplit(call[0][-1]).query) for call in transport.calls]
        for query in queries:
            self.assertEqual(set(query), {'ids'})
        return [query['ids'][0] for query in queries]

    def diamond(self):
        return [(200, graph_payload(root, targets), {}) for root, targets in [
            ('2:1', ['3:0', '4:0']), ('3:0', ['5:0']),
            ('4:0', ['5:0']), ('5:0', ['2:1'])]]

    def run_graph(self, responses=None, *flags):
        return invoke(['prototype', 'Key', '--node', '2:1', *flags],
                      self.diamond() if responses is None else responses)

    def test_bfs_diamond_and_cycle_read_each_root_once(self):
        code, result, transport = self.run_graph(None, '--follow', '2')
        self.assertEqual((code, result['status']), (0, 'ok'))
        self.assertEqual(self.requests(transport), ['2:1', '3:0', '4:0', '5:0'])
        self.assertEqual([result['coverage'][key] for key in
                          ('requested_roots', 'successful_roots', 'failed_roots')], [4, 4, 0])
        self.assertEqual(result['data']['frontier'], [])
        self.assertEqual(result['coverage']['visited_ids'], ['2:1', '3:0', '4:0', '5:0'])
        observations = result['data']['observations']
        self.assertEqual([(o['requested_root_id'], o['depth'], o['state']) for o in observations],
                         [('2:1', 0, 'collected'), ('3:0', 1, 'collected'),
                          ('4:0', 1, 'collected'), ('5:0', 2, 'collected')])
        self.assertEqual(len(result['data']['edges']), 5)

    def test_follow_recomputes_field_state_from_source_and_destination_coverage(self):
        for field, expected_state, expected_invalid in ((None, 'invalid', 1),
                                                        ([], 'present', 0),
                                                        ('missing', 'present', 0)):
            with self.subTest(field=field):
                destination = graph_payload('3:0')
                node = destination['document']['children'][1]['children'][0]
                if field == 'missing':
                    node.pop('interactions')
                else:
                    node['interactions'] = field
                code, result, transport = self.run_graph([
                    (200, graph_payload('2:1', ['3:0']), {}), (200, destination, {})], '--follow', '1')
                self.assertEqual(self.requests(transport), ['2:1', '3:0'])
                self.assertEqual(result['coverage']['interactions_field_state'], expected_state)
                self.assertEqual(result['coverage']['nodes_with_invalid_interactions'], expected_invalid)
                self.assertEqual(result['coverage']['scanned_nodes'], 2)
                self.assertEqual((code, result['status']), (0, 'partial' if expected_invalid else 'ok'))
                self.assertEqual(result['data']['frontier'], [])
                if expected_invalid:
                    self.assertIn('invalid_interactions_field', result['warnings'])

    def test_follow0_only_reads_a_and_reports_depth_limit(self):
        _, result, transport = self.run_graph()
        self.assertEqual(self.requests(transport), ['2:1'])
        self.assertTrue(all('depth' in e and 'error' in e for e in result['data']['frontier']))
        self.assertEqual([(e['destination_id'], e['depth'], e['reason'], e['error'])
                          for e in result['data']['frontier']],
                         [('3:0', 1, 'depth_limit', None), ('4:0', 1, 'depth_limit', None)])

    def test_follow1_reads_a_b_c_and_leaves_d(self):
        _, result, transport = self.run_graph(None, '--follow', '1')
        self.assertEqual(self.requests(transport), ['2:1', '3:0', '4:0'])
        self.assertEqual([(e['destination_id'], e['depth'], e['reason'])
                          for e in result['data']['frontier']], [('5:0', 2, 'depth_limit')])
        self.assertEqual(len(result['data']['edges']), 4)

    def test_max_frames_one_only_reads_a(self):
        _, result, transport = self.run_graph(None, '--follow', '3', '--max-frames', '1')
        self.assertEqual(self.requests(transport), ['2:1'])
        self.assertEqual(result['coverage']['max_frames'], 1)
        self.assertEqual([e['reason'] for e in result['data']['frontier']], ['frame_limit', 'frame_limit'])

    def test_forbidden_attempt_consumes_second_slot_and_preserves_safe_error(self):
        responses = [self.diamond()[0], (403, {'err': 'private error'}, {})]
        _, result, transport = self.run_graph(responses, '--follow', '3', '--max-frames', '2')
        self.assertEqual(self.requests(transport), ['2:1', '3:0'])
        self.assertEqual([result['coverage'][key] for key in
                          ('requested_roots', 'successful_roots', 'failed_roots')], [2, 1, 1])
        self.assertEqual([(e['destination_id'], e['reason']) for e in result['data']['frontier']],
                         [('3:0', 'forbidden'), ('4:0', 'frame_limit')])
        error = result['data']['frontier'][0]['error']
        self.assertEqual((error['code'], error['http_status']), ('forbidden', 403))
        self.assertNotIn('private error', json.dumps(result))
        self.assertEqual(result['data']['observations'][1]['error'], error)

    def test_missing_destinations_each_consume_slot(self):
        responses = [(200, graph_payload('2:1', ['3:0', '4:0', '5:0']), {}),
                     (404, {}, {}), (200, graph_payload('8:0'), {})]
        _, result, transport = self.run_graph(responses, '--follow', '3', '--max-frames', '3')
        self.assertEqual(self.requests(transport), ['2:1', '3:0', '4:0'])
        self.assertEqual([result['coverage'][key] for key in
                          ('requested_roots', 'successful_roots', 'failed_roots')], [3, 1, 2])
        self.assertEqual([e['reason'] for e in result['data']['frontier']],
                         ['not_found_or_inaccessible', 'not_found_or_inaccessible', 'frame_limit'])

    def test_confirmed_loaded_dependency_expands_without_counting_neighbors(self):
        body = graph_payload('2:1', ['3:0'], dependencies=[('8:0', ['7:0']), ('3:0', ['4:0'])])
        for follow, expected, scanned, expanded in [('0', ['3:0'], 1, 0), ('1', ['4:0'], 2, 1)]:
            with self.subTest(follow=follow):
                _, result, transport = self.run_graph([(200, body, {})], '--follow', follow, '--max-frames', '1')
                self.assertEqual(self.requests(transport), ['2:1'])
                self.assertEqual([e['destination_id'] for e in result['data']['frontier']], expected)
                self.assertEqual(result['coverage']['scanned_nodes'], scanned)
                self.assertEqual(result['coverage']['expanded_from_loaded_nodes'], expanded)
                self.assertEqual(result['coverage']['requested_roots'], 1)

    def test_version_observations_do_not_change_initial_envelope_or_status(self):
        responses = [(200, graph_payload('2:1', ['3:0']), {}),
                     (200, graph_payload('3:0', version='v2'), {})]
        _, result, _ = self.run_graph(responses, '--follow', '1')
        self.assertEqual((result['status'], result['version']), ('ok', 'v1'))
        self.assertIn('document_versions_differ', result['warnings'])
        self.assertEqual([o['version'] for o in result['data']['observations']], ['v1', 'v2'])
        self.assertEqual(result['fetched_at'], result['data']['observations'][0]['fetched_at'])
        self.assertEqual([o['cache'] for o in result['data']['observations']], ['bypass', 'bypass'])

    def test_not_found_and_timeout_keep_a_and_c(self):
        for failure, reason in [((404, {}, {}), 'not_found_or_inaccessible'),
                                (subprocess.TimeoutExpired('synthetic', 40), 'network_error')]:
            with self.subTest(reason=reason):
                responses = [self.diamond()[0], failure, (200, graph_payload('4:0'), {})]
                code, result, transport = self.run_graph(responses, '--follow', '2')
                self.assertEqual((code, result['status']), (0, 'partial'))
                self.assertEqual(self.requests(transport), ['2:1', '3:0', '4:0'])
                self.assertEqual(result['coverage']['visited_ids'], ['2:1', '4:0'])
                self.assertEqual(result['data']['frontier'][0]['reason'], reason)

    def test_rate_limit_stops_network_and_preserves_retry_after(self):
        responses = [self.diamond()[0], (429, {}, {'Retry-After': '17'})]
        _, result, transport = self.run_graph(responses, '--follow', '3')
        self.assertEqual(self.requests(transport), ['2:1', '3:0'])
        self.assertEqual([e['reason'] for e in result['data']['frontier']], ['rate_limited', 'rate_limited'])
        self.assertEqual([e['error']['retry_after'] for e in result['data']['frontier']], ['17', '17'])
        self.assertEqual(result['coverage']['failed_roots'], 1)

    def test_initial_failure_remains_operational_error(self):
        code, result, transport = self.run_graph([(403, {}, {})], '--follow', '3')
        self.assertEqual((code, result['status'], result['error']['code']), (1, 'error', 'forbidden'))
        self.assertEqual(self.requests(transport), ['2:1'])

    def test_output_keeps_all_frontier_and_lists_without_raising_network_budget(self):
        flags = ('--follow', '2', '--max-frames', '3', '--limit', '1')
        _, inline, inline_transport = self.run_graph(None, *flags)
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'graph.json'
            code, _, output_transport = self.run_graph(None, *flags, '--output', str(path))
            self.assertEqual(code, 0)
            full = json.loads(path.read_text())
        self.assertEqual(code, 0)
        self.assertEqual(self.requests(inline_transport), ['2:1', '3:0', '4:0'])
        self.assertEqual(self.requests(output_transport), ['2:1', '3:0', '4:0'])
        self.assertEqual([(e['destination_id'], e['reason']) for e in full['data']['frontier']], [('5:0', 'frame_limit')])
        for key, total in [('interactions', 3), ('actions', 4), ('edges', 4), ('observations', 3), ('frontier', 1)]:
            self.assertEqual(len(full['data'][key]), total)
            self.assertEqual(inline['coverage']['collections'][key]['total'], total)
            self.assertEqual(len(inline['data'][key]), 1)

    def test_dependency_returned_by_destination_expands_without_new_slot(self):
        # B uses the final slot and returns C; D was already loaded with A.
        first = graph_payload('2:1', ['3:0', '4:0', '5:0'],
                              dependencies=[('5:0', ['2:1'])])
        second = graph_payload('3:0', dependencies=[('4:0', ['5:0'])])
        _, result, transport = self.run_graph([(200, first, {}), (200, second, {})],
                                             '--follow', '2', '--max-frames', '2')
        self.assertEqual(self.requests(transport), ['2:1', '3:0'])
        self.assertEqual(result['data']['frontier'], [])
        self.assertEqual(result['coverage']['expanded_from_loaded_nodes'], 2)
        self.assertEqual(result['coverage']['visited_ids'], ['2:1', '3:0', '4:0', '5:0'])

    def test_later_response_dependency_rescues_previously_deferred_root(self):
        # C is already loaded; D's later response makes failed B available.
        first = graph_payload('2:1', ['3:0', '4:0'], dependencies=[('4:0', ['5:0'])])
        second = graph_payload('5:0', dependencies=[('3:0', ['2:1'])])
        # The failed GET remains an observation, while the confirmed B edge
        # can be expanded from the returned dependency without another GET.
        responses = [(200, first, {}), (404, {}, {}), (200, second, {})]
        _, result, transport = self.run_graph(responses, '--follow', '3', '--max-frames', '3')
        self.assertEqual(self.requests(transport), ['2:1', '3:0', '5:0'])
        self.assertEqual(result['data']['frontier'], [])
        self.assertEqual(result['coverage']['scanned_nodes'], 4)
        self.assertEqual(result['coverage']['failed_roots'], 1)

    def test_overlapping_subtrees_and_duplicate_edges_preserve_first_rows(self):
        first = graph_payload('2:1', ['3:0', '3:0', '4:0'])
        b = graph_payload('3:0', ['2:1'])
        c = graph_payload('4:0')
        duplicate = copy.deepcopy(b['document']['children'][1]['children'][0])
        duplicate['interactions'][0]['actions'][0]['destinationId'] = '8:0'
        c['document']['children'][1]['children'][0]['children'] = [duplicate]
        c['version'] = 'v2'
        _, result, transport = self.run_graph([(200, first, {}), (200, b, {}), (200, c, {})], '--follow', '2')
        self.assertEqual(self.requests(transport), ['2:1', '3:0', '4:0'])
        self.assertEqual(result['data']['frontier'], [])
        self.assertEqual(result['coverage']['scanned_nodes'], 3)
        self.assertEqual(len(result['data']['interactions']), 2)
        b_actions = [row for row in result['data']['actions'] if row['source_node_id'] == '3:0']
        self.assertEqual(len(b_actions), 1)
        self.assertEqual(b_actions[0]['provenance']['version'], 'v1')
        self.assertEqual(b_actions[0]['raw']['destinationId'], '2:1')
        self.assertEqual(len(result['data']['observations']), 3)

    def test_rate_limit_still_expands_loaded_dependencies(self):
        first = graph_payload('2:1', ['3:0', '4:0'], dependencies=[('4:0', ['5:0'])])
        _, result, transport = self.run_graph([(200, first, {}), (429, {}, {'Retry-After': '9'})], '--follow', '2')
        self.assertEqual(self.requests(transport), ['2:1', '3:0'])
        self.assertEqual(result['coverage']['visited_ids'], ['2:1', '4:0'])
        self.assertEqual(result['coverage']['expanded_from_loaded_nodes'], 1)
        self.assertEqual([(item['destination_id'], item['reason']) for item in result['data']['frontier']],
                         [('3:0', 'rate_limited'), ('5:0', 'rate_limited')])

    def test_cache_hit_destination_still_spends_attempted_root_slot(self):
        prototype = importlib.import_module('figma_ops_prototype')
        scopes = importlib.import_module('figma_ops_scope')
        boundary = CurlBoundary([(200, graph_payload('3:0', ['4:0']), {}),
                                 (200, graph_payload('2:1', ['3:0']), {})])
        with tempfile.TemporaryDirectory() as temporary, patch('subprocess.run', boundary):
            client = core.Client(token='synthetic-secret', cache_dir=Path(temporary))
            client.get_json('files/Key', {'ids': '3:0'})
            scope = scopes.load_scope(client, core.Target('Key', '2:1'))
            result = prototype.collect_prototype(scope, client, follow=3, max_frames=2)
        self.assertEqual(self.requests(boundary), ['3:0', '2:1'])
        self.assertEqual(result.coverage['requested_roots'], 2)
        self.assertEqual(result.coverage['successful_roots'], 2)
        self.assertEqual([item['cache'] for item in result.data['observations']], ['miss', 'hit'])
        self.assertEqual([(item['destination_id'], item['reason']) for item in result.data['frontier']], [('4:0', 'frame_limit')])

    def test_rescued_dependency_schedules_shortest_depth_before_pending_deeper_edges(self):
        responses = [
            (200, graph_payload('2:1', ['3:0', '4:0']), {}), (404, {}, {}),
            (200, graph_payload('4:0', ['5:0']), {}),
            (200, graph_payload('5:0', ['6:0'], dependencies=[('3:0', ['6:0'])]), {}),
            (200, graph_payload('6:0', ['7:0']), {}),
            (200, graph_payload('7:0'), {})]
        code, result, transport = self.run_graph(responses, '--follow', '3')
        self.assertEqual((code, result['status']), (0, 'ok'))
        self.assertEqual(self.requests(transport), ['2:1', '3:0', '4:0', '5:0', '6:0', '7:0'])
        self.assertEqual(result['data']['frontier'], [])
        self.assertEqual([(o['requested_root_id'], o['depth']) for o in result['data']['observations']],
                         [('2:1', 0), ('3:0', 1), ('4:0', 1), ('5:0', 2), ('6:0', 2), ('7:0', 3)])
        self.assertEqual([result['coverage'][key] for key in
                          ('requested_roots', 'successful_roots', 'failed_roots', 'expanded_from_loaded_nodes')],
                         [6, 5, 1, 1])
        self.assertEqual(result['coverage']['scanned_nodes'], 6)
        self.assertEqual(len(result['data']['actions']), 6)
        self.assertEqual(len(result['data']['interactions']), 5)
        self.assertEqual(result['data']['observations'][1]['error']['code'], 'not_found_or_inaccessible')

    def test_shorter_path_reprocesses_already_collected_edges_without_duplicate_rows(self):
        responses = [
            (200, graph_payload('2:1', ['3:0', '4:0']), {}), (404, {}, {}),
            (200, graph_payload('4:0', ['5:0']), {}),
            (200, graph_payload('5:0', ['6:0', '8:0']), {}),
            (200, graph_payload('6:0', ['7:0'], version='first-e'), {}),
            (200, graph_payload('8:0', dependencies=[('3:0', ['6:0'])], version='later'), {}),
            (200, graph_payload('7:0'), {})]
        _, result, transport = self.run_graph(responses, '--follow', '3')
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(self.requests(transport), ['2:1', '3:0', '4:0', '5:0', '6:0', '8:0', '7:0'])
        self.assertEqual(result['data']['frontier'], [])
        self.assertEqual([result['coverage'][key] for key in
                          ('requested_roots', 'successful_roots', 'failed_roots', 'scanned_nodes')], [7, 6, 1, 7])
        self.assertEqual(len(result['data']['actions']), 7)
        self.assertEqual(len(result['data']['interactions']), 5)
        e_rows = [row for row in result['data']['actions'] if row['source_node_id'] == '6:0']
        self.assertEqual(len(e_rows), 1)
        self.assertEqual(e_rows[0]['provenance']['version'], 'first-e')
        e_observations = [item for item in result['data']['observations'] if item['requested_root_id'] == '6:0']
        self.assertEqual(len(e_observations), 1)
        self.assertEqual((e_observations[0]['version'], e_observations[0]['depth']), ('first-e', 3))
        self.assertEqual(result['data']['observations'][-1]['depth'], 3)

    def test_missing_requested_root_still_indexes_confirmed_dependency_from_valid_document(self):
        responses = [(200, graph_payload('2:1', ['3:0', '4:0']), {}),
                     (200, graph_payload('4:0', ['2:1'], version='dependency-response', dependencies=[('8:0', ['9:0'])]), {})]
        code, result, transport = self.run_graph(responses, '--follow', '1', '--max-frames', '2')
        self.assertEqual((code, result['status']), (0, 'partial'))
        self.assertEqual(self.requests(transport), ['2:1', '3:0'])
        self.assertEqual(result['coverage']['visited_ids'], ['2:1', '4:0'])
        self.assertEqual([result['coverage'][key] for key in
                          ('requested_roots', 'successful_roots', 'failed_roots', 'expanded_from_loaded_nodes')],
                         [2, 1, 1, 1])
        self.assertEqual([(item['destination_id'], item['reason']) for item in result['data']['frontier']],
                         [('3:0', 'not_found_or_inaccessible')])
        observation = result['data']['observations'][1]
        self.assertEqual((observation['requested_root_id'], observation['state'], observation['version']),
                         ('3:0', 'failed', 'dependency-response'))
        self.assertEqual(observation['error']['code'], 'not_found_or_inaccessible')
        self.assertEqual(result['coverage']['scanned_nodes'], 2)
        self.assertEqual(len(result['data']['actions']), 3)
        c_rows = [row for row in result['data']['actions'] if row['source_node_id'] == '4:0']
        self.assertEqual(len(c_rows), 1)
        self.assertEqual(c_rows[0]['provenance']['version'], 'dependency-response')

    def test_invalid_traversal_flags_are_rejected_before_transport(self):
        for flag, value in [('--follow', '-1'), ('--follow', '4'),
                            ('--max-frames', '0'), ('--max-frames', '51')]:
            with self.subTest(flag=flag, value=value):
                code, result, transport = self.run_graph([], flag, value)
                self.assertEqual((code, result['error']['code']), (2, 'invalid_argument'))
                self.assertEqual(transport.calls, [])


if __name__ == '__main__':
    unittest.main()
