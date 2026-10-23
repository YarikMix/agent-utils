"""Pure used variable metadata and alias evidence; never evaluate variable values."""
from collections import deque

from figma_ops_core import ApiResponse
from figma_ops_scope import Collected


def _reference(value) -> bool:
    return isinstance(value, str) and bool(value)


def _escape(value: str) -> str:
    return value.replace('~', '~0').replace('/', '~1')


def _valid_variable(raw) -> bool:
    if not isinstance(raw, dict):
        return False
    if not all(_reference(raw.get(key)) for key in ('id', 'variableCollectionId')):
        return False
    if not isinstance(raw.get('valuesByMode'), dict):
        return False
    for key in ('key', 'name', 'description', 'subscribed_id', 'resolvedType'):
        if key in raw and not isinstance(raw[key], str):
            return False
    for key in ('remote', 'hiddenFromPublishing', 'deletedButReferenced'):
        if key in raw and type(raw[key]) is not bool:
            return False
    if 'resolvedType' in raw and raw['resolvedType'] not in ('BOOLEAN', 'COLOR', 'FLOAT', 'STRING'):
        return False
    return (('scopes' not in raw or isinstance(raw['scopes'], list)
             and all(isinstance(scope, str) for scope in raw['scopes']))
            and ('codeSyntax' not in raw or isinstance(raw['codeSyntax'], dict)
                 and all(isinstance(value, str) for value in raw['codeSyntax'].values())))


def _valid_collection(raw) -> bool:
    if not isinstance(raw, dict):
        return False
    for key in ('id', 'key', 'name', 'subscribed_id', 'defaultModeId',
                'parentVariableCollectionId', 'rootVariableCollectionId'):
        if key in raw and not _reference(raw[key]):
            return False
    for key in ('remote', 'hiddenFromPublishing', 'isExtension'):
        if key in raw and type(raw[key]) is not bool:
            return False
    if 'modes' in raw:
        if not isinstance(raw['modes'], list):
            return False
        for mode in raw['modes']:
            if (not isinstance(mode, dict) or not _reference(mode.get('modeId'))
                    or not isinstance(mode.get('name'), str)
                    or 'parentModeId' in mode and not _reference(mode['parentModeId'])):
                return False
    return (('variableIds' not in raw or isinstance(raw['variableIds'], list)
             and all(_reference(value) for value in raw['variableIds']))
            and ('variableOverrides' not in raw or isinstance(raw['variableOverrides'], dict)))


def _index(table):
    identities = {}
    for mapping_key, raw in table.items():
        values = [mapping_key]
        if isinstance(raw, dict):
            values.extend(raw.get(key) for key in ('id', 'subscribed_id'))
        for identity in dict.fromkeys(value for value in values if _reference(value)):
            identities.setdefault(identity, []).append(mapping_key)
    return identities


