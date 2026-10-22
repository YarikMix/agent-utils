"""Bounded read-only prototype graph collection and independent projection."""
from heapq import heappop, heappush
from itertools import count

from figma_ops_core import Client, OpsError, Target, envelope, parse_target
from figma_ops_interactions import extract_interactions
from figma_ops_nodes import find_node, require_document, walk_nodes
from figma_ops_scope import Collected, LoadedScope, load_scope


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


def _observation(root_id, depth, response=None, error=None):
    return {'requested_root_id': root_id, 'depth': depth,
            'fetched_at': response.fetched_at if response else None,
            'version': response.payload.get('version') if response else None,
            'cache': response.cache if response else None,
            'state': 'failed' if error else 'collected', 'error': error}


def _unvisited_root(root, visited):
    """Copy only new child paths, preserving first-observed nodes and raw actions."""
    copied = {key: value for key, value in root.items() if key != 'children'}
    seen = set(visited)
    seen.add(root.get('id'))
    stack = [(root, copied)]
    while stack:
        node, destination = stack.pop()
        if 'children' not in node:
            continue
        destination['children'] = []
        for child in node['children']:
            node_id = child.get('id')
            if node_id in seen:
                continue
            seen.add(node_id)
            new_child = {key: value for key, value in child.items() if key != 'children'}
            destination['children'].append(new_child)
            stack.append((child, new_child))
    return copied


