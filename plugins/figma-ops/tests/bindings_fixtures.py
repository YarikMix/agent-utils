"""Pure, fresh synthetic scopes for design-system inventory tests."""
from context_fixtures import payload
from figma_ops_core import ApiResponse, Target
from figma_ops_nodes import find_node
from figma_ops_scope import LoadedScope


def library_payload() -> dict:
    body = payload()
    document = body['document']
    root = document['children'][1]['children'][0]
    source, sibling = root['children']
    source.update(componentId='5:1', componentProperties={
        'Enabled#prop': {'type': 'BOOLEAN', 'value': False},
        'Label#prop': {'type': 'TEXT', 'value': ''},
        'Variant#prop': {'type': 'VARIANT', 'value': 'Primary'},
        'Swap#prop': {'type': 'INSTANCE_SWAP', 'value': '5:2', 'preferredValues': []},
        'Content#prop': {'type': 'SLOT', 'value': {'guid': {'sessionID': 7, 'localID': 9}},
                         'slotSettings': {'extension': False}}},
        overrides=[{'id': 'I2:1;3:1', 'overriddenFields': ['characters'], 'future': 0}],
        exposedInstances=['I2:1;3:1'], isExposedInstance=False,
        styles={'fill': 's.fill'}, future={'zero': 0})
    source['children'][0]['styles'] = {'text': 's.text'}
    sibling.update(type='INSTANCE', componentId='5:2', componentProperties={})
    definitions = {'Enabled#prop': {'type': 'BOOLEAN', 'defaultValue': False},
                   'Label#prop': {'type': 'TEXT', 'defaultValue': ''},
                   'Content#prop': {'type': 'SLOT', 'defaultValue': {'guid': {'sessionID': 7, 'localID': 9}},
                                    'slotSettings': {'extension': True}}}
    document['children'][0]['children'].extend([
        {'id': '5:0', 'name': 'Button', 'type': 'COMPONENT_SET',
         'componentPropertyDefinitions': definitions, 'children': [
             {'id': '5:1', 'name': 'Button', 'type': 'COMPONENT',
              'componentPropertyDefinitions': definitions, 'children': [
                  {'id': '5:9', 'name': 'Definition child', 'type': 'TEXT'}]}]},
        {'id': '8:0', 'name': 'Button', 'type': 'COMPONENT'},
        {'id': '8:1', 'name': 'Unused set', 'type': 'COMPONENT_SET'}])
    body['components'] = {
        '5:1': {'key': 'same-key', 'name': 'Button', 'componentSetId': '5:0',
                'remote': False, 'description': '', 'documentationLinks': [{'uri': 'https://example.invalid/docs'}],
                'future': {'enabled': False}},
        '5:2': {'key': 'remote-component-key', 'name': 'Remote', 'remote': True},
        '8:0': {'key': 'same-key', 'name': 'Button', 'componentSetId': '8:1'}}
    body['componentSets'] = {'5:0': {'key': 'set-key', 'name': 'Button'},
                             '8:1': {'key': 'unused-set-key', 'name': 'Unused set'}}
    body['styles'] = {'s.fill': {'key': 'fill-key', 'name': 'Fill', 'styleType': 'FILL', 'remote': True},
                      's.text': {'key': 'text-key', 'name': 'Text', 'styleType': 'TEXT'},
                      'unused': {'key': 'unused-key', 'name': 'Unused'}}
    return body


def loaded_scope(body: dict | None = None, *, source_id: str = '2:1', root_id: str = '2:0') -> LoadedScope:
    body = library_payload() if body is None else body
    source, source_ancestors = find_node(body['document'], source_id)
    root, root_ancestors = find_node(body['document'], root_id)
    return LoadedScope(Target('Key', source_id), ApiResponse(body, '2026-01-01T00:00:00Z', 'miss'),
                       source, source_ancestors, root, root_ancestors)


def bindings_payload() -> dict:
    """Fresh library fixture with only explicit bindings and mode observations."""
    body = library_payload()
    root = body['document']['children'][1]['children'][0]
    source = root['children'][0]
    alias = lambda reference: {'type': 'VARIABLE_ALIAS', 'id': reference}
    body['document']['children'][1]['explicitVariableModes'] = {'c': 'c:dark'}
    root['explicitVariableModes'] = {'c': 'c:light'}
    source['explicitVariableModes'] = {'c': 'c:contrast'}
    source['children'][0]['explicitVariableModes'] = {'c': 'c:text'}
    source['boundVariables'] = {
        'size': {'x': alias('v.width'), 'y': alias('v.height')},
        'individualStrokeWeights': {'top': alias('v.top'), 'bottom': alias('v.bottom'),
                                    'left': alias('v.left'), 'right': alias('v.right')},
        'componentProperties': {'Label/~#prop': alias('v.label')},
        'fontSize': [alias('v.font')], 'fills': [alias('v.fill')],
        'textRangeFills': [alias('v.range')]}
    source['fills'] = [{'type': 'GRADIENT_LINEAR', 'boundVariables': {'color': alias('v.color')},
                        'gradientStops': [{'position': 0, 'boundVariables': {'color': alias('v.stop')}}]}]
    source['strokes'] = [{'type': 'SOLID', 'boundVariables': {'color': alias('v.stroke')}}]
    source['background'] = [{'type': 'SOLID', 'boundVariables': {'color': alias('v.background')}}]
    source['backgrounds'] = [{'type': 'SOLID', 'boundVariables': {'color': alias('v.backgrounds')}}]
    source['effects'] = [{'type': 'DROP_SHADOW', 'boundVariables': {'radius': alias('v.effect')}}]
    source['layoutGrids'] = [{'pattern': 'GRID', 'boundVariables': {'sectionSize': alias('v.grid')}}]
    source['style'] = {'boundVariables': {'fontSize': alias('v.style')}}
    source['styleOverrideTable'] = {'1/~': {'boundVariables': {'fontSize': alias('v.override')}}}
    source['componentProperties']['Label#prop']['boundVariables'] = {'value': alias('v.property')}
    return body


def variable_payload() -> dict:
    """Fresh synthetic Variables API metadata, independent of document snapshots."""
    variables = {}
    for name, value in [('A', {'type': 'VARIABLE_ALIAS', 'id': 'B'}),
                        ('B', {'type': 'VARIABLE_ALIAS', 'id': 'A'}), ('C', False)]:
        variables[name] = {
            'id': name, 'key': 'stable-' + name, 'name': name,
            'variableCollectionId': 'c', 'resolvedType': 'COLOR',
            'valuesByMode': {'m': value}, 'remote': False, 'description': '',
            'hiddenFromPublishing': False, 'scopes': ['ALL_SCOPES'],
            'codeSyntax': {'WEB': 'var(--token)', 'ANDROID': 'token', 'iOS': 'Token'},
            'future': {'zero': 0, 'empty': '', 'flag': False}}
    return {'status': 200, 'error': False, 'meta': {
        'variables': variables, 'variableCollections': {
            'c': {'id': 'c', 'key': 'stable-c', 'name': 'Collection',
                  'modes': [{'modeId': 'm', 'name': 'Default'}], 'defaultModeId': 'm',
                  'remote': False, 'hiddenFromPublishing': False,
                  'variableIds': ['A', 'B', 'C']}}}}
