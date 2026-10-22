"""Read complete comment threads before applying discussion-level filters."""
from datetime import datetime, timezone

from figma_ops_core import ApiResponse, Client, OpsError, Target, envelope, parse_target
from figma_ops_nodes import find_node, load_nodes, require_document, walk_nodes
from figma_ops_scope import Collected


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


def load_threads(client: Client, target: Target) -> tuple[ApiResponse, list[dict], int]:
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


def _root_pin(thread):
    """Return an exact usable node ID and whether the raw pin is malformed."""
    meta = (thread['root'] or {}).get('client_meta')
    if meta is None:
        return None, False
    if not isinstance(meta, dict):
        return None, True
    node_id = meta.get('node_id')
    if node_id is None or node_id == '':
        return None, False
    if not isinstance(node_id, str) or not node_id.strip():
        return None, True
    return node_id, False


def select_threads(threads: list[dict], *, node_ids: set[str] | None = None,
                   query: str | None = None, author: str | None = None,
                   status: str = 'all') -> Collected:
    """Select complete branches using only their root pin and member text."""
    warnings = _warnings(threads)
    pins = [_root_pin(thread) for thread in threads]
    unassigned = sum(node_id is None for node_id, _ in pins)
    invalid = any(malformed for _, malformed in pins)
    if invalid:
        warnings.append('invalid_root_pin')
    if node_ids is not None and unassigned:
        warnings.append(f'{unassigned} thread(s) have unassigned or coordinate-only root pins; '
                        'they are not covered by the node scope.')
    matched = []
    for thread, (node_id, _) in zip(threads, pins):
        if node_ids is not None:
            if node_id is None or node_id not in node_ids:
                continue
        members = _members(thread)
        if query is not None and not any(query.casefold() in item['message'].casefold() for item in members):
            continue
        if author is not None and not any(author.casefold() in
                ((item['author'] or {}).get('handle') or '').casefold() for item in members):
            continue
        if status != 'all':
            if thread['root'] is None:
                continue
            if bool(thread['root']['resolved_at']) != (status == 'resolved'):
                continue
        matched.append(thread)
    return Collected({'threads': matched},
                     {'total_threads': len(threads), 'matched_threads': len(matched),
                      'unassigned_count': unassigned}, warnings,
                     invalid or any(thread['orphan'] for thread in threads))


def comments(args, client: Client) -> dict:
    target = parse_target(args.target, args.node)
    response, threads, total_comments = load_threads(client, target)
    coverage = {'scope': {'kind': 'file'}, 'total_comments': total_comments,
                'total_threads': len(threads)}
    ids = None
    if target.node_id:
        nodes_response = load_nodes(client, target)
        root, _ = find_node(require_document(nodes_response), target.node_id)
        ids = {node.get('id') for node, _ in walk_nodes(root)}
        coverage.update(scope={'kind': 'node-and-descendants', 'node_id': target.node_id},
                        node_scope={'version': nodes_response.payload.get('version'),
                                    'fetched_at': nodes_response.fetched_at, 'cache': nodes_response.cache})
    selected = select_threads(threads, node_ids=ids, query=args.query, author=args.author, status=args.status)
    if ids is not None:
        coverage['unassigned_count'] = selected.coverage['unassigned_count']
    matched = selected.data['threads']
    warnings = selected.warnings
    # --output preserves all matches in the artifact; stdout becomes a summary.
    returned = matched if args.output is not None else matched[:args.limit]
    coverage.update(matched_threads=len(matched), returned_threads=len(returned),
                    truncated=len(returned) < len(matched))
    return envelope('comments', target.file_key, {'threads': returned}, response=response,
                    coverage=coverage, warnings=warnings,
                    status='partial' if selected.partial else 'ok',
                    version=response.payload.get('version'))


def thread(args, client: Client) -> dict:
    # URL node provenance must not restrict lookup of the complete conversation.
    target = parse_target(args.target)
    response, threads, total_comments = load_threads(client, target)
    selected = next((item for item in threads if any(comment['id'] == args.comment
                                                     for comment in _members(item))), None)
    if selected is None:
        raise OpsError('not_found_or_inaccessible', 'Requested comment was not found in this file.')
    selection = select_threads([selected])
    return envelope('thread', target.file_key, {'thread': selected}, response=response,
                    coverage={'scope': {'kind': 'file'}, 'total_comments': total_comments,
                              'total_threads': len(threads), 'matched_threads': 1,
                              'returned_threads': 1, 'truncated': False},
                    status='partial' if selection.partial else 'ok',
                    warnings=selection.warnings,
                    version=response.payload.get('version'))
