"""Read-only document inspection and literal search over loaded Figma nodes."""
from urllib.parse import urlencode

from figma_ops_core import ApiResponse, Client, OpsError, Target, envelope, parse_target


def walk_nodes(document: dict):
    """Yield (node, ancestors) in stable DFS order without Python recursion."""
    stack = [(document, [])]
    while stack:
        node, ancestors = stack.pop()
        yield node, ancestors
        stack.extend((child, ancestors + [node])
                     for child in reversed(node.get('children', [])))


def load_nodes(client: Client, target: Target) -> ApiResponse:
    return client.get_json(f'files/{target.file_key}',
                           {'ids': target.node_id} if target.node_id else None)


def require_document(response: ApiResponse) -> dict:
    document = response.payload.get('document')
    if not isinstance(document, dict):
        raise OpsError('invalid_response', 'Figma response has no document tree.')
    return document


def find_node(document: dict, node_id: str):
    for node, ancestors in walk_nodes(document):
        if node.get('id') == node_id:
            return node, ancestors
    raise OpsError('not_found_or_inaccessible', 'Requested node was not found in the loaded document.')


def _summary(node):
    return {key: node.get(key) for key in ('id', 'name', 'type')}


def _context(ancestors, kind):
    return next((_summary(node) for node in reversed(ancestors) if node.get('type') == kind), None)


def _coverage(scope, count):
    return {'scope': scope, 'scanned_nodes': count, 'complete': False,
            'completeness': 'loaded-document-only'}


LIMITATION = ('Coverage includes only nodes returned by the API; external components and '
              'unknown children were not inspected. Empty results do not establish absence.')


def _snippet(text, query):
    folded_index = text.casefold().find(query)
    position = 0
    source_index = 0
    for source_index, character in enumerate(text):
        position += len(character.casefold())
        if position > folded_index:
            break
    start = max(0, source_index - 60)
    return text[start:start + 200]


def _bounded_subtree(node, depth):
    """Copy child edges to local depth, without mutating the response cache."""
    result = {key: value for key, value in node.items() if key != 'children'}
    stack = [(node, result, depth)]
    while stack:
        source, destination, remaining = stack.pop()
        if remaining > 0 and 'children' in source:
            destination['children'] = []
            for child in source['children']:
                copied = {key: value for key, value in child.items() if key != 'children'}
                destination['children'].append(copied)
                stack.append((child, copied, remaining - 1))
    return result


def inspect(args, client: Client) -> dict:
    target = parse_target(args.target, args.node)
    params = {'ids': target.node_id} if target.node_id else {'depth': 1}
    # /files depth starts at the document root; it can hide a deep selected node.
    # Retrieve its ancestry without global depth, then bound the source locally.
    response = client.get_json(f'files/{target.file_key}', params)
    document = require_document(response)
    warnings = [LIMITATION]
    if target.node_id:
        node, ancestors = find_node(document, target.node_id)
        if args.depth is not None:
            node = _bounded_subtree(node, args.depth)
            warnings.append(f'Displayed source subtree is limited to depth {args.depth}; '
                            'children beyond that depth are omitted.')
        data = {'node': node, 'ancestors': [_summary(n) for n in ancestors],
                'containing_frame': _context(ancestors, 'FRAME'),
                'page': _summary(node) if node.get('type') == 'CANVAS' else _context(ancestors, 'CANVAS'),
                'children': node.get('children', [])}
        coverage = _coverage({'kind': 'node', 'node_id': target.node_id},
                             sum(1 for _ in walk_nodes(node)))
        coverage.update(depth_requested=args.depth, depth_limited=args.depth is not None)
    else:
        data = {'pages': [_summary(n) for n in document.get('children', [])
                          if n.get('type') == 'CANVAS']}
        coverage = _coverage({'kind': 'page-catalog'}, len(data['pages']))
    return envelope('inspect', target.file_key, data, response=response,
                    version=response.payload.get('version'), coverage=coverage, warnings=warnings)


def search(args, client: Client) -> dict:
    target = parse_target(args.target)
    page = parse_target(args.target, args.page).node_id if args.page is not None else None
    response = load_nodes(client, Target(target.file_key, page))
    document = require_document(response)
    root, prefix = find_node(document, page) if page else (document, [])
    query = args.query.casefold()
    matches = []
    scanned = 0
    for node, relative_ancestors in walk_nodes(root):
        scanned += 1
        if args.type and node.get('type') != args.type:
            continue
        fields = [field for field in ('name', 'characters')
                  if query in str(node.get(field, '')).casefold()]
        if not fields:
            continue
        ancestors = prefix + relative_ancestors
        text = node.get('characters', '')
        snippet_source = text if 'characters' in fields else node.get('name', '')
        matches.append({'id': node.get('id'), 'type': node.get('type'), 'name': node.get('name'),
                        'path': [n.get('name', '') for n in ancestors + [node]],
                        'page': _summary(node) if node.get('type') == 'CANVAS' else _context(ancestors, 'CANVAS'),
                        'matched_fields': fields, 'text': text, 'snippet': _snippet(snippet_source, query),
                        'url': f'https://www.figma.com/design/{target.file_key}/?' +
                               urlencode({'node-id': node.get('id', '')})})
    # The shared writer saves this envelope and emits only an artifact summary.
    # Keep the full collection for disk output; the limit bounds inline arrays.
    returned = matches if args.output is not None else matches[:args.limit]
    coverage = _coverage({'kind': 'page', 'node_id': page} if page else {'kind': 'file'}, scanned)
    coverage.update(total_matches=len(matches), returned=len(returned),
                    truncated=len(returned) < len(matches))
    return envelope('search', target.file_key, {'matches': returned}, response=response,
                    version=response.payload.get('version'), coverage=coverage, warnings=[LIMITATION])
