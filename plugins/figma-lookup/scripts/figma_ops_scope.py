"""Exact loaded subtree and shared immutable collection containers."""
from dataclasses import dataclass
from urllib.parse import urlencode

from figma_ops_core import ApiResponse, Client, OpsError, Target, parse_target
from figma_ops_nodes import find_node, require_document


@dataclass(frozen=True)
class LoadedScope:
    target: Target
    response: ApiResponse
    source: dict
    source_ancestors: list[dict]
    root: dict
    root_ancestors: list[dict]


@dataclass(frozen=True)
class Collected:
    data: dict
    coverage: dict
    warnings: list[str]
    partial: bool = False


def load_scope(client: Client, target: Target, *, root_id: str | None = None) -> LoadedScope:
    """Load source and optional ancestor in one GET without a global depth limit."""
    if target.node_id is None:
        raise OpsError('invalid_argument', 'A node is required for this operation.')
    root_id = parse_target(target.file_key, root_id).node_id if root_id is not None else target.node_id
    ids = target.node_id if root_id == target.node_id else target.node_id + ',' + root_id
    response = client.get_json(f'files/{target.file_key}', {'ids': ids})
    document = require_document(response)
    source, source_ancestors = find_node(document, target.node_id)
    root, root_ancestors = find_node(document, root_id)
    if root_id != target.node_id and not any(node.get('id') == root_id for node in source_ancestors):
        raise OpsError('scope_mismatch', 'Scope root must be the source node or its ancestor.')
    return LoadedScope(target, response, source, source_ancestors, root, root_ancestors)


def node_identity(node: dict, ancestors: list[dict], file_key: str) -> dict:
    """Identity and ancestry from the returned tree, preserving composite IDs."""
    page = next((item for item in reversed(ancestors + [node]) if item.get('type') == 'CANVAS'), None)
    return {'id': node.get('id'), 'name': node.get('name'), 'type': node.get('type'),
            'path': [item.get('name', '') for item in ancestors + [node]],
            'page': {key: page.get(key) for key in ('id', 'name', 'type')} if page is not None else None,
            'url': f'https://www.figma.com/design/{file_key}/?' + urlencode({'node-id': node.get('id', '')})}
