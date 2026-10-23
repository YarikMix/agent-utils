"""Pure library inventory contracts: references, scope, raw evidence and coverage."""
import copy
import unittest

from bindings_fixtures import library_payload, loaded_scope
from figma_ops_library import extract_library


class LibraryTests(unittest.TestCase):
    def test_used_metadata_and_loaded_definition_do_not_expand_scope(self):
        result = extract_library(loaded_scope())
        self.assertEqual(result.coverage['scanned_nodes'], 4)
        self.assertEqual([x['id'] for x in result.data['components']], ['5:1', '5:2'])
        self.assertEqual([x['id'] for x in result.data['component_sets']], ['5:0'])
        component = result.data['components'][0]
        self.assertEqual(component['definition_location'], 'loaded_dependency')
        self.assertNotIn('children', component['definition'])
        self.assertEqual(component['definition']['node']['id'], '5:1')
        for row in [component, result.data['component_sets'][0]]:
            definitions = row['definition']['component_property_definitions']
            self.assertIs(definitions['Enabled#prop']['defaultValue'], False)
            self.assertEqual(definitions['Content#prop']['defaultValue']['guid'], {'sessionID': 7, 'localID': 9})
        props = result.data['instances'][0]['component_properties']
        self.assertIs(props['Enabled#prop']['value'], False)
        self.assertEqual(props['Label#prop']['value'], '')
        self.assertEqual(props['Content#prop']['value'], {'guid': {'sessionID': 7, 'localID': 9}})
        self.assertFalse(result.partial)
        self.assertFalse(result.coverage['complete'])
        self.assertEqual(result.coverage['scope'], 'loaded-subtree')

    def test_exact_source_scope_excludes_sibling_and_remote_component(self):
        result = extract_library(loaded_scope(root_id='2:1'))
        self.assertEqual(result.coverage['scanned_nodes'], 2)
        self.assertEqual([x['node']['id'] for x in result.data['instances']], ['2:1'])
        self.assertEqual([x['id'] for x in result.data['components']], ['5:1'])

    def test_directly_scoped_definitions_are_included_without_instances(self):
        for node_id, collection in [('5:1', 'components'), ('5:0', 'component_sets')]:
            with self.subTest(node_id=node_id):
                result = extract_library(loaded_scope(source_id=node_id, root_id=node_id))
                row = result.data[collection][0]
                self.assertEqual(row['id'], node_id)
                self.assertEqual(row['definition_location'], 'scope')
                self.assertEqual(result.data['instances'], [])

    def test_remote_key_stays_metadata_and_never_becomes_file_key(self):
        result = extract_library(loaded_scope())
        remote = result.data['components'][1]
        self.assertEqual(remote['metadata']['key'], 'remote-component-key')
        self.assertEqual(remote['definition_location'], 'not_loaded')
        self.assertIsNone(remote['definition'])
        self.assertEqual(remote['provenance']['file_key'], 'Key')

    def test_id_key_name_collision_uses_references_only(self):
        result = extract_library(loaded_scope())
        self.assertEqual([x['id'] for x in result.data['components']], ['5:1', '5:2'])
        self.assertEqual([x['id'] for x in result.data['styles']], ['s.fill', 's.text'])

    def test_distinct_referenced_ids_with_identical_metadata_are_not_merged(self):
        body = library_payload()
        body['components']['5:2'] = copy.deepcopy(body['components']['5:1'])
        result = extract_library(loaded_scope(body))
        self.assertEqual([x['id'] for x in result.data['components']], ['5:1', '5:2'])

    def test_component_sets_follow_first_use_before_later_direct_definition(self):
        scope = loaded_scope()
        scope.root['children'].append({'id': '8:1', 'name': 'Direct set', 'type': 'COMPONENT_SET'})
        result = extract_library(scope)
        self.assertEqual([row['id'] for row in result.data['component_sets']], ['5:0', '8:1'])

    def test_style_usages_are_references_not_computed_values(self):
        result = extract_library(loaded_scope())
        self.assertEqual([(r['node']['id'], r['style_type'], r['style_id'])
                          for r in result.data['style_usages']],
                         [('2:1', 'fill', 's.fill'), ('I2:1;3:1', 'text', 's.text')])
        self.assertNotIn('computed_value', result.data['styles'][0])
        self.assertNotIn('fills', result.data['styles'][0])
        self.assertEqual(result.data['instances'][0]['overrides'][0]['future'], 0)
        self.assertIs(result.data['instances'][0]['is_exposed_instance'], False)
        self.assertEqual(result.data['instances'][0]['raw']['future'], {'zero': 0})

    def test_missing_metadata_does_not_erase_usage(self):
        body = library_payload()
        del body['components']['5:2']
        del body['styles']['s.text']
        result = extract_library(loaded_scope(body))
        self.assertEqual(result.data['components'][1]['metadata_state'], 'missing')
        self.assertEqual(len(result.data['instances']), 2)
        self.assertEqual(len(result.data['style_usages']), 2)
        self.assertFalse(result.partial)
        self.assertEqual(result.coverage['metadata']['components']['missing'], 1)
        self.assertEqual(result.coverage['metadata']['styles']['resolved'], 1)
        self.assertEqual(result.coverage['metadata']['styles']['unresolved'], 1)

    def test_invalid_property_keeps_valid_false_and_slot(self):
        scope = loaded_scope()
        scope.source['componentProperties']['Broken#prop'] = {'type': 'BOOLEAN', 'value': []}
        result = extract_library(scope)
        props = result.data['instances'][0]['component_properties']
        self.assertTrue(result.partial)
        self.assertEqual(props['Broken#prop']['value'], [])
        self.assertIs(props['Enabled#prop']['value'], False)
        self.assertEqual(props['Content#prop']['value']['guid'], {'sessionID': 7, 'localID': 9})

    def test_unknown_property_type_preserves_raw_and_warns(self):
        scope = loaded_scope()
        scope.source['componentProperties']['Future#id'] = {'type': 'FUTURE', 'value': {'zero': 0}}
        result = extract_library(scope)
        self.assertTrue(result.partial)
        self.assertEqual(result.data['instances'][0]['component_properties']['Future#id']['value'], {'zero': 0})
        self.assertTrue(any('unknown_property_type' in warning for warning in result.warnings))

    def test_malformed_maps_entries_and_properties_keep_valid_neighbors(self):
        for field, value in [('components', []), ('componentSets', None), ('styles', 'invalid')]:
            with self.subTest(field=field):
                body = library_payload()
                body[field] = value
                result = extract_library(loaded_scope(body))
                self.assertTrue(result.partial)
                self.assertEqual(len(result.data['instances']), 2)
                collection = 'component_sets' if field == 'componentSets' else field
                self.assertEqual(result.data[collection][0]['metadata'], value)
                self.assertEqual(result.data[collection][0]['provenance']['json_pointer'], '/' + field)
        body = library_payload()
        body['components']['5:2'] = []
        body['styles']['s.text'] = None
        scope = loaded_scope(body)
        scope.source['componentProperties']['Broken'] = None
        result = extract_library(scope)
        self.assertTrue(result.partial)
        self.assertEqual(result.data['components'][0]['metadata_state'], 'available')
        self.assertEqual(result.data['components'][1]['metadata_state'], 'malformed')
        self.assertEqual(result.data['components'][1]['metadata'], [])
        self.assertIsNone(result.data['instances'][0]['component_properties']['Broken'])

    def test_fields_absent_empty_and_null_have_distinct_coverage_and_raw(self):
        for present, value, expected, partial in [(False, None, 'absent', False),
                                                 (True, {}, 'empty', False),
                                                 (True, None, 'invalid', True)]:
            with self.subTest(expected=expected):
                scope = loaded_scope(root_id='2:1')
                scope.source.pop('componentProperties')
                if present:
                    scope.source['componentProperties'] = value
                result = extract_library(scope)
                self.assertEqual(result.coverage['fields']['componentProperties'][expected], 1)
                self.assertEqual(result.partial, partial)
                self.assertEqual('componentProperties' in result.data['instances'][0]['raw'], present)

    def test_invalid_optional_containers_and_references_are_raw_partial(self):
        for field, value in [('overrides', {}), ('exposedInstances', None),
                             ('isExposedInstance', 0), ('styles', []), ('componentId', {})]:
            with self.subTest(field=field):
                scope = loaded_scope()
                scope.source[field] = value
                result = extract_library(scope)
                self.assertTrue(result.partial)
                self.assertEqual(result.data['instances'][0]['raw'][field], value)
        scope = loaded_scope()
        scope.source['styles']['bad'] = []
        result = extract_library(scope)
        self.assertTrue(result.partial)
        self.assertEqual(len(result.data['style_usages']), 3)
        self.assertEqual(result.data['style_usages'][1]['style_id'], [])
        self.assertEqual([r['id'] for r in result.data['styles']], ['s.fill', 's.text'])

    def test_definition_properties_are_validated_without_scanning_children(self):
        body = library_payload()
        body['document']['children'][0]['children'][1]['componentPropertyDefinitions']['Bad'] = {'type': 'TEXT', 'defaultValue': []}
        result = extract_library(loaded_scope(body))
        self.assertTrue(result.partial)
        self.assertEqual(result.coverage['scanned_nodes'], 4)
        self.assertEqual(result.data['component_sets'][0]['definition']['component_property_definitions']['Bad']['defaultValue'], [])

    def test_provenance_uses_real_pointer_basis_and_escapes_keys(self):
        scope = loaded_scope()
        scope.source['styles'] = {'fill/~': 's/f~x'}
        scope.response.payload['styles']['s/f~x'] = {'name': 'Escaped'}
        result = extract_library(scope)
        usage = result.data['style_usages'][0]['provenance']
        metadata = result.data['styles'][0]['provenance']
        self.assertEqual((usage['pointer_basis'], usage['json_pointer']), ('node', '/styles/fill~1~0'))
        self.assertEqual((metadata['pointer_basis'], metadata['json_pointer']), ('response', '/styles/s~1f~0x'))
        self.assertEqual(result.data['components'][0]['definition']['provenance']['pointer_basis'], 'node')

    def test_missing_required_property_values_preserve_raw_and_warn(self):
        scope = loaded_scope()
        scope.source['componentProperties']['Missing'] = {'type': 'BOOLEAN'}
        result = extract_library(scope)
        self.assertTrue(result.partial)
        self.assertEqual(result.data['instances'][0]['component_properties']['Missing'], {'type': 'BOOLEAN'})

    def test_input_is_not_mutated_and_each_fixture_is_fresh(self):
        body = library_payload()
        before = copy.deepcopy(body)
        extract_library(loaded_scope(body))
        self.assertEqual(body, before)
        loaded_scope().source['componentProperties']['Enabled#prop']['value'] = True
        self.assertIs(loaded_scope().source['componentProperties']['Enabled#prop']['value'], False)


if __name__ == '__main__':
    unittest.main()
