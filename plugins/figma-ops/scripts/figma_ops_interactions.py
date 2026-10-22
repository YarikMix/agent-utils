"""Pure, iterative extraction of REST interactions and unevaluated action evidence."""
from figma_ops_nodes import walk_nodes
from figma_ops_scope import Collected, LoadedScope, node_identity


_ACTIONS = {'NODE', 'BACK', 'CLOSE', 'URL', 'SET_VARIABLE', 'SET_VARIABLE_MODE', 'CONDITIONAL', 'UPDATE_MEDIA'}
_TRIGGERS = {'ON_CLICK', 'ON_HOVER', 'ON_PRESS', 'ON_DRAG', 'AFTER_TIMEOUT', 'MOUSE_ENTER',
             'MOUSE_LEAVE', 'MOUSE_UP', 'MOUSE_DOWN', 'ON_KEY_DOWN', 'ON_MEDIA_HIT', 'ON_MEDIA_END'}
_NAVIGATIONS = {'NAVIGATE', 'SWAP', 'OVERLAY', 'CHANGE_TO', 'SCROLL_TO'}
_TRANSITIONS = {'DISSOLVE', 'SMART_ANIMATE', 'SCROLL_ANIMATE', 'MOVE_IN', 'MOVE_OUT', 'PUSH', 'SLIDE_IN', 'SLIDE_OUT'}
_EASINGS = {'EASE_IN', 'EASE_OUT', 'EASE_IN_AND_OUT', 'LINEAR', 'EASE_IN_BACK', 'EASE_OUT_BACK',
            'EASE_IN_AND_OUT_BACK', 'CUSTOM_CUBIC_BEZIER', 'CUSTOM_SPRING', 'GENTLE', 'QUICK', 'BOUNCY', 'SLOW'}
_LEGACY_FIELDS = ('transitionNodeID', 'transitionDuration', 'transitionEasing')


def _pointer(path, key):
    return path + '/' + str(key).replace('~', '~0').replace('/', '~1')


def _known(value, choices):
    return isinstance(value, str) and value in choices


def _timings(raw, path, base):
    """Walk all payload fields without interpreting expressions or guessing units.

    Temporal field names identify raw evidence only; documentation is attached to
    exact known REST field locations. No numeric magnitude implies a unit.
    """
    stack = [(raw, path)]
    while stack:
        value, pointer = stack.pop()
        if pointer is None:
            item, field, unit = value['__timing__']
            yield {**base, 'raw_value': item, 'raw_field': field, 'documented_unit': unit,
                   'verified_unit': None, 'normalized_ms': None, 'unit_basis': 'unverified',
                   'provenance': {**base['provenance'], 'json_pointer': field}}
            continue
        if isinstance(value, dict):
            for key, item in reversed(list(value.items())):
                field = _pointer(pointer, key)
                if isinstance(item, (int, float)) and not isinstance(item, bool):
                    name = str(key).casefold()
                    if any(word in name for word in ('duration', 'timeout', 'delay', 'time')):
                        unit = None
                        if ((key == 'duration' and pointer.endswith('/transition'))
                                or (key in ('timeout', 'delay') and pointer.endswith('/trigger'))
                                or key == 'transitionDuration'):
                            unit = 'ms'
                        elif key == 'mediaHitTime':
                            unit = 's'
                        # Use the same DFS order for scalar and container fields.
                        stack.append(({'__timing__': (item, field, unit)}, None))
                elif isinstance(item, (dict, list)):
                    stack.append((item, field))
        elif isinstance(value, list):
            stack.extend((item, _pointer(pointer, index)) for index, item in reversed(list(enumerate(value))))


