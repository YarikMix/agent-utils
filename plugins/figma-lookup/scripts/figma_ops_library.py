"""Pure inventory of used components, instance properties and style references."""
from figma_ops_nodes import walk_nodes
from figma_ops_scope import Collected, LoadedScope, node_identity


def _escape(value: str) -> str:
    return value.replace('~', '~0').replace('/', '~1')


def _reference(value) -> bool:
    return isinstance(value, str) and bool(value)


def _slot(value) -> bool:
    if not isinstance(value, dict) or not isinstance(value.get('guid'), dict):
        return False
    return all(type(value['guid'].get(key)) is int for key in ('sessionID', 'localID'))


def extract_library(scope: LoadedScope) -> Collected:
    """Collect full scoped evidence; response dependencies are lookup-only definitions."""
    data = {key: [] for key in ('instances', 'components', 'component_sets', 'style_usages', 'styles')}
    coverage = {'scope': 'loaded-subtree', 'scanned_nodes': 0, 'complete': False,
                'fields': {}, 'metadata': {}, 'definitions': {}}
    warnings = []
    fields = coverage['fields']
    file_key = scope.target.file_key
    payload = scope.response.payload

    def warn(code, location):
        warnings.append(f'{code}: {location}')

    def provenance(basis, pointer, node_id=None):
        return {'source': 'figma-rest', 'file_key': file_key, 'node_id': node_id,
                'json_pointer': pointer, 'pointer_basis': basis,
                'fetched_at': scope.response.fetched_at, 'version': payload.get('version')}

    def observe(container, key, validator, location):
        counts = fields.setdefault(key, {'absent': 0, 'empty': 0, 'present': 0, 'invalid': 0})
        if key not in container:
            counts['absent'] += 1
            return None
        value = container[key]
        if not validator(value):
            counts['invalid'] += 1
            warn('invalid_' + key, location)
        elif isinstance(value, (dict, list, str)) and not value:
            counts['empty'] += 1
        else:
            counts['present'] += 1
        return value

    def properties(container, key, location):
        values = observe(container, key, lambda v: isinstance(v, dict), location)
        if not isinstance(values, dict):
            return values
        validators = {'BOOLEAN': lambda v: type(v) is bool,
                      'TEXT': lambda v: isinstance(v, str),
                      'VARIANT': lambda v: isinstance(v, str),
                      'INSTANCE_SWAP': lambda v: isinstance(v, str), 'SLOT': _slot}
        for name, raw in values.items():
            pointer = location + '/' + _escape(name)
            if not isinstance(raw, dict):
                warn('invalid_property', pointer)
                continue
            kind = raw.get('type')
            if not isinstance(kind, str) or kind not in validators:
                warn('unknown_property_type', pointer)
                continue
            required = 'defaultValue' if key == 'componentPropertyDefinitions' else 'value'
            if required not in raw:
                warn('missing_property_value', pointer + '/' + required)
            for value_key in ('value', 'defaultValue'):
                if value_key in raw and not validators[kind](raw[value_key]):
                    warn('invalid_property_value', pointer + '/' + value_key)
            for optional, validator in (
                    ('preferredValues', lambda v: isinstance(v, list) and all(
                        isinstance(item, dict) and isinstance(item.get('type'), str)
                        and isinstance(item.get('key'), str) for item in v)),
                    ('variantOptions', lambda v: isinstance(v, list) and all(isinstance(item, str) for item in v)),
                    ('slotSettings', lambda v: isinstance(v, dict))):
                if optional in raw and not validator(raw[optional]):
                    warn('invalid_property_' + optional, pointer)
        return values

    tables = {}
    for collection, field in [('components', 'components'), ('component_sets', 'componentSets'), ('styles', 'styles')]:
        raw = observe(payload, field, lambda v: isinstance(v, dict), 'response/' + field)
        tables[collection] = raw
        coverage['metadata'][collection] = {'referenced': 0, 'resolved': 0, 'unresolved': 0,
                                            'missing': 0, 'malformed': 0}
    requested = {key: {} for key in tables}
    # This index never feeds the scope scan or expands an instance's descendants.
    loaded = {node.get('id'): (node, ancestors) for node, ancestors in walk_nodes(payload['document'])
              if _reference(node.get('id'))}
    scoped = list(walk_nodes(scope.root))
    scoped_ids = {node.get('id') for node, _ in scoped if _reference(node.get('id'))}

    def request(collection, reference_id):
        if not _reference(reference_id):
            return
        requested[collection].setdefault(reference_id, None)
        if collection == 'components' and isinstance(tables[collection], dict):
            metadata = tables[collection].get(reference_id)
            set_id = metadata.get('componentSetId') if isinstance(metadata, dict) else None
            if _reference(set_id):
                requested['component_sets'].setdefault(set_id, None)

    for node, relative_ancestors in scoped:
        coverage['scanned_nodes'] += 1
        node_id = node.get('id')
        identity = node_identity(node, scope.root_ancestors + relative_ancestors, file_key)
        if node.get('type') == 'INSTANCE':
            component_id = observe(node, 'componentId', _reference, str(node_id))
            component_properties = properties(node, 'componentProperties', str(node_id) + '/componentProperties')
            overrides = observe(node, 'overrides', lambda v: isinstance(v, list) and all(isinstance(x, dict) for x in v), str(node_id))
            exposed = observe(node, 'exposedInstances', lambda v: isinstance(v, list) and all(_reference(x) for x in v), str(node_id))
            is_exposed = observe(node, 'isExposedInstance', lambda v: type(v) is bool, str(node_id))
            data['instances'].append({'node': identity, 'component_id': component_id,
                                      'component_properties': component_properties, 'overrides': overrides,
                                      'exposed_instances': exposed, 'is_exposed_instance': is_exposed,
                                      'raw': {key: value for key, value in node.items() if key != 'children'},
                                      'provenance': provenance('node', '', node_id)})
            request('components', component_id)
        elif node.get('type') in ('COMPONENT', 'COMPONENT_SET'):
            request('components' if node['type'] == 'COMPONENT' else 'component_sets', node_id)
        styles = observe(node, 'styles', lambda v: isinstance(v, dict), str(node_id))
        if 'styles' in node and not isinstance(styles, dict):
            data['style_usages'].append({'record_type': 'invalid_container', 'node': identity,
                                         'style_type': None, 'style_id': None, 'raw': styles,
                                         'provenance': provenance('node', '/styles', node_id)})
        elif isinstance(styles, dict):
            for style_type, style_id in styles.items():
                if not _reference(style_id):
                    warn('invalid_style_reference', str(node_id) + '/styles/' + _escape(style_type))
                data['style_usages'].append({'node': identity, 'style_type': style_type, 'style_id': style_id,
                                             'provenance': provenance('node', '/styles/' + _escape(style_type), node_id)})
                request('styles', style_id)

    def metadata_record(collection, reference_id):
        field = 'componentSets' if collection == 'component_sets' else collection
        table = tables[collection]
        metadata = table.get(reference_id) if isinstance(table, dict) else table
        if field not in payload or isinstance(table, dict) and reference_id not in table:
            state = 'missing'
        elif not isinstance(metadata, dict):
            state = 'malformed'
        else:
            state = 'available'
            for name in ('key', 'name', 'description', 'componentSetId', 'styleType'):
                if name in metadata and not isinstance(metadata[name], str):
                    state = 'malformed'
            if ('remote' in metadata and type(metadata['remote']) is not bool
                    or 'documentationLinks' in metadata and not isinstance(metadata['documentationLinks'], list)):
                state = 'malformed'
        counts = coverage['metadata'][collection]
        counts['referenced'] += 1
        counts['resolved' if state == 'available' else 'unresolved'] += 1
        if state != 'available':
            counts[state] += 1
        if state == 'malformed':
            warn('invalid_metadata', field + '/' + reference_id)
        pointer = '/' + field
        if isinstance(table, dict) or field not in payload:
            pointer += '/' + _escape(reference_id)
        return {'id': reference_id, 'metadata': metadata, 'metadata_state': state,
                'provenance': provenance('response', pointer)}

    def definition_record(collection, row):
        expected = 'COMPONENT' if collection == 'components' else 'COMPONENT_SET'
        found = loaded.get(row['id'])
        location = 'not_loaded'
        definition = None
        if found is not None and found[0].get('type') == expected:
            node, ancestors = found
            location = 'scope' if row['id'] in scoped_ids else 'loaded_dependency'
            definitions = properties(node, 'componentPropertyDefinitions', str(row['id']) + '/componentPropertyDefinitions')
            definition = {'node': node_identity(node, ancestors, file_key),
                          'component_property_definitions': definitions,
                          'provenance': provenance('node', '/componentPropertyDefinitions', row['id'])}
        row.update(definition=definition, definition_location=location)
        counts = coverage['definitions'].setdefault(collection, {'resolved': 0, 'missing': 0})
        counts['missing' if definition is None else 'resolved'] += 1

    for collection in ('components', 'component_sets', 'styles'):
        for reference_id in requested[collection]:
            row = metadata_record(collection, reference_id)
            if collection != 'styles':
                definition_record(collection, row)
            data[collection].append(row)
    coverage['collections'] = {name: {'total': len(rows), 'returned': len(rows), 'truncated': False}
                               for name, rows in data.items()}
    if any(counts['absent'] for counts in fields.values()):
        warnings.append('fields_not_returned')
    if any(counts['missing'] for counts in coverage['metadata'].values()):
        warnings.append('metadata_not_returned')
    partial = any(warning != 'fields_not_returned' and warning != 'metadata_not_returned' for warning in warnings)
    return Collected(data, coverage, warnings, partial)
