"""Scoped design-system inventory with optional independent variable metadata."""
from figma_ops_bindings import extract_bindings, observed_collection_ids, referenced_variable_ids
from figma_ops_core import Client, OpsError, envelope, parse_target
from figma_ops_prototype import project_prototype
from figma_ops_scope import (LoadedScope, collected_section, empty_section, load_scope,
                             scope_context)
from figma_ops_variables import extract_variables


def collect_design_system(scope: LoadedScope, client: Client, *, with_variables: bool = False,
                          limit: int | None = None) -> dict:
    """Reuse one loaded source; project only after metadata availability is known."""
    inventory = extract_bindings(scope)
    inventory.coverage['cache'] = scope.response.cache
    references = referenced_variable_ids(inventory)
    variables_section = empty_section('not_requested')
    reference_states = {}
    if with_variables:
        response = None
        try:
            response = client.get_json(f'files/{scope.target.file_key}/variables/local')
            payload = response.payload
            meta = payload.get('meta') if isinstance(payload, dict) else None
            if (not isinstance(meta, dict) or type(payload.get('status')) is not int
                    or payload['status'] != 200 or payload.get('error') is not False
                    or not isinstance(meta.get('variables'), dict)
                    or not isinstance(meta.get('variableCollections'), dict)):
                raise OpsError('invalid_response', 'Variables endpoint returned invalid metadata.')
            variables = extract_variables(response, scope.target.file_key,
                                          references,
                                          collection_ids=observed_collection_ids(inventory))
            reference_states = variables.coverage['reference_states']
            variables_section = collected_section(project_prototype(variables, limit), response)
        except OpsError as error:
            variables_section = {**empty_section('failed'),
                                 'error': {'code': error.code, 'message': error.message,
                                           'http_status': error.http_status,
                                           'retry_after': error.retry_after}}
            variables_section['coverage']['request_scope'] = 'file-variable-metadata'
            if response is not None:
                variables_section['fetched_at'] = response.fetched_at
                variables_section['coverage']['cache'] = response.cache
    counts = {'referenced': len(references), 'not_requested': 0, 'available': 0, 'unresolved': 0}
    for reference in references:
        state = reference_states.get(reference, 'unresolved') if with_variables else 'not_requested'
        counts[state] += 1
    inventory.coverage['variable_references'] = counts
    for row in inventory.data['variable_bindings']:
        reference = row['reference_id']
        if isinstance(reference, str) and reference.strip():
            row['definition_state'] = (reference_states.get(reference, 'unresolved')
                                       if with_variables else 'not_requested')
    sections = {'bindings': collected_section(project_prototype(inventory, limit), scope.response,
                                              version=scope.response.payload.get('version')),
                'variables': variables_section}
    root_id, file_key = scope.root['id'], scope.target.file_key
    next_actions = [
        {'kind': 'variable_definitions', 'file_key': file_key, 'node_id': root_id,
         'purpose': 'Read variable definitions separately for this exact scope; metadata does not compute effective values.',
         'prerequisites': ['Discover get_variable_defs in the host and verify its current schema.'],
         'tool': 'get_variable_defs', 'parameters': {'fileKey': file_key, 'nodeId': root_id}},
        {'kind': 'code_connect', 'file_key': file_key, 'node_id': root_id,
         'purpose': 'Read Code Connect mappings for observed component IDs or keys in project context.',
         'prerequisites': ['Discover an available read-only Code Connect mapping tool and verify its current schema.']},
    ]
    return {'sections': sections, 'next_actions': next_actions}


def bindings(args, client: Client) -> dict:
    target = parse_target(args.target, args.node)
    url_node_id = parse_target(args.target).node_id
    scope = load_scope(client, target, root_id=args.scope_root)
    result = collect_design_system(scope, client, with_variables=args.with_variables,
                                   limit=None if args.output is not None else args.limit)
    identity = scope_context(scope, url_node_id=url_node_id)
    sections = result['sections']
    warnings = list(dict.fromkeys(warning for section in sections.values() for warning in section['warnings']))
    partial = any(section['state'] in ('partial', 'failed') for section in sections.values())
    return envelope('bindings', target.file_key,
                    {**identity, **result,
                     'snapshot_consistency': 'independent-requests' if args.with_variables else 'single-response'},
                    response=scope.response, version=scope.response.payload.get('version'),
                    coverage={'scope': 'loaded-subtree', 'root': identity['scope_root'],
                              'scanned_nodes': sections['bindings']['coverage']['scanned_nodes'],
                              'complete': False},
                    warnings=warnings, status='partial' if partial else 'ok')
