"""Read complete comment threads before applying discussion-level filters."""
from datetime import datetime, timezone

from figma_ops_core import Client, OpsError, envelope, parse_target
from figma_ops_nodes import find_node, load_nodes, require_document, walk_nodes


def _comment(item):
    return {'id': item.get('id'), 'parent_id': item.get('parent_id', ''),
            'author': item.get('user'), 'created_at': item.get('created_at'),
            'resolved_at': item.get('resolved_at'), 'message': item.get('message', ''),
            'client_meta': item.get('client_meta')}


def _order(item):
    try:
        created = datetime.fromisoformat(item['created_at'].replace('Z', '+00:00'))
        if created.utcoffset() is None:
            raise ValueError
    except (KeyError, TypeError, ValueError, AttributeError):
        raise OpsError('invalid_response', 'Comment creation time is missing or invalid.') from None
    return created.astimezone(timezone.utc), str(item.get('id', ''))


def _load_threads(client, target):
    response = client.get_json(f'files/{target.file_key}/comments')
    raw = response.payload.get('comments')
    if not isinstance(raw, list) or any(not isinstance(item, dict) or not item.get('id') for item in raw):
        raise OpsError('invalid_response', 'Figma response has no valid comments list.')
    by_id = {item['id']: item for item in raw}
    grouped = {}
    for item in raw:
        root = item
        visited = set()
        while root.get('parent_id') and root['id'] not in visited:
            visited.add(root['id'])
            parent = by_id.get(root['parent_id'])
            if parent is None:
                break
            root = parent
        orphan = bool(root.get('parent_id'))
        root_id = root['parent_id'] if orphan else root['id']
        thread = grouped.setdefault(root_id, {'root_id': root_id, 'root': None if orphan else _comment(root),
                                              'replies': [], 'orphan': orphan})
        if orphan or item['id'] != root_id:
            thread['replies'].append(_comment(item))
    threads = list(grouped.values())
    for thread in threads:
        thread['replies'].sort(key=_order)
    threads.sort(key=lambda thread: _order(thread['root'] or thread['replies'][0]))
    return response, threads, len(raw)


def _members(thread):
    return ([thread['root']] if thread['root'] is not None else []) + thread['replies']


def _warnings(threads):
    count = sum(thread['orphan'] for thread in threads)
    return ([f'{count} orphan thread(s) have missing roots; full context and root status are unavailable.']
            if count else [])


def comments(args, client: Client) -> dict:
    target = parse_target(args.target, args.node)
    response, threads, total_comments = _load_threads(client, target)
    warnings = _warnings(threads)
    coverage = {'scope': {'kind': 'file'}, 'total_comments': total_comments,
                'total_threads': len(threads)}
    selected = threads
    if target.node_id:
        nodes_response = load_nodes(client, target)
        root, _ = find_node(require_document(nodes_response), target.node_id)
        ids = {node.get('id') for node, _ in walk_nodes(root)}
        unassigned = 0
        selected = []
        for thread in threads:
            meta = (thread['root'] or {}).get('client_meta') or {}
            node_id = meta.get('node_id')
            if not node_id:
                unassigned += 1
            elif node_id in ids:
                selected.append(thread)
        coverage.update(scope={'kind': 'node-and-descendants', 'node_id': target.node_id},
                        unassigned_count=unassigned,
                        node_scope={'version': nodes_response.payload.get('version'),
                                    'fetched_at': nodes_response.fetched_at, 'cache': nodes_response.cache})
        if unassigned:
            warnings.append(f'{unassigned} thread(s) have unassigned or coordinate-only root pins; '
                            'they are not covered by the node scope.')
    matched = []
    for thread in selected:
        members = _members(thread)
        if args.query is not None and not any(args.query.casefold() in item['message'].casefold() for item in members):
            continue
        if args.author is not None and not any(args.author.casefold() in
                ((item['author'] or {}).get('handle') or '').casefold() for item in members):
            continue
        if args.status != 'all':
            if thread['root'] is None:
                continue
            resolved = bool(thread['root']['resolved_at'])
            if resolved != (args.status == 'resolved'):
                continue
        matched.append(thread)
    coverage.update(matched_threads=len(matched), returned_threads=min(len(matched), args.limit),
                    truncated=len(matched) > args.limit)
    return envelope('comments', target.file_key, {'threads': matched[:args.limit]}, response=response,
                    coverage=coverage, warnings=warnings,
                    status='partial' if any(t['orphan'] for t in threads) else 'ok',
                    version=response.payload.get('version'))


def thread(args, client: Client) -> dict:
    # URL node provenance must not restrict lookup of the complete conversation.
    target = parse_target(args.target)
    response, threads, total_comments = _load_threads(client, target)
    selected = next((item for item in threads if any(comment['id'] == args.comment
                                                     for comment in _members(item))), None)
    if selected is None:
        raise OpsError('not_found_or_inaccessible', 'Requested comment was not found in this file.')
    return envelope('thread', target.file_key, {'thread': selected}, response=response,
                    coverage={'scope': {'kind': 'file'}, 'total_comments': total_comments,
                              'total_threads': len(threads), 'matched_threads': 1,
                              'returned_threads': 1, 'truncated': False},
                    status='partial' if selected['orphan'] else 'ok', warnings=_warnings([selected]),
                    version=response.payload.get('version'))
