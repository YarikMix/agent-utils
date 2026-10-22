"""CLI follow0 is exact, limits copies only and retains full output artifacts."""
import copy
import importlib
import json
from pathlib import Path
import tempfile
import unittest
from urllib.parse import parse_qs, urlsplit

from context_fixtures import interaction_payload, invoke
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
        self.assertEqual([len(result['data'][name]) for name in ('interactions', 'actions', 'edges', 'timings')], [1, 6, 2, 2])
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


if __name__ == '__main__':
    unittest.main()
