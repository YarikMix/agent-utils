"""Pure exact binding observations, container boundaries and iterative traversal."""
import copy
import unittest

from bindings_fixtures import bindings_payload, library_payload, loaded_scope
from figma_ops_bindings import extract_bindings, observed_collection_ids, referenced_variable_ids
from figma_ops_library import extract_library


def alias(reference):
    return {'type': 'VARIABLE_ALIAS', 'id': reference}


class BindingsTests(unittest.TestCase):
    def test_nested_binding_pointers_preserve_alias_shape_and_raw(self):
        scope = loaded_scope(bindings_payload())
        result = extract_bindings(scope)
        row = next(row for row in result.data['variable_bindings'] if row['reference_id'] == 'v.color')
        self.assertEqual(row['provenance']['json_pointer'], '/fills/0/boundVariables/color')
        self.assertEqual(row['definition_state'], 'not_requested')
        self.assertEqual(row['raw_container'], scope.source['fills'][0]['boundVariables'])
        self.assertEqual(row['raw'], alias('v.color'))
        self.assertEqual(row['container_pointer'], '/fills/0/boundVariables')
        self.assertEqual(row['container_role'], 'paint')
        self.assertEqual(row['node']['id'], '2:1')
        self.assertEqual(row['provenance']['pointer_basis'], 'node')

    def test_known_openapi_wrappers_and_containers_are_not_partial(self):
        result = extract_bindings(loaded_scope(bindings_payload()))
        self.assertFalse(result.partial, result.warnings)
        self.assertEqual(referenced_variable_ids(result), [
            'v.property', 'v.width', 'v.height', 'v.top', 'v.bottom', 'v.left', 'v.right', 'v.label',
            'v.font', 'v.fill', 'v.range', 'v.color', 'v.stop', 'v.stroke', 'v.background',
            'v.backgrounds', 'v.effect', 'v.grid', 'v.style', 'v.override'])
        self.assertEqual(len(result.data['variable_bindings']), 20)

    def test_full_property_keys_are_escaped_without_normalizing_ids(self):
        scope = loaded_scope(bindings_payload())
        scope.source['boundVariables']['componentProperties']['Label/~#prop'] = alias('VariableID:1:2/3~4;I5:6')
        result = extract_bindings(scope)
        row = next(r for r in result.data['variable_bindings'] if r['reference_id'] == 'VariableID:1:2/3~4;I5:6')
        self.assertEqual(row['reference_id'], 'VariableID:1:2/3~4;I5:6')
        self.assertEqual(row['provenance']['json_pointer'], '/boundVariables/componentProperties/Label~1~0#prop')
        override = next(r for r in result.data['variable_bindings'] if r['reference_id'] == 'v.override')
        self.assertEqual(override['provenance']['json_pointer'], '/styleOverrideTable/1~1~0/boundVariables/fontSize')

    def test_documented_wrapper_keys_id_and_type_do_not_hide_alias_neighbors(self):
        for wrapper in ('componentProperties', 'size', 'individualStrokeWeights'):
            with self.subTest(wrapper=wrapper):
                scope = loaded_scope(source_id='2:2', root_id='2:2')
                neighbor = 'Label#prop' if wrapper == 'componentProperties' else 'x' if wrapper == 'size' else 'top'
                raw = {'id': alias('v.id'), 'type': alias('v.type'), neighbor: alias('v.neighbor')}
                scope.root['boundVariables'] = {wrapper: raw}
                result = extract_bindings(scope)
                self.assertEqual(referenced_variable_ids(result), ['v.id', 'v.type', 'v.neighbor'])
                self.assertEqual(len(result.data['variable_bindings']), 3)
                self.assertEqual([row['provenance']['json_pointer'] for row in result.data['variable_bindings']],
                                 ['/boundVariables/' + wrapper + '/id',
                                  '/boundVariables/' + wrapper + '/type',
                                  '/boundVariables/' + wrapper + '/' + neighbor])
                self.assertEqual(result.data['variable_bindings'][0]['raw_container'],
                                 {wrapper: raw})
                self.assertEqual(result.partial, wrapper != 'componentProperties')

    def test_malformed_documented_wrapper_member_does_not_hide_valid_neighbor(self):
        scope = loaded_scope(source_id='2:2', root_id='2:2')
        scope.root['boundVariables'] = {'componentProperties': {'id': None, 'type': False,
                                                              'Label#prop': alias('v.label')}}
        result = extract_bindings(scope)
        self.assertTrue(result.partial)
        self.assertEqual(referenced_variable_ids(result), ['v.label'])
        self.assertEqual([row['raw'] for row in result.data['variable_bindings']],
                         [None, False, alias('v.label')])

    def test_malformed_alias_neighbors_are_preserved_without_false_references(self):
        scope = loaded_scope(root_id='2:1')
        scope.source['boundVariables'] = {'valid': alias('v.good'), 'id': alias([]),
                                          'null': None, 'zero': 0, 'false': False, 'empty': '',
                                          'unknown': {'type': 'NEW_ALIAS', 'id': 'fake'}}
        result = extract_bindings(scope)
        self.assertTrue(result.partial)
        self.assertEqual(referenced_variable_ids(result), ['v.good'])
        rows = result.data['variable_bindings']
        self.assertEqual(len(rows), 7)
        self.assertEqual([r['raw'] for r in rows], [alias('v.good'), alias([]), None, 0, False, '',
                                                 {'type': 'NEW_ALIAS', 'id': 'fake'}])
        self.assertTrue(all(r['reference_id'] is None for r in rows[1:]))

    def test_present_empty_missing_invalid_binding_fields(self):
        for present, raw, expected, partial in [(False, None, 'absent', False),
                                               (True, {}, 'empty', False), (True, None, 'invalid', True)]:
            with self.subTest(expected=expected):
                scope = loaded_scope(source_id='2:2', root_id='2:2')
                if present:
                    scope.root['boundVariables'] = raw
                result = extract_bindings(scope)
                self.assertEqual(result.coverage['fields']['boundVariables'][expected], 1)
                self.assertEqual(sum(result.coverage['fields']['boundVariables'].values()), 1)
                self.assertEqual(result.partial, partial)
                self.assertEqual(len(result.data['variable_bindings']), 1 if partial else 0)
                if partial:
                    self.assertIsNone(result.data['variable_bindings'][0]['raw'])
                    self.assertEqual(result.data['variable_bindings'][0]['provenance']['json_pointer'], '/boundVariables')

    def test_alias_looking_external_payload_is_not_binding(self):
        scope = loaded_scope(bindings_payload())
        for key in ('pluginData', 'annotations', 'interactions', 'future'):
            scope.source[key] = {'boundVariables': {'color': alias('fake')}, 'alias': alias('fake')}
        result = extract_bindings(scope)
        self.assertNotIn('fake', referenced_variable_ids(result))
        self.assertFalse(result.partial, result.warnings)

    def test_unknown_nesting_remains_raw_with_unknown_role(self):
        scope = loaded_scope()
        raw = {'future': {'effects': [{'boundVariables': {'radius': alias('v.unknown')}}]}}
        scope.source['fills'] = [raw]
        result = extract_bindings(scope)
        self.assertTrue(result.partial)
        self.assertEqual(len(result.data['variable_bindings']), 1)
        row = result.data['variable_bindings'][0]
        self.assertEqual(row['container_role'], 'unknown')
        self.assertEqual(row['raw_container'], {'radius': alias('v.unknown')})
        self.assertEqual(row['provenance']['json_pointer'], '/fills/0/future/effects/0/boundVariables/radius')
        self.assertTrue(any('unknown_binding_container' in warning for warning in result.warnings))

    def test_unknown_binding_wrapper_preserves_neighbor_and_raw(self):
        scope = loaded_scope()
        scope.source['boundVariables'] = {'known': alias('v.good'), 'future': {'nested': alias('v.future')}}
        result = extract_bindings(scope)
        self.assertTrue(result.partial)
        self.assertEqual(referenced_variable_ids(result), ['v.good', 'v.future'])
        row = result.data['variable_bindings'][1]
        self.assertEqual(row['container_role'], 'unknown')
        self.assertEqual(row['raw_container'], scope.source['boundVariables'])

    def test_modes_are_observations_not_effective_resolution(self):
        result = extract_bindings(loaded_scope(bindings_payload()))
        self.assertEqual(observed_collection_ids(result), ['c'])
        rows = result.data['mode_observations']
        self.assertEqual([(r['node']['id'], r['mode_id'], r['location']) for r in rows], [
            ('1:0', 'c:dark', 'ancestor'), ('2:0', 'c:light', 'scope'),
            ('2:1', 'c:contrast', 'scope'), ('I2:1;3:1', 'c:text', 'scope')])
        self.assertEqual(result.coverage['scanned_nodes'], 4)
        self.assertTrue(all('effective_mode' not in r and 'resolved_value' not in r for r in rows))
        self.assertEqual(rows[0]['provenance']['json_pointer'], '/explicitVariableModes/c')
        self.assertEqual(rows[0]['raw'], 'c:dark')

    def test_exact_root_ancestor_modes_are_not_scanned_or_duplicated(self):
        result = extract_bindings(loaded_scope(bindings_payload(), root_id='2:1'))
        self.assertEqual(result.coverage['scanned_nodes'], 2)
        self.assertEqual([(r['node']['id'], r['location']) for r in result.data['mode_observations']],
                         [('1:0', 'ancestor'), ('2:0', 'ancestor'), ('2:1', 'scope'), ('I2:1;3:1', 'scope')])

    def test_mode_field_counters_describe_scope_nodes_without_ancestor_observations(self):
        for ancestor_value in ('absent', {}, {'c': 'mode'}, None):
            with self.subTest(ancestor_value=ancestor_value):
                scope = loaded_scope(source_id='2:2', root_id='2:2')
                self.assertEqual(len(scope.root_ancestors), 3)
                if ancestor_value != 'absent':
                    for ancestor in scope.root_ancestors:
                        ancestor['explicitVariableModes'] = ancestor_value
                result = extract_bindings(scope)
                self.assertEqual(result.coverage['scanned_nodes'], 1)
                self.assertEqual(result.coverage['fields']['explicitVariableModes'],
                                 {'absent': 1, 'empty': 0, 'present': 0, 'invalid': 0})
                self.assertEqual(sum(result.coverage['fields']['explicitVariableModes'].values()),
                                 result.coverage['scanned_nodes'])
                rows = result.data['mode_observations']
                self.assertEqual(len(rows), 3 if ancestor_value in (None, {'c': 'mode'}) else 0)
                self.assertTrue(all(row['location'] == 'ancestor' for row in rows))
                self.assertEqual(result.partial, ancestor_value is None)

    def test_malformed_mode_maps_keep_neighbors_and_exact_collection_ids(self):
        scope = loaded_scope()
        scope.root['explicitVariableModes'] = {'c/~:1': 'Mode:1;2', 'broken': None, '': 'fake', 'bad': []}
        scope.source['explicitVariableModes'] = None
        result = extract_bindings(scope)
        self.assertTrue(result.partial)
        self.assertEqual(observed_collection_ids(result), ['c/~:1', 'broken', 'bad'])
        rows = result.data['mode_observations']
        self.assertEqual(len(rows), 5)
        self.assertEqual(rows[0]['provenance']['json_pointer'], '/explicitVariableModes/c~1~0:1')
        self.assertEqual(rows[0]['mode_id'], 'Mode:1;2')
        self.assertIsNone(rows[-1]['raw'])
        self.assertIsNone(rows[-1]['collection_id'])

    def test_invalid_property_containers_keep_raw_evidence(self):
        for key in ('fills', 'strokes', 'background', 'backgrounds', 'effects', 'layoutGrids', 'style', 'styleOverrideTable'):
            with self.subTest(key=key):
                scope = loaded_scope(source_id='2:2', root_id='2:2')
                scope.root[key] = None
                result = extract_bindings(scope)
                self.assertTrue(result.partial)
                self.assertEqual(result.coverage['fields'][key]['invalid'], 1)
                row = result.data['variable_bindings'][0]
                self.assertIsNone(row['raw'])
                self.assertIsNone(row['reference_id'])
                self.assertEqual(row['provenance']['json_pointer'], '/' + key)

    def test_deep_alias_container_and_tree_are_iterative(self):
        scope = loaded_scope(source_id='2:2', root_id='2:2')
        node = scope.root
        for i in range(1200):
            child = {'id': 'deep:' + str(i), 'type': 'FRAME', 'name': 'Deep'}
            node['children'] = [child]
            node = child
        container = {'boundVariables': {'color': alias('v.deep')}}
        for _ in range(1200):
            container = {'nested': container}
        node['fills'] = [container]
        result = extract_bindings(scope)
        self.assertEqual(referenced_variable_ids(result), ['v.deep'])
        self.assertEqual(len(result.data['variable_bindings']), 1)
        self.assertEqual(result.coverage['scanned_nodes'], 1201)

    def test_library_coverage_and_collections_are_retained_without_double_counting(self):
        scope = loaded_scope(bindings_payload())
        library = extract_library(scope)
        result = extract_bindings(scope)
        self.assertEqual(set(result.data), {'instances', 'components', 'component_sets', 'style_usages', 'styles',
                                           'variable_bindings', 'mode_observations'})
        self.assertEqual(result.coverage['scanned_nodes'], library.coverage['scanned_nodes'])
        for key in ('metadata', 'definitions'):
            self.assertEqual(result.coverage[key], library.coverage[key])
        self.assertEqual(result.coverage['fields']['componentProperties'],
                         {'absent': 2, 'empty': 1, 'present': 1, 'invalid': 0})
        for key, rows in library.data.items():
            self.assertEqual(result.data[key], rows)
        self.assertEqual(result.coverage['collections']['variable_bindings'], {'total': 20, 'returned': 20, 'truncated': False})

    def test_binding_properties_follow_source_order_not_a_fixed_catalog(self):
        scope = loaded_scope(source_id='2:2', root_id='2:2')
        scope.root['effects'] = [{'boundVariables': {'radius': alias('v.effect')}}]
        scope.root['boundVariables'] = {'size': {'y': alias('v.y'), 'x': alias('v.x')}}
        scope.root['fills'] = [{'boundVariables': {'color': alias('v.paint')}}]
        self.assertEqual(referenced_variable_ids(extract_bindings(scope)),
                         ['v.effect', 'v.y', 'v.x', 'v.paint'])

    def test_malformed_known_nested_containers_are_raw_partial(self):
        for field, raw, pointer in [
                ('fills', [None], '/fills/0'),
                ('effects', [0], '/effects/0'),
                ('layoutGrids', [''], '/layoutGrids/0'),
                ('styleOverrideTable', {'0': None}, '/styleOverrideTable/0'),
                ('componentProperties', {'Label': False}, '/componentProperties/Label'),
                ('fills', [{'gradientStops': None}], '/fills/0/gradientStops')]:
            with self.subTest(field=field, raw=raw):
                scope = loaded_scope(source_id='2:2', root_id='2:2')
                scope.root[field] = raw
                result = extract_bindings(scope)
                self.assertTrue(result.partial)
                self.assertEqual(len(result.data['variable_bindings']), 1)
                row = result.data['variable_bindings'][0]
                self.assertEqual(row['provenance']['json_pointer'], pointer)
                self.assertIsNone(row['reference_id'])
                self.assertEqual(referenced_variable_ids(result), [])

    def test_nested_property_bindings_follow_source_order(self):
        scope = loaded_scope()
        scope.source['fills'] = [{'gradientStops': [{'boundVariables': {'color': alias('v.stop')}}],
                                  'boundVariables': {'color': alias('v.paint')}}]
        self.assertEqual(referenced_variable_ids(extract_bindings(scope)), ['v.stop', 'v.paint'])

    def test_external_payloads_inside_named_containers_are_not_bindings(self):
        scope = loaded_scope()
        paint = {'boundVariables': {'color': alias('v.good')}}
        for key in ('pluginData', 'sharedPluginData', 'annotations', 'interactions', 'actions'):
            paint[key] = {'boundVariables': {'color': alias('fake')}}
        scope.source['fills'] = [paint]
        result = extract_bindings(scope)
        self.assertEqual(referenced_variable_ids(result), ['v.good'])
        self.assertFalse(result.partial)

    def test_binding_json_walk_does_not_follow_children_edges(self):
        scope = loaded_scope()
        scope.source['fills'] = [{'children': [{'boundVariables': {'color': alias('fake')}}],
                                  'boundVariables': {'color': alias('v.good')}}]
        result = extract_bindings(scope)
        self.assertEqual(referenced_variable_ids(result), ['v.good'])
        self.assertFalse(result.partial)

    def test_inputs_immutable_stable_order_and_helpers_unique(self):
        body = bindings_payload()
        scope = loaded_scope(body)
        scope.source['boundVariables']['repeat'] = alias('v.width')
        before = copy.deepcopy(body)
        first = extract_bindings(scope)
        second = extract_bindings(scope)
        self.assertEqual(body, before)
        self.assertEqual(first, second)
        self.assertEqual(referenced_variable_ids(first).count('v.width'), 1)
        self.assertEqual(sum(r['reference_id'] == 'v.width' for r in first.data['variable_bindings']), 2)
        self.assertNotIn('boundVariables', loaded_scope(library_payload()).source)
        bindings_payload()['document']['children'][1]['children'][0]['children'][0]['boundVariables'].clear()
        self.assertTrue(loaded_scope(bindings_payload()).source['boundVariables'])


if __name__ == '__main__':
    unittest.main()
