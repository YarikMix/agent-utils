"""Pure variable metadata availability, exact identity and bounded alias closure."""
import copy
import unittest

from bindings_fixtures import variable_payload
from figma_ops_core import ApiResponse
from figma_ops_variables import extract_variables


def alias(reference):
    return {'type': 'VARIABLE_ALIAS', 'id': reference}


def collect(body=None, references=None, collections=None):
    return extract_variables(ApiResponse(variable_payload() if body is None else body,
                                         '2026-02-02T00:00:00Z', 'hit'), 'Key',
                             ['A'] if references is None else references,
                             collection_ids=collections)


class VariablesTests(unittest.TestCase):
    def test_alias_cycle_keeps_raw_definitions_without_resolving_values(self):
        result = collect()
        self.assertEqual({v['mapping_key'] for v in result.data['variables']}, {'A', 'B'})
        self.assertEqual(len(result.data['alias_links']), 2)
        self.assertEqual(result.coverage['reference_states'], {'A': 'available', 'B': 'available'})
        self.assertEqual(result.data['variable_collections'][0]['raw']['modes'],
                         [{'modeId': 'm', 'name': 'Default'}])
        self.assertTrue(all('resolved_value' not in v for v in result.data['variables']))
        self.assertFalse(result.partial)
        self.assertFalse(result.coverage['complete'])
        self.assertEqual(result.coverage['request_scope'], 'file-variable-metadata')
        self.assertEqual(result.coverage['references'], {'requested': 1, 'encountered': 2,
                                                        'available': 2, 'unresolved': 0})
        self.assertEqual(result.coverage['catalog']['variables']['total'], 3)
        self.assertEqual(result.coverage['catalog']['variables']['collected'], 2)

    def test_exact_mapping_id_subscribed_identity_never_stable_key(self):
        body = variable_payload()
        raw = body['meta']['variables']['A']
        raw.update(id='local:7;8', subscribed_id='VariableID:remote/7~9', remote=True,
                   valuesByMode={'m': 0})
        result = collect(body, ['A', 'local:7;8', 'VariableID:remote/7~9', 'stable-A'])
        self.assertEqual([r['mapping_key'] for r in result.data['variables']], ['A'])
        self.assertEqual(result.data['variables'][0]['raw']['subscribed_id'], 'VariableID:remote/7~9')
        self.assertEqual(result.coverage['reference_states']['VariableID:remote/7~9'], 'available')
        self.assertEqual(result.data['unresolved_references'][0]['reason'], 'not_returned')
        self.assertEqual(result.data['unresolved_references'][0]['reference_id'], 'stable-A')

    def test_ambiguous_identity_preserves_candidates_without_expansion(self):
        body = variable_payload()
        for name, target in [('A', 'target-a'), ('B', 'target-b')]:
            body['meta']['variables'][name].update(subscribed_id='shared', valuesByMode={'m': alias(target)})
        result = collect(body, ['shared'])
        self.assertEqual(result.coverage['reference_states'], {'shared': 'unresolved'})
        self.assertEqual(result.data['unresolved_references'][0]['reason'], 'ambiguous_reference')
        self.assertEqual({r['mapping_key'] for r in result.data['variables']}, {'A', 'B'})
        self.assertEqual(result.data['alias_links'], [])
        self.assertEqual(result.data['variable_collections'], [])
        self.assertTrue(result.partial)

    def test_deleted_definition_is_retained_without_alias_expansion(self):
        body = variable_payload()
        body['meta']['variables']['A']['deletedButReferenced'] = True
        result = collect(body)
        self.assertEqual([r['mapping_key'] for r in result.data['variables']], ['A'])
        self.assertEqual(result.data['unresolved_references'][0]['reason'], 'deleted_but_referenced')
        self.assertEqual(result.coverage['reference_states']['A'], 'unresolved')
        self.assertTrue(result.partial)

    def test_malformed_and_missing_neighbors_do_not_hide_valid_definitions(self):
        body = variable_payload()
        body['meta']['variables']['broken'] = None
        body['meta']['variables']['A']['valuesByMode'] = {'m': alias('missing')}
        result = collect(body, ['broken', 'A'])
        self.assertEqual([r['mapping_key'] for r in result.data['variables']], ['broken', 'A'])
        self.assertIsNone(result.data['variables'][0]['raw'])
        self.assertEqual([r['reason'] for r in result.data['unresolved_references']], ['malformed', 'not_returned'])
        self.assertEqual(result.coverage['reference_states']['A'], 'available')
        self.assertTrue(result.partial)

    def test_invalid_definition_fields_are_raw_unresolved(self):
        for field, raw in [('id', None), ('valuesByMode', []), ('remote', 'yes'),
                           ('deletedButReferenced', 1), ('variableCollectionId', None)]:
            with self.subTest(field=field):
                body = variable_payload()
                body['meta']['variables']['A'][field] = raw
                result = collect(body)
                self.assertEqual(result.data['unresolved_references'][0]['reason'], 'malformed')
                self.assertEqual(result.data['variables'][0]['raw'][field], raw)
                self.assertEqual(result.data['alias_links'], [])

    def test_malformed_meta_and_maps_keep_available_parts(self):
        for body in [None, [], {}, {'meta': None}, {'meta': []}]:
            with self.subTest(body=body):
                result = extract_variables(ApiResponse(body, 'time', 'miss'), 'Key', ['A'])
                self.assertTrue(result.partial)
                self.assertEqual(result.coverage['reference_states']['A'], 'unresolved')
        for table in ('variables', 'variableCollections'):
            body = variable_payload()
            body['meta'][table] = []
            result = collect(body)
            self.assertTrue(result.partial)
            if table == 'variableCollections':
                self.assertEqual({r['mapping_key'] for r in result.data['variables']}, {'A', 'B'})

    def test_failed_response_cannot_claim_available_metadata(self):
        for field, value in [('status', 403), ('error', True), ('status', True), ('error', 'false')]:
            body = variable_payload()
            body[field] = value
            result = collect(body)
            self.assertTrue(result.partial)
            self.assertEqual(result.coverage['reference_states']['A'], 'unresolved')

    def test_unrelated_catalog_damage_does_not_emit_unused_rows(self):
        body = variable_payload()
        body['meta']['variables']['C'] = 0
        result = collect(body)
        self.assertEqual({r['mapping_key'] for r in result.data['variables']}, {'A', 'B'})
        self.assertEqual(result.coverage['catalog']['variables']['malformed'], 1)
        self.assertTrue(result.partial)

    def test_false_zero_empty_rgba_and_composed_values_preserve_exact_raw(self):
        body = variable_payload()
        values = {'false': False, 'zero': 0, 'empty': '',
                  'rgba': {'r': 0, 'g': 1, 'b': 0.5, 'a': 0},
                  'composed/~': {'color': alias('B'), 'opacity': alias('C')}}
        body['meta']['variables']['A']['valuesByMode'] = values
        body['meta']['variables']['B']['valuesByMode'] = {'m': 0}
        result = collect(body)
        row = result.data['variables'][0]
        self.assertEqual(row['raw']['valuesByMode'], values)
        self.assertEqual(row['raw']['codeSyntax'], {'WEB': 'var(--token)', 'ANDROID': 'token', 'iOS': 'Token'})
        self.assertEqual(row['raw']['future'], {'zero': 0, 'empty': '', 'flag': False})
        self.assertEqual([r['json_pointer'] for r in result.data['alias_links']],
                         ['/meta/variables/A/valuesByMode/composed~1~0/color',
                          '/meta/variables/A/valuesByMode/composed~1~0/opacity'])
        self.assertTrue(all(r['mode_id'] == 'composed/~' for r in result.data['alias_links']))
        self.assertFalse(result.partial)

    def test_unknown_and_malformed_values_stay_raw_without_guessed_aliases(self):
        body = variable_payload()
        body['meta']['variables']['A']['valuesByMode'] = {
            'unknown': {'future': alias('C')}, 'bad': {'type': 'VARIABLE_ALIAS', 'id': ''},
            'good': alias('B')}
        result = collect(body)
        self.assertTrue(result.partial)
        self.assertEqual([r['reference_id'] for r in result.data['alias_links']], ['B', 'A'])
        self.assertEqual({r['mapping_key'] for r in result.data['variables']}, {'A', 'B'})

    def test_deep_alias_chain_and_cycle_use_iterative_closure(self):
        body = variable_payload()
        template = body['meta']['variables']['A']
        body['meta']['variables'] = {
            str(i): dict(template, id=str(i), valuesByMode={'m': alias(str((i + 1) % 1201))})
            for i in range(1201)}
        result = collect(body, ['0'])
        self.assertEqual(len(result.data['variables']), 1201)
        self.assertEqual(len(result.data['alias_links']), 1201)
        self.assertFalse(result.partial)

    def test_missing_modes_differs_from_invalid_modes(self):
        body = variable_payload()
        del body['meta']['variableCollections']['c']['modes']
        missing = collect(body)
        self.assertFalse(missing.partial)
        self.assertEqual(missing.coverage['fields']['modes']['absent'], 1)
        body['meta']['variableCollections']['c']['modes'] = {}
        invalid = collect(body)
        self.assertTrue(invalid.partial)
        self.assertEqual(invalid.coverage['fields']['modes']['invalid'], 1)
        self.assertEqual(invalid.data['variable_collections'][0]['raw']['modes'], {})

    def test_unused_extension_override_does_not_expand_catalog(self):
        body = variable_payload()
        variables = body['meta']['variables']
        variables['A']['valuesByMode'] = {'m': False}
        variables['B']['valuesByMode'] = {'m': 0}
        for name in ('X', 'Y'):
            variables[name] = dict(variables['C'], id=name, variableCollectionId='unrelated')
        collections = body['meta']['variableCollections']
        collections['child'] = dict(collections['c'], id='child', isExtension=True,
            parentVariableCollectionId='c', rootVariableCollectionId='c', defaultModeId='child:m',
            modes=[{'modeId': 'child:m', 'parentModeId': 'm', 'name': 'Inherited'}],
            variableOverrides={'A': {'child:m': alias('B')}, 'X': {'child:m': alias('Y')}})
        collections['unrelated'] = dict(collections['c'], id='unrelated')
        before = copy.deepcopy(body)
        result = collect(body, collections=['child'])
        self.assertEqual({r['mapping_key'] for r in result.data['variables']}, {'A', 'B'})
        self.assertEqual({r['mapping_key'] for r in result.data['variable_collections']}, {'child', 'c'})
        child = result.data['variable_collections'][0]['raw']
        self.assertEqual(child, before['meta']['variableCollections']['child'])
        link = result.data['alias_links'][0]
        self.assertEqual(link['source_collection_id'], 'child')
        self.assertEqual(link['source_variable_id'], 'A')
        self.assertEqual(link['mode_id'], 'child:m')
        self.assertEqual(link['json_pointer'], '/meta/variableCollections/child/variableOverrides/A/child:m')
        self.assertFalse(result.partial)

    def test_newly_selected_variable_rechecks_existing_extension_overrides(self):
        body = variable_payload()
        body['meta']['variables']['A']['valuesByMode'] = {'m': alias('B')}
        body['meta']['variables']['B']['valuesByMode'] = {'m': 0}
        body['meta']['variableCollections']['c']['variableOverrides'] = {'B': {'m': alias('C')}}
        result = collect(body)
        self.assertEqual([r['mapping_key'] for r in result.data['variables']], ['A', 'B', 'C'])
        self.assertEqual(len(result.data['alias_links']), 2)

    def test_collection_parent_cycle_is_bounded_partial(self):
        body = variable_payload()
        original = body['meta']['variableCollections']['c']
        body['meta']['variableCollections'] = {
            'c1': dict(original, id='c1', parentVariableCollectionId='c2'),
            'c2': dict(original, id='c2', parentVariableCollectionId='c1')}
        result = collect(body, [], ['c1'])
        self.assertEqual(len(result.data['variable_collections']), 2)
        self.assertTrue(result.partial)
        self.assertEqual([r['raw']['parentVariableCollectionId'] for r in result.data['variable_collections']], ['c2', 'c1'])
        self.assertTrue(any('cycle' in w for w in result.warnings))

    def test_malformed_collection_records_are_retained_and_counted(self):
        for field, value in [('id', None), ('defaultModeId', False), ('remote', 0),
                             ('modes', [{'modeId': 'm'}]), ('variableIds', [False]),
                             ('variableOverrides', [])]:
            with self.subTest(field=field):
                body = variable_payload()
                body['meta']['variableCollections']['c'][field] = value
                result = collect(body)
                self.assertTrue(result.partial)
                self.assertEqual(result.coverage['catalog']['variable_collections']['malformed'], 1)
                self.assertEqual(result.data['variable_collections'][0]['raw'][field], value)
                self.assertEqual(result.coverage['reference_states']['A'], 'available')

    def test_code_syntax_values_and_unknown_types_cannot_claim_valid_definition(self):
        for field, raw in [('codeSyntax', {'WEB': False}), ('resolvedType', 'FUTURE'),
                           ('scopes', [False])]:
            with self.subTest(field=field):
                body = variable_payload()
                body['meta']['variables']['A'][field] = raw
                result = collect(body)
                self.assertTrue(result.partial)
                self.assertEqual(result.data['unresolved_references'][0]['reason'], 'malformed')
                self.assertEqual(result.data['variables'][0]['raw'][field], raw)

    def test_extension_override_matches_exact_subscribed_identity(self):
        body = variable_payload()
        body['meta']['variables']['A'].update(subscribed_id='subscribed/~', valuesByMode={'m': False})
        body['meta']['variables']['B']['valuesByMode'] = {'m': 0}
        body['meta']['variableCollections']['c']['variableOverrides'] = {
            'stable-A': {'m': alias('C')}, 'subscribed/~': {'m': alias('B')}}
        result = collect(body)
        self.assertEqual([r['mapping_key'] for r in result.data['variables']], ['A', 'B'])
        self.assertEqual(len(result.data['alias_links']), 1)
        self.assertEqual(result.data['alias_links'][0]['json_pointer'],
                         '/meta/variableCollections/c/variableOverrides/subscribed~1~0/m')

    def test_snapshot_cache_provenance_and_no_input_mutation(self):
        body = variable_payload()
        body['version'] = 'metadata-is-not-document-version'
        before = copy.deepcopy(body)
        result = collect(body)
        self.assertEqual(body, before)
        self.assertEqual(result, collect(body))
        self.assertEqual(result.coverage['cache'], 'hit')
        for name in ('variables', 'variable_collections', 'alias_links'):
            for row in result.data[name]:
                self.assertEqual(row['provenance']['fetched_at'], '2026-02-02T00:00:00Z')
                self.assertIsNone(row['provenance']['version'])
                self.assertEqual(row['provenance']['pointer_basis'], 'response')
        variable_payload()['meta']['variables'].clear()
        self.assertEqual(len(variable_payload()['meta']['variables']), 3)


if __name__ == '__main__':
    unittest.main()
