"""Assemble a scoped REST dossier with independent complete discussions."""
from figma_ops_annotations import extract_annotations
from figma_ops_comments import load_threads, select_threads
from figma_ops_core import Client, OpsError, envelope, parse_target
from figma_ops_nodes import walk_nodes
from figma_ops_prototype import collect_prototype, project_prototype
from figma_ops_scope import (Collected, LoadedScope, collected_section, empty_section,
                             load_scope, node_identity, scope_context)
from figma_ops_design_system import collect_design_system


def _structure(scope: LoadedScope) -> Collected:
    counts = {}
    texts = []
    total = 0
    for node, ancestors in walk_nodes(scope.root):
        total += 1
        node_type = node.get('type')
        counts[node_type] = counts.get(node_type, 0) + 1
        if node_type == 'TEXT':
            texts.append({'node': node_identity(node, scope.root_ancestors + ancestors,
                                                scope.target.file_key),
                          'characters': node.get('characters')})
    children = []
    for child in scope.root.get('children', []):
        record = {'node': node_identity(child, scope.root_ancestors + [scope.root],
                                       scope.target.file_key)}
        if 'absoluteBoundingBox' in child:
            record['bbox'] = child['absoluteBoundingBox']
        children.append(record)
    return Collected({'type_counts': counts, 'total_nodes': total,
                      'direct_children': children, 'texts': texts},
                     {'scope': 'loaded-subtree', 'scanned_nodes': total, 'complete': False}, [])


def _project(result: Collected, limit: int | None, *, name=None, returned_key=None) -> Collected:
    # All local collection precedes projection. The projector copies raw JSON too.
    projected = project_prototype(result, limit)
    if returned_key is not None:
        counts = projected.coverage['collections'][name]
        projected.coverage.update({returned_key: counts['returned'], 'truncated': counts['truncated']})
    return projected


def context(args, client: Client) -> dict:
    if args.with_variables and not args.with_bindings:
        raise OpsError('invalid_argument', '--with-variables requires --with-bindings.')
    target = parse_target(args.target, args.node)
    url_node_id = parse_target(args.target).node_id
    scope = load_scope(client, target, root_id=args.scope_root)
    limit = None if args.output is not None else args.limit
    version = scope.response.payload.get('version')
    structure = _project(_structure(scope), limit)
    annotations = _project(extract_annotations(scope), limit,
                           name='annotations', returned_key='returned')
    prototype = project_prototype(collect_prototype(scope, client, follow=0), limit)
    sections = {name: collected_section(result, scope.response, version=version)
                for name, result in (('structure', structure), ('annotations', annotations),
                                     ('prototype', prototype))}
    sections['comments'] = empty_section('not_requested')
    if not args.without_comments:
        try:
            response, threads, total_comments = load_threads(client, target)
            ids = {node.get('id') for node, _ in walk_nodes(scope.root)}
            selected = select_threads(threads, node_ids=ids)
            selected.coverage.update(total_comments=total_comments,
                                     scope={'kind': 'node-and-descendants', 'node_id': scope.root['id']},
                                     complete=False)
            projected = _project(selected, limit, name='threads', returned_key='returned_threads')
            # The comments endpoint never supplies a document snapshot version.
            sections['comments'] = collected_section(projected, response)
        except OpsError as error:
            sections['comments'] = {**empty_section('failed'),
                                    'error': {'code': error.code, 'message': error.message,
                                              'http_status': error.http_status,
                                              'retry_after': error.retry_after}}
    for name in ('motion', 'canvas_visual'):
        sections[name] = {**empty_section('not_collected', 'figma-mcp'),
                          'reason': 'requires-host-tool'}
    identity = scope_context(scope, url_node_id=url_node_id)
    next_actions = [
        {'kind': 'motion_context', 'file_key': target.file_key, 'node_id': scope.root['id'],
         'purpose': 'Read motion inventory, tracks, easing and code snippets for the selected scope.',
         'prerequisites': ['Discover get_motion_context in the host and verify its current schema.'],
         'tool': 'get_motion_context',
         'parameters': {'fileKey': target.file_key, 'nodeId': scope.root['id'], 'recursive': True}},
        {'kind': 'canvas_visual', 'file_key': target.file_key, 'node_id': scope.root['id'],
         'purpose': 'Inspect the selected scope visually, including drawn arrows and layout.',
         'prerequisites': ['Discover a suitable Figma visual read tool in the host.']},
    ]
    if args.with_bindings:
        design_system = collect_design_system(scope, client, with_variables=args.with_variables, limit=limit)
        sections.update(design_system['sections'])
        next_actions.extend(design_system['next_actions'])
    warnings = list(dict.fromkeys(warning for section in sections.values() for warning in section['warnings']))
    partial = any(section['state'] in ('partial', 'failed') for section in sections.values())
    return envelope('context', target.file_key,
                    {**identity,
                     'snapshot_consistency': 'independent-requests', 'sections': sections,
                     'next_actions': next_actions},
                    response=scope.response, version=version,
                    coverage={'scope': 'loaded-subtree', 'root': identity['scope_root'],
                              'scanned_nodes': structure.coverage['scanned_nodes'], 'complete': False},
                    warnings=warnings, status='partial' if partial else 'ok')
