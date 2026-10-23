"""Pure exact variable references and explicit mode observations in loaded scope."""
from figma_ops_library import extract_library
from figma_ops_nodes import walk_nodes
from figma_ops_scope import Collected, LoadedScope, node_identity


def _escape(value: str) -> str:
    return value.replace('~', '~0').replace('/', '~1')


def _reference(value) -> bool:
    return isinstance(value, str) and bool(value)


def referenced_variable_ids(bindings: Collected) -> list[str]:
    """Stable unique exact alias IDs; malformed evidence is never a reference."""
    return list(dict.fromkeys(row['reference_id'] for row in bindings.data['variable_bindings']
                              if _reference(row['reference_id'])))


def observed_collection_ids(bindings: Collected) -> list[str]:
    """Stable unique collection IDs explicitly observed, without mode inference."""
    return list(dict.fromkeys(row['collection_id'] for row in bindings.data['mode_observations']
                              if _reference(row['collection_id'])))


# Only these node properties are searched. Unknown descendants retain unknown roles.
_CONTAINERS = {
    'fills': (list, 'paint_list'), 'strokes': (list, 'paint_list'),
    'background': (list, 'paint_list'), 'backgrounds': (list, 'paint_list'),
    'effects': (list, 'effect_list'), 'layoutGrids': (list, 'grid_list'),
    'style': (dict, 'text_style'), 'styleOverrideTable': (dict, 'override_map'),
    'componentProperties': (dict, 'property_map')}
_LIST_ROLES = {'paint_list': 'paint', 'stop_list': 'gradient_stop',
               'effect_list': 'effect', 'grid_list': 'layout_grid'}
_EXCLUDED = {'children', 'pluginData', 'sharedPluginData', 'annotations', 'interactions', 'actions'}
_WRAPPERS = {'size': {'x', 'y'},
             'individualStrokeWeights': {'top', 'right', 'bottom', 'left'}}