def collect_prototype(scope: LoadedScope, client: Client, *, follow: int = 0,
                      max_frames: int = 20) -> Collected:
    """BFS over confirmed NODE edges; GET attempts, including failures, spend slots.

    Dependencies already returned by REST remain outside the collected scope until
    an edge reaches them within the requested graph depth. Observations describe
    individual requests; the initial response still owns envelope metadata.
    """
    if (type(follow) is not int or not 0 <= follow <= 3
            or type(max_frames) is not int or not 1 <= max_frames <= 50):
        raise OpsError('invalid_argument', 'Invalid prototype traversal budget.')
    data = {name: [] for name in ('interactions', 'actions', 'edges', 'timings', 'legacy')}
    warnings = []
    visited = set()
    visited_ids = []
    known = {}
    queue = []
    sequence = count()
    node_depths = {}
    edges_by_node = {}
    attempt_errors = {}
    frontier = {}
    observations = [_observation(scope.root['id'], 0, scope.response)]
    coverage = None
    partial = False
    requested = successful = 1
    failed = expanded_loaded = 0
    rate_error = None

    def enqueue(edge, depth):
        heappush(queue, (depth, next(sequence), edge))

    def index_loaded(response, root=None, prefix=None):
        # Prefer the selected subtree if a response repeats IDs in dependencies.
        roots = [(root, prefix)] if root is not None else []
        roots.append((require_document(response), []))
        for root, prefix in roots:
            for node, ancestors in walk_nodes(root):
                known.setdefault(node.get('id'), (node, prefix + ancestors, response))
        # A valid response can make an earlier confirmed edge locally available,
        # including when its own requested root is missing from that response.
        for item in frontier.values():
            if (item['depth'] <= follow and item['destination_id'] in known
                    and item['depth'] < node_depths.get(item['destination_id'], float('inf'))):
                enqueue(item, item['depth'])

    def expand(loaded, depth):
        nonlocal coverage, partial
        if loaded.root.get('id') not in visited:
            root = _unvisited_root(loaded.root, visited)
            exact = LoadedScope(loaded.target, loaded.response, loaded.source,
                                loaded.source_ancestors, root, loaded.root_ancestors)
            extracted = extract_interactions(exact)
            for node, _ in walk_nodes(root):
                node_id = node.get('id')
                visited.add(node_id)
                visited_ids.append(node_id)
            if coverage is None:
                coverage = dict(extracted.coverage)
            else:
                for key, value in extracted.coverage.items():
                    if type(value) is int:
                        coverage[key] += value
            for name, records in extracted.data.items():
                data[name].extend(records)
            for edge in extracted.data['edges']:
                edges_by_node.setdefault(edge['source_node_id'], []).append(edge)
            for warning in extracted.warnings:
                if warning not in warnings:
                    warnings.append(warning)
            partial = partial or extracted.partial
        # A rescued root can shorten paths to previously collected nodes. Reuse
        # their first evidence rows while propagating the improved graph depth.
        for node, _ in walk_nodes(loaded.root):
            node_id = node.get('id')
            if node_id in visited and depth < node_depths.get(node_id, float('inf')):
                node_depths[node_id] = depth
                for edge in edges_by_node.get(node_id, []):
                    enqueue(edge, depth + 1)

    def defer(edge, depth, reason, error=None):
        destination = edge['destination_id']
        if destination in frontier and frontier[destination]['depth'] <= depth:
            return
        frontier[destination] = {key: edge[key] for key in (
            'source_node_id', 'interaction_index', 'action_path', 'condition_path',
            'destination_id', 'provenance')} | {'depth': depth, 'reason': reason, 'error': error}

    index_loaded(scope.response, scope.root, scope.root_ancestors)
    expand(scope, 0)
    while queue:
        depth, _, edge = heappop(queue)
        destination = edge['destination_id']
        if destination in visited:
            if depth < node_depths[destination]:
                node, ancestors, response = known[destination]
                loaded = LoadedScope(Target(scope.target.file_key, destination), response,
                                     node, ancestors, node, ancestors)
                expand(loaded, depth)
            continue
        if depth > follow:
            defer(edge, depth, 'depth_limit')
            continue
        if destination in known:
            node, ancestors, response = known[destination]
            loaded = LoadedScope(Target(scope.target.file_key, destination), response,
                                 node, ancestors, node, ancestors)
            expanded_loaded += 1
            expand(loaded, depth)
            continue
        if destination in attempt_errors:
            reason, error = attempt_errors[destination]
            defer(edge, depth, reason, error)
            continue
        if rate_error is not None:
            defer(edge, depth, 'rate_limited', rate_error)
            continue
        if requested >= max_frames:
            defer(edge, depth, 'frame_limit')
            continue
        # Reserve before the request: cache hits and unsuccessful reads count too.
        requested += 1
        response = None
        try:
            response = client.get_json(f'files/{scope.target.file_key}', {'ids': destination})
            index_loaded(response)
            node, ancestors = find_node(require_document(response), destination)
            loaded = LoadedScope(Target(scope.target.file_key, destination), response,
                                 node, ancestors, node, ancestors)
        except OpsError as error:
            failed += 1
            safe_error = {'code': error.code, 'message': error.message,
                          'http_status': error.http_status, 'retry_after': error.retry_after}
            observations.append(_observation(destination, depth, response, safe_error))
            reason = error.code if error.code in (
                'forbidden', 'not_found_or_inaccessible', 'rate_limited', 'network_error') else 'network_error'
            attempt_errors[destination] = (reason, safe_error)
            defer(edge, depth, reason, safe_error)
            if error.code == 'rate_limited':
                rate_error = safe_error
            continue
        successful += 1
        observations.append(_observation(destination, depth, response))
        expand(loaded, depth)

    # A later reached subtree can cover an earlier deferred destination.
    frontier = [item for item in frontier.values() if item['destination_id'] not in visited]
    versions = list(dict.fromkeys(item['version'] for item in observations if item['version'] is not None))
    if len(versions) > 1:
        warnings.append('document_versions_differ')
    # Recompute the extractor's field state over the full followed coverage.
    if coverage['nodes_with_invalid_interactions']:
        coverage['interactions_field_state'] = 'invalid'
    elif coverage['nodes_without_interactions_field'] == coverage['scanned_nodes']:
        coverage['interactions_field_state'] = 'missing'
    elif coverage['nodes_with_empty_interactions'] == coverage['scanned_nodes']:
        coverage['interactions_field_state'] = 'explicit-empty'
    else:
        coverage['interactions_field_state'] = 'present'
    coverage.update(follow=follow, max_frames=max_frames, requested_roots=requested,
                    successful_roots=successful, failed_roots=failed,
                    expanded_from_loaded_nodes=expanded_loaded, visited_ids=visited_ids,
                    versions=versions)
    return Collected({**data, 'frontier': frontier, 'observations': observations},
                     coverage, warnings, partial or bool(frontier))


def prototype(args, client: Client) -> dict:
    scope = load_scope(client, parse_target(args.target, args.node))
    result = collect_prototype(scope, client, follow=args.follow, max_frames=args.max_frames)
    projected = project_prototype(result, None if args.output is not None else args.limit)
    return envelope('prototype', scope.target.file_key, projected.data, response=scope.response,
                    version=scope.response.payload.get('version'), coverage=projected.coverage,
                    warnings=projected.warnings, status='partial' if projected.partial else 'ok')
