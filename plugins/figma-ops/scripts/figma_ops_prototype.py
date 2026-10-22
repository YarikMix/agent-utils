"""Read-only prototype follow0 collection and independent inline projection."""
from figma_ops_core import Client, envelope, parse_target
from figma_ops_interactions import extract_interactions
from figma_ops_nodes import walk_nodes
from figma_ops_scope import Collected, load_scope


def _copy_json(value):
    """Copy JSON containers iteratively, including deeply nested raw action trees."""
    if not isinstance(value, (dict, list)):
        return value
    root = {} if isinstance(value, dict) else []
    memo = {id(value): root}
    stack = [(value, root)]
    while stack:
        original, copied = stack.pop()
        items = original.items() if isinstance(original, dict) else enumerate(original)
        for key, item in items:
            if isinstance(item, (dict, list)):
                if id(item) not in memo:
                    memo[id(item)] = {} if isinstance(item, dict) else []
                    stack.append((item, memo[id(item)]))
                child = memo[id(item)]
            else:
                child = item
            if isinstance(copied, dict):
                copied[key] = child
            else:
                copied.append(child)
    return root


def project_prototype(result: Collected, limit: int | None) -> Collected:
    """Limit each inline list after collection, without trimming raw action trees."""
    selected = {}
    counters = {}
    for name, records in result.data.items():
        if isinstance(records, list):
            returned = records if limit is None else records[:limit]
            selected[name] = returned
            counters[name] = {'total': len(records), 'returned': len(returned),
                              'truncated': len(returned) < len(records)}
        else:
            selected[name] = records
    return Collected(_copy_json(selected), _copy_json({**result.coverage, 'collections': counters}),
                     list(result.warnings), result.partial)


def prototype(args, client: Client) -> dict:
    scope = load_scope(client, parse_target(args.target, args.node))
    result = extract_interactions(scope)
    internal = {node.get('id') for node, _ in walk_nodes(scope.root)}
    frontier = []
    seen = set()
    for edge in result.data['edges']:
        destination = edge['destination_id']
        if destination not in internal and destination not in seen:
            seen.add(destination)
            frontier.append({'destination_id': destination, 'reason': 'depth_limit',
                             'source_node_id': edge['source_node_id'],
                             'interaction_index': edge['interaction_index'],
                             'action_path': edge['action_path'], 'condition_path': edge['condition_path'],
                             'provenance': edge['provenance']})
    result = Collected({**result.data, 'frontier': frontier},
                       {**result.coverage, 'follow': 0, 'requested_roots': 1, 'successful_roots': 1,
                        'failed_roots': 0, 'expanded_from_loaded_nodes': 0},
                       result.warnings, result.partial or bool(frontier))
    projected = project_prototype(result, None if args.output is not None else args.limit)
    return envelope('prototype', scope.target.file_key, projected.data, response=scope.response,
                    version=scope.response.payload.get('version'), coverage=projected.coverage,
                    warnings=projected.warnings, status='partial' if projected.partial else 'ok')
