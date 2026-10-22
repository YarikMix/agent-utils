"""Pure Dev Mode annotation extraction and read-only CLI projection."""
from figma_ops_core import Client, envelope, parse_target
from figma_ops_nodes import walk_nodes
from figma_ops_scope import Collected, LoadedScope, load_scope, node_identity


def extract_annotations(scope: LoadedScope, query: str | None = None) -> Collected:
    """Collect the entire exact subtree; query filters records without limiting scans."""
    coverage = {'scope': 'loaded-subtree',
                'root': node_identity(scope.root, scope.root_ancestors, scope.target.file_key),
                'scanned_nodes': 0, 'nodes_with_annotations_field': 0,
                'nodes_without_annotations_field': 0, 'nodes_with_empty_annotations': 0,
                'nodes_with_invalid_annotations': 0, 'total_annotations': 0,
                'matched_annotations': 0, 'returned': 0, 'truncated': False, 'complete': False}
    records = []
    warnings = []
    partial = False
    folded_query = query.casefold() if query is not None else None
    for node, relative_ancestors in walk_nodes(scope.root):
        coverage['scanned_nodes'] += 1
        if 'annotations' not in node:
            coverage['nodes_without_annotations_field'] += 1
            continue
        coverage['nodes_with_annotations_field'] += 1
        annotations = node['annotations']
        if not isinstance(annotations, list):
            coverage['nodes_with_invalid_annotations'] += 1
            warnings.append('invalid_annotations_field: node ' + str(node.get('id')))
            partial = True
            continue
        if not annotations:
            coverage['nodes_with_empty_annotations'] += 1
        for index, raw in enumerate(annotations):
            coverage['total_annotations'] += 1
            annotation = raw if isinstance(raw, dict) else {}
            label = annotation.get('label')
            markdown = annotation.get('labelMarkdown')
            properties = annotation.get('properties')
            malformed = (not isinstance(raw, dict)
                         or ('label' in annotation and not isinstance(label, str))
                         or ('labelMarkdown' in annotation and not isinstance(markdown, str))
                         or ('properties' in annotation and not isinstance(properties, list)))
            if malformed:
                warnings.append(f'invalid_annotation: node {node.get("id")} index {index}')
                partial = True
            text_fields = [text for text in (label, markdown) if isinstance(text, str)]
            if folded_query is not None and not any(folded_query in text.casefold() for text in text_fields):
                continue
            records.append({
                'node': node_identity(node, scope.root_ancestors + relative_ancestors, scope.target.file_key),
                'annotation_index': index, 'label': label if isinstance(label, str) else None,
                'properties': properties if isinstance(properties, list) else None, 'raw': raw,
                'provenance': {'source': 'figma-rest', 'file_key': scope.target.file_key,
                               'node_id': node.get('id'), 'json_pointer': f'/annotations/{index}',
                               'fetched_at': scope.response.fetched_at,
                               'version': scope.response.payload.get('version')}})
    if coverage['nodes_without_annotations_field']:
        warnings.append('fields_not_returned')
    coverage.update(matched_annotations=len(records), returned=len(records))
    return Collected({'annotations': records}, coverage, warnings, partial)


def annotations(args, client: Client) -> dict:
    scope = load_scope(client, parse_target(args.target, args.node))
    collected = extract_annotations(scope, args.query)
    records = collected.data['annotations']
    returned = records if args.output is not None else records[:args.limit]
    coverage = {**collected.coverage, 'returned': len(returned), 'truncated': len(returned) < len(records)}
    return envelope('annotations', scope.target.file_key, {'annotations': returned}, response=scope.response,
                    version=scope.response.payload.get('version'), coverage=coverage,
                    warnings=collected.warnings, status='partial' if collected.partial else 'ok')