def extract_bindings(scope: LoadedScope) -> Collected:
    """Compose used library inventory with bindings; never resolve modes or values."""
    library = extract_library(scope)
    data = dict(library.data, variable_bindings=[], mode_observations=[])
    coverage = dict(library.coverage)
    fields = {key: dict(counts) for key, counts in coverage['fields'].items()}
    coverage['fields'] = fields
    warnings = list(library.warnings)
    malformed = False
    file_key = scope.target.file_key

    def warn(code, pointer):
        nonlocal malformed
        malformed = True
        warnings.append(code + ': ' + pointer)

    def provenance(node, pointer):
        return {'source': 'figma-rest', 'file_key': file_key, 'node_id': node.get('id'),
                'json_pointer': pointer, 'pointer_basis': 'node',
                'fetched_at': scope.response.fetched_at, 'version': scope.response.payload.get('version')}

    def observe(container, key, expected, pointer):
        counts = fields.setdefault(key, {'absent': 0, 'empty': 0, 'present': 0, 'invalid': 0})
        if key not in container:
            counts['absent'] += 1
        elif not isinstance(container[key], expected):
            counts['invalid'] += 1
            warn('invalid_' + key, pointer)
        elif not container[key]:
            counts['empty'] += 1
        else:
            counts['present'] += 1

    def binding_row(node, identity, raw_container, container_pointer, raw, pointer, role, reference=None):
        data['variable_bindings'].append({
            'node': identity, 'container_role': role, 'container_pointer': container_pointer,
            'raw_container': raw_container, 'raw': raw, 'reference_id': reference,
            'definition_state': 'not_requested', 'provenance': provenance(node, pointer)})

    def binding_container(node, identity, raw, pointer, role):
        if role == 'unknown':
            warn('unknown_binding_container', pointer)
        if not isinstance(raw, dict):
            warn('invalid_binding_container', pointer)
            binding_row(node, identity, raw, pointer, raw, pointer, role)
            return
        # State distinguishes documented wrappers from arbitrary JSON nesting.
        stack = [(value, pointer + '/' + _escape(key), role, key, 'field')
                 for key, value in reversed(list(raw.items()))]
        while stack:
            value, value_pointer, value_role, field, state = stack.pop()
            if isinstance(value, dict) and ('type' in value or 'id' in value):
                reference = value.get('id')
                if value.get('type') != 'VARIABLE_ALIAS' or not _reference(reference):
                    reference = None
                    warn('invalid_variable_alias', value_pointer)
                binding_row(node, identity, raw, pointer, value, value_pointer, value_role, reference)
            elif isinstance(value, (dict, list)):
                known = state == 'field' and (
                    isinstance(value, list) or field in _WRAPPERS or field == 'componentProperties')
                if not known:
                    value_role = 'unknown'
                    warn('unknown_binding_container', value_pointer)
                if not value:
                    if not known:
                        binding_row(node, identity, raw, pointer, value, value_pointer, value_role)
                    continue
                items = list(value.items()) if isinstance(value, dict) else list(enumerate(value))
                for key, child in reversed(items):
                    child_role = value_role
                    if known and field in _WRAPPERS and key not in _WRAPPERS[field]:
                        child_role = 'unknown'
                        warn('unknown_binding_container', value_pointer + '/' + _escape(str(key)))
                    stack.append((child, value_pointer + '/' + _escape(str(key)), child_role, field, 'leaf'))
            else:
                warn('invalid_variable_alias', value_pointer)
                binding_row(node, identity, raw, pointer, value, value_pointer, value_role)

    def property_container(node, identity, raw, pointer, role):
        stack = [(raw, pointer, role, False)]
        while stack:
            value, value_pointer, value_role, is_binding = stack.pop()
            if is_binding:
                binding_container(node, identity, value, value_pointer, value_role)
                continue
            expected = list if value_role in _LIST_ROLES else dict
            if value_role != 'unknown' and not isinstance(value, expected):
                warn('invalid_binding_property_container', value_pointer)
                binding_row(node, identity, value, value_pointer, value, value_pointer,
                            _LIST_ROLES.get(value_role, value_role))
                continue
            if isinstance(value, dict):
                for key, child in reversed(list(value.items())):
                    if key in _EXCLUDED:
                        continue
                    child_pointer = value_pointer + '/' + _escape(key)
                    if key == 'boundVariables':
                        observe(value, key, dict, child_pointer)
                        stack.append((child, child_pointer, value_role, True))
                        continue
                    child_role = 'unknown'
                    if value_role == 'override_map':
                        child_role = 'text_override'
                    elif value_role == 'property_map':
                        child_role = 'component_property'
                    elif value_role == 'paint' and key == 'gradientStops':
                        child_role = 'stop_list'
                    elif value_role in ('text_style', 'text_override') and key in _CONTAINERS:
                        child_role = _CONTAINERS[key][1]
                    stack.append((child, child_pointer, child_role, False))
            elif isinstance(value, list):
                child_role = _LIST_ROLES.get(value_role, 'unknown')
                stack.extend((child, value_pointer + '/' + str(index), child_role, False)
                             for index, child in reversed(list(enumerate(value))))

    def modes(node, ancestors, location):
        pointer = '/explicitVariableModes'
        observe(node, 'explicitVariableModes', dict, pointer)
        if 'explicitVariableModes' not in node:
            return
        raw = node['explicitVariableModes']
        identity = node_identity(node, ancestors, file_key)
        if not isinstance(raw, dict):
            data['mode_observations'].append({
                'node': identity, 'collection_id': None, 'mode_id': None, 'raw': raw,
                'location': location, 'provenance': provenance(node, pointer)})
            return
        for collection_id, mode_id in raw.items():
            value_pointer = pointer + '/' + _escape(collection_id)
            if not _reference(collection_id) or not _reference(mode_id):
                warn('invalid_mode_observation', value_pointer)
            data['mode_observations'].append({
                'node': identity, 'collection_id': collection_id if _reference(collection_id) else None,
                'mode_id': mode_id if _reference(mode_id) else None, 'raw': mode_id,
                'location': location, 'provenance': provenance(node, value_pointer)})

    # Source ancestors inside a broader root are already visited by the root DFS.
    for index, ancestor in enumerate(scope.root_ancestors):
        modes(ancestor, scope.root_ancestors[:index], 'ancestor')
    for node, relative_ancestors in walk_nodes(scope.root):
        ancestors = scope.root_ancestors + relative_ancestors
        identity = node_identity(node, ancestors, file_key)
        modes(node, ancestors, 'scope')
        observe(node, 'boundVariables', dict, '/boundVariables')
        for key, (expected, role) in _CONTAINERS.items():
            # Task1 already counted instance properties, including malformed ones.
            if key != 'componentProperties' or node.get('type') != 'INSTANCE':
                observe(node, key, expected, '/' + key)
        for key, raw in node.items():
            if key == 'boundVariables':
                binding_container(node, identity, raw, '/boundVariables', 'node')
            elif key in _CONTAINERS:
                property_container(node, identity, raw, '/' + key, _CONTAINERS[key][1])
    coverage['collections'] = {
        name: {'total': len(rows), 'returned': len(rows), 'truncated': False}
        for name, rows in data.items()}
    if any(counts['absent'] for counts in fields.values()) and 'fields_not_returned' not in warnings:
        warnings.append('fields_not_returned')
    return Collected(data, coverage, warnings, library.partial or malformed)