def extract_variables(response: ApiResponse, file_key: str, reference_ids: list[str], *,
                      collection_ids: list[str] | None = None) -> Collected:
    """Collect exact requested definitions and locally available alias/parent closure.

    Availability describes metadata, not a computed value. Candidate records for an
    ambiguous reference are retained but cannot expand the closure.
    """
    data = {name: [] for name in ('variables', 'variable_collections', 'alias_links', 'unresolved_references')}
    coverage = {'request_scope': 'file-variable-metadata', 'complete': False,
                'cache': response.cache, 'fields': {}, 'catalog': {}, 'reference_states': {}}
    warnings = []
    partial = False

    def warn(code, pointer):
        nonlocal partial
        partial = True
        warnings.append(code + ': ' + pointer)

    def provenance(pointer):
        return {'source': 'figma-rest', 'file_key': file_key, 'json_pointer': pointer,
                'pointer_basis': 'response', 'fetched_at': response.fetched_at,
                'version': None, 'cache': response.cache}

    def observe(raw, key, expected, pointer):
        counts = coverage['fields'].setdefault(key, {'absent': 0, 'empty': 0, 'present': 0, 'invalid': 0})
        if key not in raw:
            counts['absent'] += 1
            return None
        value = raw[key]
        if not isinstance(value, expected):
            counts['invalid'] += 1
            warn('invalid_' + key, pointer)
        elif not value:
            counts['empty'] += 1
        else:
            counts['present'] += 1
        return value

    payload = response.payload
    success = (isinstance(payload, dict) and type(payload.get('status')) is int
               and payload['status'] == 200 and payload.get('error') is False)
    if not success:
        warn('invalid_variable_response', '')
    meta = payload.get('meta') if isinstance(payload, dict) else None
    if not isinstance(meta, dict):
        warn('invalid_variable_meta', '/meta')
        meta = {}
    tables = {}
    for field, name in [('variables', 'variables'), ('variableCollections', 'variable_collections')]:
        raw = observe(meta, field, dict, '/meta/' + field)
        if field not in meta:
            warn('missing_variable_map', '/meta/' + field)
        tables[name] = raw if isinstance(raw, dict) and success else {}
        malformed = sum(not (_valid_variable(value) if name == 'variables' else _valid_collection(value))
                        for value in tables[name].values())
        coverage['catalog'][name] = {'total': len(tables[name]), 'malformed': malformed, 'collected': 0}
        if malformed:
            warn('malformed_catalog_entries', '/meta/' + field)
    variables = tables['variables']
    collections = tables['variable_collections']
    variable_index = _index(variables)
    collection_index = _index(collections)
    requested = list(dict.fromkeys(ref for ref in reference_ids if _reference(ref)))
    pending_refs = deque((ref, '/meta/variables') for ref in requested)
    pending_collections = deque(ref for ref in (collection_ids or []) if _reference(ref))
    visited_refs, emitted_variables, selected_variables = set(), set(), set()
    visited_collections, emitted_collections = set(), set()
    selected_collections = []
    processed_overrides = set()
    relations = {}

    def emit_variable(mapping_key):
        if mapping_key not in emitted_variables:
            emitted_variables.add(mapping_key)
            data['variables'].append({'mapping_key': mapping_key, 'raw': variables[mapping_key],
                                      'provenance': provenance('/meta/variables/' + _escape(mapping_key))})

    def unresolved(reference, reason, pointer):
        coverage['reference_states'][reference] = 'unresolved'
        data['unresolved_references'].append({'reference_id': reference, 'reason': reason,
                                             'provenance': provenance(pointer)})
        warn('unresolved_variable_' + reason, pointer)

    def value_aliases(raw, pointer, variable_id, collection_id, mode_id, *, override=False):
        # Walk only documented composed color fields; unknown objects remain raw.
        stack = [(raw, pointer, 'value')]
        while stack:
            value, location, role = stack.pop()
            if isinstance(value, dict) and value.get('type') == 'VARIABLE_ALIAS':
                reference = value.get('id')
                if not _reference(reference):
                    warn('malformed_variable_alias', location)
                    continue
                data['alias_links'].append({
                    'source_variable_id': variable_id, 'source_collection_id': collection_id,
                    'mode_id': mode_id, 'reference_id': reference, 'json_pointer': location,
                    'provenance': provenance(location)})
                pending_refs.append((reference, location))
            elif isinstance(value, dict) and role == 'value' and 'color' in value and 'opacity' in value:
                if set(value) - {'color', 'opacity'}:
                    warn('unknown_composed_color_fields', location)
                stack.append((value['opacity'], location + '/opacity', 'opacity'))
                stack.append((value['color'], location + '/color', 'color'))
            elif isinstance(value, dict) and role != 'opacity' and (
                    set(value) in ({'r', 'g', 'b'}, {'r', 'g', 'b', 'a'})
                    and all(type(channel) in (int, float) for channel in value.values())):
                pass
            elif role == 'color' or isinstance(value, (dict, list)) or value is None and not override:
                warn('unknown_variable_value', location)
            elif role == 'opacity' and type(value) not in (int, float):
                warn('malformed_color_opacity', location)

    def modes(raw, pointer, variable_id, collection_id, *, override=False):
        if not isinstance(raw, dict):
            warn('invalid_variable_modes', pointer)
            return
        for mode_id, value in raw.items():
            value_aliases(value, pointer + '/' + _escape(mode_id), variable_id,
                          collection_id, mode_id if _reference(mode_id) else None, override=override)

    while pending_refs or pending_collections:
        while pending_refs:
            reference, source_pointer = pending_refs.popleft()
            if reference in visited_refs:
                continue
            visited_refs.add(reference)
            candidates = variable_index.get(reference, [])
            for mapping_key in candidates:
                emit_variable(mapping_key)
            if not candidates:
                unresolved(reference, 'not_returned' if success and isinstance(meta.get('variables'), dict)
                           else 'malformed', source_pointer)
                continue
            if len(candidates) != 1:
                unresolved(reference, 'ambiguous_reference', source_pointer)
                continue
            mapping_key = candidates[0]
            raw = variables[mapping_key]
            pointer = '/meta/variables/' + _escape(mapping_key)
            if not _valid_variable(raw):
                unresolved(reference, 'malformed', pointer)
                continue
            if raw.get('deletedButReferenced') is True:
                unresolved(reference, 'deleted_but_referenced', pointer)
                continue
            coverage['reference_states'][reference] = 'available'
            if mapping_key in selected_variables:
                continue
            selected_variables.add(mapping_key)
            pending_collections.append(raw['variableCollectionId'])
            modes(raw['valuesByMode'], pointer + '/valuesByMode', raw.get('id'), raw.get('variableCollectionId'))
        while pending_collections:
            reference = pending_collections.popleft()
            if reference in visited_collections:
                continue
            visited_collections.add(reference)
            candidates = collection_index.get(reference, [])
            if len(candidates) != 1:
                warn('ambiguous_collection' if candidates else 'collection_not_returned', '/meta/variableCollections')
            for mapping_key in candidates:
                if mapping_key in emitted_collections:
                    continue
                emitted_collections.add(mapping_key)
                raw = collections[mapping_key]
                pointer = '/meta/variableCollections/' + _escape(mapping_key)
                data['variable_collections'].append({'mapping_key': mapping_key, 'raw': raw,
                                                    'provenance': provenance(pointer)})
                if len(candidates) != 1 or not isinstance(raw, dict):
                    warn('malformed_collection', pointer)
                    continue
                if not _valid_collection(raw):
                    warn('malformed_collection', pointer)
                selected_collections.append(mapping_key)
                raw_modes = observe(raw, 'modes', list, pointer + '/modes')
                if isinstance(raw_modes, list):
                    for index, mode in enumerate(raw_modes):
                        if (not isinstance(mode, dict) or not _reference(mode.get('modeId'))
                                or not isinstance(mode.get('name'), str)
                                or 'parentModeId' in mode and not _reference(mode['parentModeId'])):
                            warn('malformed_collection_mode', pointer + '/modes/' + str(index))
                parents = []
                for key in ('parentVariableCollectionId', 'rootVariableCollectionId'):
                    if key in raw:
                        if _reference(raw[key]):
                            parents.append(raw[key])
                            pending_collections.append(raw[key])
                        else:
                            warn('malformed_collection_relation', pointer + '/' + key)
                relations[mapping_key] = parents
                if 'variableOverrides' in raw and not isinstance(raw['variableOverrides'], dict):
                    warn('malformed_variable_overrides', pointer + '/variableOverrides')
        # Revisit overrides after each closure expansion. Do not seed from unused
        # variableIds or override keys, even when their collection was observed.
        for mapping_key in selected_collections:
            raw = collections[mapping_key]
            overrides = raw.get('variableOverrides')
            if not isinstance(overrides, dict):
                continue
            for reference, values in overrides.items():
                identity = (mapping_key, reference)
                candidates = variable_index.get(reference, [])
                if (identity in processed_overrides or len(candidates) != 1
                        or candidates[0] not in selected_variables):
                    continue
                processed_overrides.add(identity)
                variable = variables[candidates[0]]
                pointer = '/meta/variableCollections/' + _escape(mapping_key) + '/variableOverrides/' + _escape(reference)
                modes(values, pointer, variable.get('id'), raw.get('id'), override=True)
    # Iterative DFS over returned parent/root relations distinguishes cycles from
    # legitimate repeated root references and converging extension branches.
    colors = {}
    for start in selected_collections:
        if colors.get(start):
            continue
        stack = [(start, False)]
        while stack:
            key, leaving = stack.pop()
            if leaving:
                colors[key] = 2
                continue
            if colors.get(key) == 1:
                warn('collection_parent_cycle', '/meta/variableCollections/' + _escape(key))
                continue
            if colors.get(key) == 2:
                continue
            colors[key] = 1
            stack.append((key, True))
            for reference in reversed(relations.get(key, [])):
                candidates = collection_index.get(reference, [])
                if len(candidates) == 1 and candidates[0] in relations:
                    stack.append((candidates[0], False))
    states = coverage['reference_states']
    coverage['references'] = {'requested': len(requested), 'encountered': len(states),
                              'available': sum(state == 'available' for state in states.values()),
                              'unresolved': sum(state == 'unresolved' for state in states.values())}
    for name in ('variables', 'variable_collections'):
        coverage['catalog'][name]['collected'] = len(data[name])
    coverage['collections'] = {name: {'total': len(rows), 'returned': len(rows), 'truncated': False}
                               for name, rows in data.items()}
    if any(counts['absent'] for counts in coverage['fields'].values()):
        warnings.append('fields_not_returned')
    return Collected(data, coverage, warnings, partial)
