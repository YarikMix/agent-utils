"""Scoped design-system CLI integration through the real CurlBoundary."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from bindings_fixtures import design_system_payload, variable_payload, loaded_scope
from context_fixtures import invoke, payload
from test_core import core

TARGET = 'https://figma.com/design/Key/Test?node-id=2-2'


def paths(transport):
    return [urlsplit(call[0][-1]).path for call in transport.calls]


class DesignSystemTests(unittest.TestCase):
    def run_bindings(self, arguments=(), body=None, variables=None):
        responses = [(200, design_system_payload() if body is None else body, {})]
        if '--with-variables' in arguments:
            responses.append((200, variable_payload(), {}) if variables is None else variables)
        return invoke(['bindings', TARGET, '--node', '2:1', *arguments, '--no-cache'], responses)

    def test_scope_override_single_source_and_not_requested_variables(self):
        code, result, transport = self.run_bindings(['--scope-root', '2:0'])
        self.assertEqual((code, result['status']), (0, 'ok'))
        self.assertEqual(result['operation'], 'bindings')
        data = result['data']
        self.assertEqual((data['source_node']['id'], data['scope_root']['id'], data['url_node_id']),
                         ('2:1', '2:0', '2:2'))
        self.assertEqual([a['id'] for a in data['ancestors']], ['0:0', '1:0', '2:0'])
        self.assertEqual(data['snapshot_consistency'], 'single-response')
        self.assertEqual(set(data['sections']), {'bindings', 'variables'})
        variables = data['sections']['variables']
        self.assertEqual(variables['state'], 'not_requested')
        for key in ('fetched_at', 'version', 'data', 'error'):
            self.assertIsNone(variables[key])
        self.assertEqual(paths(transport), ['/v1/files/Key'])
        self.assertEqual(parse_qs(urlsplit(transport.calls[0][0][-1]).query), {'ids': ['2:1,2:0']})
        self.assertEqual(result['coverage']['scanned_nodes'], 4)
        self.assertFalse(result['coverage']['complete'])
        self.assertTrue(all(r['definition_state'] == 'not_requested'
                            for r in data['sections']['bindings']['data']['variable_bindings']))

    def test_missing_optional_fields_remain_ok_and_malformed_bindings_keep_inventory(self):
        code, result, _ = self.run_bindings(body=payload())
        self.assertEqual((code, result['status']), (0, 'ok'))
        body = design_system_payload()
        body['document']['children'][1]['children'][0]['children'][0]['boundVariables']['bad'] = {
            'type': 'VARIABLE_ALIAS', 'id': None}
        code, result, _ = self.run_bindings(body=body)
        self.assertEqual((code, result['status']), (0, 'partial'))
        section = result['data']['sections']['bindings']
        self.assertEqual(section['state'], 'partial')
        self.assertTrue(section['data']['components'])
        self.assertTrue(any(row['reference_id'] is None for row in section['data']['variable_bindings']))

    def test_bindings_optional_variables_forbidden_preserves_inventory(self):
        for status, headers, error in [(403, {}, 'forbidden'), (429, {'Retry-After': '9'}, 'rate_limited'),
                                        (200, {}, 'invalid_response')]:
            with self.subTest(status=status):
                code, result, transport = self.run_bindings(['--with-variables'], variables=(status, {}, headers))
                self.assertEqual((code, result['status']), (0, 'partial'))
                sections = result['data']['sections']
                self.assertEqual(paths(transport), ['/v1/files/Key', '/v1/files/Key/variables/local'])
                self.assertEqual(sections['bindings']['state'], 'collected')
                self.assertEqual(sections['variables']['state'], 'failed')
                self.assertEqual(sections['variables']['error']['code'], error)
                self.assertEqual(sections['variables']['coverage'].get('request_scope'), 'file-variable-metadata')
                self.assertIsNone(sections['variables']['version'])
                self.assertEqual(result['data']['snapshot_consistency'], 'independent-requests')
                self.assertTrue(all(row['definition_state'] == 'unresolved'
                                    for row in sections['bindings']['data']['variable_bindings']))
                if status == 429:
                    self.assertEqual(sections['variables']['error']['retry_after'], '9')

    def test_successful_metadata_uses_full_reference_states_before_limit(self):
        code, result, transport = self.run_bindings(['--with-variables', '--limit', '1'])
        self.assertEqual((code, result['status']), (0, 'ok'))
        sections = result['data']['sections']
        bindings = sections['bindings']
        self.assertEqual(bindings['data']['variable_bindings'][0]['definition_state'], 'available')
        variables = sections['variables']
        self.assertEqual(variables['coverage']['reference_states'], {'A': 'available', 'C': 'available', 'B': 'available'})
        self.assertEqual(variables['coverage']['collections']['variables'], {'total': 3, 'returned': 1, 'truncated': True})
        for section in sections.values():
            for key, rows in section['data'].items():
                if isinstance(rows, list):
                    self.assertLessEqual(len(rows), 1)
        instance = bindings['data']['instances'][0]
        self.assertEqual(len(instance['component_properties']), 5)
        self.assertEqual(len(instance['overrides']), 1)
        self.assertEqual(len(transport.calls), 2)
        self.assertIsNone(variables['version'])

    def test_partial_definition_retains_good_neighbors_and_marks_direct_states(self):
        definitions = variable_payload()
        definitions['meta']['variables']['C']['valuesByMode'] = None
        code, result, _ = self.run_bindings(['--with-variables'], variables=(200, definitions, {}))
        self.assertEqual((code, result['status']), (0, 'partial'))
        sections = result['data']['sections']
        states = {row['reference_id']: row['definition_state']
                  for row in sections['bindings']['data']['variable_bindings']}
        self.assertEqual(states, {'A': 'available', 'B': 'available', 'C': 'unresolved'})
        self.assertEqual(sections['variables']['state'], 'partial')
        self.assertEqual(len(sections['variables']['data']['variables']), 3)

    def test_alias_failure_does_not_relabel_available_direct_definition(self):
        definitions = variable_payload()
        definitions['meta']['variables']['A']['valuesByMode']['m']['id'] = 'missing'
        code, result, _ = self.run_bindings(['--with-variables'], variables=(200, definitions, {}))
        self.assertEqual((code, result['status']), (0, 'partial'))
        rows = result['data']['sections']['bindings']['data']['variable_bindings']
        self.assertEqual(rows[0]['definition_state'], 'available')
        self.assertNotIn('resolved_value', json.dumps(result))

    def test_source_error_and_mismatched_scope_stop_before_enrichment(self):
        for args, responses, error in [
                ([], [(403, {}, {})], 'forbidden'),
                (['--scope-root', '2:2'], [(200, design_system_payload(), {})], 'scope_mismatch')]:
            code, result, transport = invoke(['bindings', TARGET, '--node', '2:1', '--with-variables', *args], responses)
            self.assertEqual((code, result['error']['code']), (1, error))
            self.assertEqual(len(transport.calls), 1)

    def test_invalid_arguments_fail_before_get(self):
        for arguments in (['bindings', 'Key'], ['bindings', 'Key', '--node', ''],
                          ['bindings', TARGET, '--scope-root', ''], ['bindings', TARGET, '--limit', '0'],
                          ['context', TARGET, '--with-variables']):
            with self.subTest(arguments=arguments):
                code, result, transport = invoke(arguments, [])
                self.assertEqual((code, result['error']['code']), (2, 'invalid_argument'))
                self.assertEqual(transport.calls, [])

    def test_source_and_variables_own_timestamp_cache_and_version(self):
        import figma_ops as cli
        args = cli.build_parser().parse_args(['bindings', TARGET, '--node', '2:1', '--with-variables'])
        body, definitions = design_system_payload(), variable_payload()
        definitions['version'] = 'not-document-version'
        client = core.Client(token='synthetic-secret', no_cache=True)
        with patch.object(client, 'get_json', side_effect=[core.ApiResponse(body, 'source-time', 'hit'),
                                                          core.ApiResponse(definitions, 'variables-time', 'miss')]):
            result = args.handler(args, client)
        self.assertEqual((result['fetched_at'], result['version'], result['cache']), ('source-time', 'v1', 'hit'))
        bindings, variables = (result['data']['sections'][key] for key in ('bindings', 'variables'))
        self.assertEqual((bindings['fetched_at'], bindings['version'], bindings['coverage']['cache']), ('source-time', 'v1', 'hit'))
        self.assertEqual((variables['fetched_at'], variables['version'], variables['coverage']['cache']), ('variables-time', None, 'miss'))

    def test_collector_reuses_scope_once_and_consumer_edits_cannot_change_inputs(self):
        from figma_ops_design_system import collect_design_system
        import figma_ops_design_system as module
        body, definitions = design_system_payload(), variable_payload()
        original = copy.deepcopy((body, definitions))
        scope = loaded_scope(body)
        client = core.Client(token='synthetic-secret', no_cache=True)
        with patch.object(module, 'extract_bindings', wraps=module.extract_bindings) as extract, patch.object(
                client, 'get_json', return_value=core.ApiResponse(definitions, 'variables-time', 'hit')) as get:
            result = collect_design_system(scope, client, with_variables=True, limit=1)
        self.assertEqual(extract.call_count, 1)
        get.assert_called_once_with('files/Key/variables/local')
        self.assertEqual((body, definitions), original)
        result['sections']['bindings']['data']['instances'][0]['component_properties'].clear()
        result['sections']['variables']['data']['variables'][0]['raw']['valuesByMode'].clear()
        self.assertEqual((body, definitions), original)

    def test_output_keeps_full_lists_and_common_flags_after_command(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / 'bindings.json'
            code, summary, transport = self.run_bindings(['--scope-root', '2:0', '--with-variables', '--limit', '1',
                                                         '--refresh', '--cache-dir', temporary, '--output', str(output)])
            self.assertEqual(code, 0)
            full = json.loads(output.read_text())
            self.assertEqual(summary['data'], {'artifact': str(output.resolve()), 'bytes': output.stat().st_size})
            for section in full['data']['sections'].values():
                for counts in section['coverage']['collections'].values():
                    self.assertEqual(counts['returned'], counts['total'])
                    self.assertFalse(counts['truncated'])
            self.assertEqual(len(transport.calls), 2)

    def test_composite_ids_and_branch_keys_are_not_split(self):
        body = design_system_payload()
        body['document']['children'][1]['children'][0]['children'][0]['id'] = 'I2:1;3:7'
        code, result, transport = invoke(['bindings', 'BranchKey', '--node', 'I2:1;3:7'], [(200, body, {})])
        self.assertEqual(code, 0)
        self.assertEqual(result['data']['source_node']['id'], 'I2:1;3:7')
        self.assertEqual(paths(transport), ['/v1/files/BranchKey'])
        self.assertEqual(parse_qs(urlsplit(transport.calls[0][0][-1]).query), {'ids': ['I2:1;3:7']})

    def test_availability_of_definition_hidden_by_limit_is_still_preserved(self):
        body = design_system_payload()
        source = body['document']['children'][1]['children'][0]['children'][0]
        source['boundVariables'] = {'width': {'type': 'VARIABLE_ALIAS', 'id': 'shared'},
                                    'height': {'type': 'VARIABLE_ALIAS', 'id': 'C'}}
        definitions = variable_payload()
        for name in ('A', 'B'):
            definitions['meta']['variables'][name]['subscribed_id'] = 'shared'
        code, result, _ = self.run_bindings(['--with-variables', '--limit', '2'], body,
                                          (200, definitions, {}))
        self.assertEqual((code, result['status']), (0, 'partial'))
        sections = result['data']['sections']
        self.assertEqual([r['mapping_key'] for r in sections['variables']['data']['variables']], ['A', 'B'])
        self.assertEqual([r['definition_state'] for r in sections['bindings']['data']['variable_bindings']],
                         ['unresolved', 'available'])
        self.assertEqual(sections['variables']['coverage']['reference_states']['C'], 'available')

    def test_deep_raw_projection_copies_without_recursive_traversal(self):
        from figma_ops_design_system import collect_design_system
        body = design_system_payload()
        source = body['document']['children'][1]['children'][0]['children'][0]
        original = {'leaf': False}
        source['componentProperties']['Label#prop']['future'] = original
        for _ in range(1400):
            original['next'] = {'leaf': 0}
            original = original['next']
        result = collect_design_system(loaded_scope(body), core.Client(token='synthetic-secret'), limit=1)
        copied = result['sections']['bindings']['data']['instances'][0]['component_properties']['Label#prop']['future']
        while 'next' in copied:
            copied = copied['next']
        copied['leaf'] = 'consumer edit'
        self.assertEqual(original['leaf'], 0)


    def test_unique_direct_reference_counters_precede_projection_and_distinguish_skipped(self):
        body = design_system_payload()
        source = body['document']['children'][1]['children'][0]['children'][0]
        source['boundVariables']['duplicate'] = {'type': 'VARIABLE_ALIAS', 'id': 'A'}
        for flags, expected, variables in [
                ([], {'referenced': 3, 'not_requested': 3, 'available': 0, 'unresolved': 0}, None),
                (['--with-variables'], {'referenced': 3, 'not_requested': 0, 'available': 3, 'unresolved': 0}, None),
                (['--with-variables'], {'referenced': 3, 'not_requested': 0, 'available': 0, 'unresolved': 3}, (403, {}, {}))]:
            with self.subTest(flags=flags, failed=variables is not None):
                code, result, _ = self.run_bindings([*flags, '--limit', '1'], body, variables)
                self.assertEqual(code, 0)
                coverage = result['data']['sections']['bindings']['coverage']
                self.assertEqual(coverage.get('variable_references'), expected)
                self.assertEqual(coverage['collections']['variable_bindings']['total'], 4)

    def test_whitespace_reference_keeps_exact_identity_and_requested_state_before_projection(self):
        body = design_system_payload()
        source = body['document']['children'][1]['children'][0]['children'][0]
        source['boundVariables'] = {'width': {'type': 'VARIABLE_ALIAS', 'id': ' '},
                                    'height': {'type': 'VARIABLE_ALIAS', 'id': 'A'}}
        for variables in (None, (403, {}, {})):
            with self.subTest(endpoint_failed=variables is not None):
                code, result, transport = self.run_bindings(['--with-variables', '--limit', '1'], body, variables)
                self.assertEqual((code, result['status']), (0, 'partial'))
                self.assertEqual(paths(transport), ['/v1/files/Key', '/v1/files/Key/variables/local'])
                sections = result['data']['sections']
                row, = sections['bindings']['data']['variable_bindings']
                self.assertEqual(row['reference_id'], ' ')
                self.assertEqual(row['definition_state'], 'unresolved')
                self.assertEqual(sections['bindings']['coverage']['variable_references'],
                                 {'referenced': 2, 'not_requested': 0,
                                  'available': 1 if variables is None else 0,
                                  'unresolved': 1 if variables is None else 2})
                self.assertEqual(sections['bindings']['coverage']['collections']['variable_bindings'],
                                 {'total': 2, 'returned': 1, 'truncated': True})
                if variables is None:
                    self.assertEqual(sections['variables']['coverage']['reference_states'][' '], 'unresolved')
                    self.assertEqual(sections['variables']['data']['unresolved_references'][0]['reference_id'], ' ')
