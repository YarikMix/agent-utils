"""Pure extraction preserves action evidence, order, paths and uncertain units."""
import copy
import importlib
import unittest

from context_fixtures import interaction_payload
from test_core import core
from figma_ops_scope import load_scope


def selected(body):
    return body['document']['children'][1]['children'][0]['children'][0]


def scope_for(body):
    class InMemoryClient:
        def get_json(self, path, params):
            return core.ApiResponse(body, '2026-01-01T00:00:00Z', 'bypass')
    return load_scope(InMemoryClient(), core.Target('Key', '2:1'))


class InteractionTests(unittest.TestCase):
    def extract(self, body):
        return importlib.import_module('figma_ops_interactions').extract_interactions(scope_for(body))

    def test_nested_actions_preserve_order_pointers_and_unverified_times(self):
        body = interaction_payload()
        original = copy.deepcopy(selected(body)['interactions'][0])
        result = self.extract(body)
        self.assertEqual([(e['destination_id'], e['action_path']) for e in result.data['edges']], [
            ('3:0', '/actions/0'), ('4:0', '/actions/1/conditionalBlocks/0/actions/1')])
        self.assertEqual(result.data['edges'][1]['condition_path'], '/actions/1/conditionalBlocks/0')
        self.assertEqual([a['raw']['type'] for a in result.data['actions']],
                         ['NODE', 'CONDITIONAL', 'SET_VARIABLE', 'NODE', 'BACK', 'NODE'])
        self.assertEqual(result.data['interactions'][0]['raw'], original)
        timing = result.data['timings'][0]
        self.assertEqual(timing['raw_value'], 0.2)
        self.assertEqual((timing['documented_unit'], timing['verified_unit'], timing['normalized_ms'], timing['unit_basis']),
                         ('ms', None, None, 'unverified'))
        self.assertEqual(result.data['edges'][0]['transition'], original['actions'][0]['transition'])
        self.assertEqual(result.data['interactions'][0]['node']['path'], ['Document', 'Page', 'Frame', 'Instance'])
        self.assertFalse(result.partial)
        self.assertNotIn('frontier', result.data)

    def test_provenance_is_relative_to_owning_node(self):
        result = self.extract(interaction_payload())
        self.assertEqual(result.data['edges'][1]['provenance'], {
            'source': 'figma-rest', 'file_key': 'Key', 'node_id': '2:1',
            'json_pointer': '/interactions/0/actions/1/conditionalBlocks/0/actions/1',
            'fetched_at': '2026-01-01T00:00:00Z', 'version': 'v1'})
        self.assertEqual(result.data['timings'][1]['raw_field'],
                         '/interactions/0/actions/1/conditionalBlocks/0/actions/1/transition/duration')

    def test_multiple_interactions_and_branch_blocks_keep_source_order(self):
        body = interaction_payload()
        interaction = selected(body)['interactions'][0]
        interaction['actions'][1]['conditionalBlocks'].append({'actions': [{'type': 'NODE', 'destinationId': '5:0'}]})
        selected(body)['interactions'].append({'trigger': {'type': 'ON_HOVER'}, 'actions': [{'type': 'CLOSE'}]})
        result = self.extract(body)
        self.assertEqual([e['destination_id'] for e in result.data['edges']], ['3:0', '4:0', '5:0'])
        self.assertEqual(result.data['edges'][2]['condition_path'], '/actions/1/conditionalBlocks/1')
        self.assertEqual([i['interaction_index'] for i in result.data['interactions']], [0, 1])
        self.assertEqual(result.data['actions'][-1]['interaction_index'], 1)

    def test_1200_nested_actions_do_not_use_python_recursion(self):
        body = interaction_payload()
        action = {'type': 'NODE', 'destinationId': 'deep'}
        for _ in range(1200):
            action = {'type': 'CONDITIONAL', 'conditionalBlocks': [{'actions': [action]}]}
        selected(body)['interactions'][0]['actions'] = [action]
        result = self.extract(body)
        self.assertEqual(len(result.data['actions']), 1201)
        self.assertEqual(result.data['edges'][0]['destination_id'], 'deep')
        self.assertEqual(result.data['edges'][0]['action_path'].count('/conditionalBlocks/0'), 1200)

    def test_timing_raw_values_units_and_escaped_pointers(self):
        body = interaction_payload()
        interaction = selected(body)['interactions'][0]
        interaction['trigger'] = {'type': 'AFTER_TIMEOUT', 'timeout': 0, 'delay': 200, 'mediaHitTime': 0.20000000298023224}
        interaction['actions'][0]['transition']['duration'] = 200
        interaction['actions'][0]['transition']['easing'] = {
            'type': 'CUSTOM_SPRING', 'easingFunctionSpring': {'mass': 1, 'stiffness': 100, 'damping': 10, 'initialVelocity': 0.125}}
        interaction['actions'][0]['future~/Time'] = 9.12345678912345
        result = self.extract(body)
        timings = {r['raw_field']: r for r in result.data['timings']}
        self.assertEqual(timings['/interactions/0/trigger/timeout']['raw_value'], 0)
        self.assertEqual(timings['/interactions/0/trigger/delay']['documented_unit'], 'ms')
        self.assertEqual(timings['/interactions/0/trigger/mediaHitTime']['documented_unit'], 's')
        self.assertEqual(timings['/interactions/0/trigger/mediaHitTime']['raw_value'], 0.20000000298023224)
        self.assertEqual(timings['/interactions/0/actions/0/future~0~1Time']['documented_unit'], None)
        self.assertEqual(timings['/interactions/0/actions/0/future~0~1Time']['raw_value'], 9.12345678912345)
        self.assertFalse(any('initialVelocity' in p for p in timings))
        for timing in timings.values():
            self.assertIsNone(timing['normalized_ms'])
            self.assertIsNone(timing['verified_unit'])
        self.assertEqual(result.data['edges'][0]['transition']['easing']['easingFunctionSpring']['initialVelocity'], 0.125)
        self.assertIn('timing_units_unverified', result.warnings)
        self.assertFalse(result.partial)

    def test_unknown_nested_timing_names_do_not_inherit_documented_units(self):
        body = interaction_payload()
        interaction = selected(body)['interactions'][0]
        action = interaction['actions'][0]
        action['futurePayload'] = {
            'transition': {'duration': 17}, 'trigger': {'timeout': 18, 'delay': 20},
            'mediaHitTime': 19, 'transitionDuration': 21,
            'actions': [{'type': 'NODE', 'transition': {'duration': 22}}]}
        action['transition']['futurePayload'] = {'duration': 23}
        selected(body)['transitionDuration'] = 24
        result = self.extract(body)
        timings = {record['raw_field']: record for record in result.data['timings']}
        expected = {
            '/interactions/0/actions/0/futurePayload/transition/duration': 17,
            '/interactions/0/actions/0/futurePayload/trigger/timeout': 18,
            '/interactions/0/actions/0/futurePayload/trigger/delay': 20,
            '/interactions/0/actions/0/futurePayload/mediaHitTime': 19,
            '/interactions/0/actions/0/futurePayload/transitionDuration': 21,
            '/interactions/0/actions/0/futurePayload/actions/0/transition/duration': 22,
            '/interactions/0/actions/0/transition/futurePayload/duration': 23}
        for field, raw_value in expected.items():
            with self.subTest(field=field):
                timing = timings[field]
                self.assertEqual(timing['raw_value'], raw_value)
                self.assertIsNone(timing['documented_unit'])
                self.assertIsNone(timing['verified_unit'])
                self.assertIsNone(timing['normalized_ms'])
                self.assertEqual(timing['unit_basis'], 'unverified')
        self.assertEqual(timings['/interactions/0/actions/0/transition/duration']['documented_unit'], 'ms')
        self.assertEqual(timings['/interactions/0/actions/1/conditionalBlocks/0/actions/1/transition/duration']['documented_unit'], 'ms')
        self.assertEqual(timings['/transitionDuration']['documented_unit'], 'ms')
        self.assertEqual(result.data['interactions'][0]['raw'], interaction)
        self.assertIn('timing_units_unverified', result.warnings)
        self.assertFalse(result.partial)

    def test_zero_duration_is_not_missing(self):
        body = interaction_payload()
        selected(body)['interactions'][0]['actions'][0]['transition']['duration'] = 0
        self.assertEqual(self.extract(body).data['timings'][0]['raw_value'], 0)

    def test_unknown_enums_preserve_raw_and_mark_partial(self):
        for location in ('action', 'trigger', 'navigation', 'transition', 'easing'):
            with self.subTest(location=location):
                body = interaction_payload()
                interaction = selected(body)['interactions'][0]
                action = interaction['actions'][0]
                target = {'action': action, 'trigger': interaction['trigger'], 'navigation': action,
                          'transition': action['transition'], 'easing': action['transition']['easing']}[location]
                target['navigation' if location == 'navigation' else 'type'] = 'FUTURE_ENUM'
                result = self.extract(body)
                self.assertTrue(result.partial)
                self.assertTrue(result.warnings)
                self.assertEqual(result.data['interactions'][0]['raw'], interaction)
                self.assertEqual(result.data['actions'][0]['raw'], action)

    def test_malformed_action_does_not_hide_valid_neighbors(self):
        body = interaction_payload()
        selected(body)['interactions'][0]['actions'] = [None, 7, {'type': 'NODE', 'destinationId': '3:0'}, {'type': 'NODE', 'destinationId': None}]
        result = self.extract(body)
        self.assertTrue(result.partial)
        self.assertEqual([a['raw'] for a in result.data['actions'][:2]], [None, 7])
        self.assertEqual([e['destination_id'] for e in result.data['edges']], ['3:0'])

    def test_missing_empty_and_null_have_distinct_coverage(self):
        for value, state, partial in [('missing', 'missing', False), ([], 'explicit-empty', False), (None, 'invalid', True)]:
            with self.subTest(value=value):
                body = interaction_payload()
                node = selected(body)
                node.pop('children')
                if value == 'missing':
                    node.pop('interactions')
                else:
                    node['interactions'] = value
                result = self.extract(body)
                self.assertEqual(result.coverage['interactions_field_state'], state)
                self.assertEqual(result.partial, partial)
                self.assertFalse(result.coverage['complete'])
                self.assertEqual(result.coverage['scanned_nodes'], 1)
                self.assertEqual(result.coverage['nodes_without_interactions_field'], int(state == 'missing'))
                self.assertEqual(result.coverage['nodes_with_interactions_field'], int(state != 'missing'))

    def test_legacy_only_is_evidence_without_fabricated_trigger_or_edge(self):
        body = interaction_payload()
        node = selected(body)
        node.pop('interactions')
        node.update(transitionNodeID='3:0', transitionDuration=0.2, transitionEasing='EASE_IN')
        result = self.extract(body)
        self.assertEqual(result.data['interactions'], [])
        self.assertEqual(result.data['edges'], [])
        self.assertEqual(result.data['legacy'][0]['raw'], {
            'transitionNodeID': '3:0', 'transitionDuration': 0.2, 'transitionEasing': 'EASE_IN'})
        self.assertNotIn('trigger', result.data['legacy'][0])
        self.assertEqual(result.data['timings'][0]['documented_unit'], 'ms')

    def test_modern_even_empty_takes_precedence_over_conflicting_legacy(self):
        for modern in ([], [{'trigger': {'type': 'ON_CLICK'}, 'actions': [{'type': 'NODE', 'destinationId': '4:0'}]}]):
            with self.subTest(modern=modern):
                body = interaction_payload()
                selected(body).update(interactions=modern, transitionNodeID='3:0', transitionDuration=200)
                result = self.extract(body)
                self.assertEqual([e['destination_id'] for e in result.data['edges']], ['4:0'] if modern else [])
                self.assertEqual(result.data['legacy'][0]['raw']['transitionNodeID'], '3:0')
                self.assertIn('legacy_interactions_conflict', result.warnings)

    def test_invalid_interactions_blocks_and_actions_are_partial_and_lossless(self):
        values = [None, {'trigger': None, 'actions': None}, {'trigger': {'type': 'ON_CLICK'}, 'actions': [
            {'type': 'CONDITIONAL', 'conditionalBlocks': [None, {'actions': 'bad'}, {'actions': [{'type': 'CLOSE'}]}]}]}]
        body = interaction_payload()
        selected(body)['interactions'] = values
        result = self.extract(body)
        self.assertTrue(result.partial)
        self.assertEqual([r['raw'] for r in result.data['interactions']], values)
        self.assertEqual(result.data['actions'][-1]['raw'], {'type': 'CLOSE'})


if __name__ == '__main__':
    unittest.main()