def extract_interactions(scope: LoadedScope) -> Collected:
    """Collect the exact loaded subtree, preserving every action and raw payload.

    Branches are possible actions, never evaluated truth. This function neither
    resolves destinations nor applies limits; follow/projection belong to callers.
    """
    data = {name: [] for name in ('interactions', 'actions', 'edges', 'timings', 'legacy')}
    coverage = {'scope': 'loaded-subtree',
                'root': node_identity(scope.root, scope.root_ancestors, scope.target.file_key),
                'scanned_nodes': 0, 'nodes_with_interactions_field': 0,
                'nodes_without_interactions_field': 0, 'nodes_with_empty_interactions': 0,
                'nodes_with_invalid_interactions': 0, 'complete': False}
    warnings = []
    partial = False

    def degraded(message):
        nonlocal partial
        partial = True
        if message not in warnings:
            warnings.append(message)

    for node, ancestors in walk_nodes(scope.root):
        coverage['scanned_nodes'] += 1
        identity = node_identity(node, scope.root_ancestors + ancestors, scope.target.file_key)
        provenance = {'source': 'figma-rest', 'file_key': scope.target.file_key,
                      'node_id': node.get('id'), 'json_pointer': '',
                      'fetched_at': scope.response.fetched_at,
                      'version': scope.response.payload.get('version')}
        base = {'node': identity, 'source_node_id': node.get('id'), 'provenance': provenance}
        modern = 'interactions' in node
        raw_interactions = node.get('interactions')
        edge_start = len(data['edges'])
        if not modern:
            coverage['nodes_without_interactions_field'] += 1
        else:
            coverage['nodes_with_interactions_field'] += 1
            if not isinstance(raw_interactions, list):
                coverage['nodes_with_invalid_interactions'] += 1
                degraded('invalid_interactions_field')
                # Preserve malformed field values as evidence as well.
                data['interactions'].append({**base, 'interaction_index': None,
                                             'trigger': None, 'raw': raw_interactions,
                                             'provenance': {**provenance, 'json_pointer': '/interactions'}})
            elif not raw_interactions:
                coverage['nodes_with_empty_interactions'] += 1
            else:
                for index, raw in enumerate(raw_interactions):
                    interaction_path = f'/interactions/{index}'
                    interaction = raw if isinstance(raw, dict) else {}
                    trigger = interaction.get('trigger')
                    record = {**base, 'interaction_index': index,
                              'provenance': {**provenance, 'json_pointer': interaction_path}}
                    data['interactions'].append({**record, 'trigger': trigger, 'raw': raw})
                    data['timings'].extend(_timings(raw, interaction_path, record))
                    if not isinstance(raw, dict):
                        degraded('invalid_interaction')
                        continue
                    if not isinstance(trigger, dict) or not _known(trigger.get('type'), _TRIGGERS):
                        degraded('unknown_or_invalid_trigger')
                    actions = interaction.get('actions')
                    if not isinstance(actions, list):
                        degraded('invalid_actions_field')
                        continue
                    stack = [(action, f'/actions/{i}', None) for i, action in reversed(list(enumerate(actions)))]
                    while stack:
                        action, action_path, condition_path = stack.pop()
                        action_record = {**record, 'action_path': action_path,
                                         'condition_path': condition_path, 'raw': action,
                                         'provenance': {**provenance, 'json_pointer': interaction_path + action_path}}
                        data['actions'].append(action_record)
                        if not isinstance(action, dict):
                            degraded('invalid_action')
                            continue
                        kind = action.get('type')
                        if not _known(kind, _ACTIONS):
                            degraded('unknown_or_invalid_action_type')
                        if 'navigation' in action and not _known(action['navigation'], _NAVIGATIONS):
                            degraded('unknown_or_invalid_navigation')
                        transition = action.get('transition')
                        if transition is not None:
                            if not isinstance(transition, dict) or not _known(transition.get('type'), _TRANSITIONS):
                                degraded('unknown_or_invalid_transition')
                            elif 'easing' in transition:
                                easing = transition['easing']
                                if not isinstance(easing, dict) or not _known(easing.get('type'), _EASINGS):
                                    degraded('unknown_or_invalid_easing')
                        destination = action.get('destinationId')
                        if kind == 'NODE':
                            if isinstance(destination, str) and destination:
                                data['edges'].append({**action_record, 'destination_id': destination,
                                                      'action_type': kind, 'navigation': action.get('navigation'),
                                                      'transition': transition,
                                                      'easing': transition.get('easing') if isinstance(transition, dict) else None})
                            elif destination is not None:
                                degraded('invalid_destination_id')
                        if kind == 'CONDITIONAL' or 'conditionalBlocks' in action:
                            blocks = action.get('conditionalBlocks')
                            if not isinstance(blocks, list):
                                degraded('invalid_conditional_blocks')
                                continue
                            pending = []
                            for block_index, block in enumerate(blocks):
                                block_path = _pointer(_pointer(action_path, 'conditionalBlocks'), block_index)
                                if not isinstance(block, dict) or not isinstance(block.get('actions'), list):
                                    degraded('invalid_conditional_block')
                                    continue
                                pending.extend((child, _pointer(_pointer(block_path, 'actions'), child_index), block_path)
                                               for child_index, child in enumerate(block['actions']))
                            stack.extend(reversed(pending))
        legacy = {field: node[field] for field in _LEGACY_FIELDS if field in node}
        if legacy:
            data['legacy'].append({**base, 'raw': legacy, 'primary': not modern})
            data['timings'].extend(_timings(legacy, '', base))
            if modern:
                def matches(edge):
                    transition = edge.get('transition')
                    transition = transition if isinstance(transition, dict) else {}
                    easing = transition.get('easing') if isinstance(transition, dict) else None
                    if isinstance(easing, dict):
                        easing = easing.get('type')
                    return (('transitionNodeID' not in legacy or legacy['transitionNodeID'] == edge['destination_id'])
                            and ('transitionDuration' not in legacy or legacy['transitionDuration'] == transition.get('duration'))
                            and ('transitionEasing' not in legacy or legacy['transitionEasing'] == easing))
                if not any(matches(edge) for edge in data['edges'][edge_start:]):
                    if 'legacy_interactions_conflict' not in warnings:
                        warnings.append('legacy_interactions_conflict')
            elif 'legacy_interactions_only' not in warnings:
                warnings.append('legacy_interactions_only')
    if coverage['nodes_without_interactions_field']:
        warnings.append('fields_not_returned')
    if data['timings']:
        warnings.append('timing_units_unverified')
    if coverage['nodes_with_invalid_interactions']:
        field_state = 'invalid'
    elif coverage['nodes_without_interactions_field'] == coverage['scanned_nodes']:
        field_state = 'missing'
    elif coverage['nodes_with_empty_interactions'] == coverage['scanned_nodes']:
        field_state = 'explicit-empty'
    else:
        field_state = 'present'
    coverage['interactions_field_state'] = field_state
    return Collected(data, coverage, warnings, partial)
