"""Verified render exports and image-fill source downloads."""
import hashlib
import math
import os
from pathlib import Path
import re
import tempfile
from urllib.parse import urlsplit

from figma_ops_core import OpsError, envelope, parse_target
from figma_ops_image import inspect_image
from figma_ops_nodes import LIMITATION, find_node, load_nodes, require_document, walk_nodes

DOWNSCALE = 'The API may downscale renders; requested scale does not establish exact output dimensions.'
SOURCE_WARNING = 'Image-fill sources come from the API; identity with original uploaded bytes is not guaranteed.'


def _filename(identifier, fmt, kind):
    safe = re.sub(r'[^A-Za-z0-9_-]', '_', identifier)[:100] or 'asset'
    digest = hashlib.sha256(identifier.encode()).hexdigest()[:16]
    return f'{kind}-{safe}-{digest}.{fmt}'


def _write(path, content, overwrite):
    """Publish a complete file atomically; hardlink prevents no-overwrite races."""
    temporary = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.' + path.name + '.', suffix='.tmp', delete=False) as stream:
            temporary = Path(stream.name)
            os.chmod(temporary, 0o600)
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        if overwrite:
            os.replace(temporary, path)
        else:
            os.link(temporary, path)
    except FileExistsError:
        raise OpsError('file_exists', 'Destination already exists; use --overwrite to replace it.') from None
    except OSError:
        raise OpsError('output_error', 'Could not save the asset atomically.') from None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _detect(content):
    if content.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'png'
    if content.startswith(b'\xff\xd8\xff'):
        return 'jpg'
    if content.startswith(b'%PDF-'):
        return 'pdf'
    if content.startswith((b'GIF87a', b'GIF89a')):
        return 'gif'
    if content.startswith(b'RIFF') and content[8:12] == b'WEBP':
        return 'webp'
    if content.lstrip().startswith(b'<') or content.startswith((b'\xef\xbb\xbf', b'\xff\xfe', b'\xfe\xff')):
        return 'svg'
    raise OpsError('unsupported_format', 'Image-fill source format is not supported for validation.')


def _save(client, url, dest, identifier, kind, overwrite, fmt=None):
    content = client.download(url)
    fmt = fmt or _detect(content)
    info = inspect_image(content, fmt)
    warnings = info.pop('warnings', [])
    path = Path(dest).resolve() / _filename(identifier, fmt, kind)
    _write(path, content, overwrite)
    return {'path': str(path), 'bytes': len(content), **info}, warnings


def _failure(error):
    return {'code': error.code, 'message': error.message, 'http_status': error.http_status,
            'retry_after': error.retry_after}


def _result(operation, target, response, files, warnings, coverage, version=None):
    succeeded = sum(item['status'] == 'ok' for item in files)
    failed = len(files) - succeeded
    status = 'partial' if succeeded and failed else ('error' if failed else 'ok')
    coverage.update(requested=len(files), succeeded=succeeded, failed=failed)
    if failed:
        warnings.append('Some requested assets were unavailable or could not be verified; see per-asset errors.')
    error = {'code': 'assets_failed', 'message': 'All requested assets failed.', 'http_status': None, 'retry_after': None} if status == 'error' else None
    data = {'files': files}
    if operation == 'fills':
        data['source_kind'] = 'api-image-fill-source'
    return envelope(operation, target.file_key, data, response=response, coverage=coverage,
                    warnings=list(dict.fromkeys(warnings)), status=status, error=error, version=version)


def export(args, client):
    target = parse_target(args.target)
    nodes = [parse_target(args.target, node).node_id for node in args.node] if args.node else ([target.node_id] if target.node_id else [])
    if not 1 <= len(nodes) <= 20 or not math.isfinite(args.scale) or not .01 <= args.scale <= 4:
        raise OpsError('invalid_argument', 'Export requires 1..20 nodes and a finite scale within 0.01..4.')
    if args.format not in ('png', 'jpg', 'svg', 'pdf') or not args.dest:
        raise OpsError('invalid_argument', 'Export requires a supported format and destination directory.')
    # Deduplicate while retaining request order and preserving instance IDs.
    nodes = list(dict.fromkeys(nodes))
    response = client.get_json(f'images/{target.file_key}', {'ids': ','.join(nodes), 'format': args.format,
                               'scale': args.scale, 'contents_only': 'true'})
    images = response.payload.get('images')
    if not isinstance(images, dict):
        raise OpsError('invalid_response', 'Figma render response has no images mapping.')
    files = []
    warnings = [DOWNSCALE]
    for node in nodes:
        item = {'node_id': node, 'status': 'error', 'scale_requested': args.scale}
        try:
            url = images.get(node)
            if not isinstance(url, str) or not url:
                raise OpsError('render_failed', 'The API returned no render for this node.')
            info, extra = _save(client, url, args.dest, node, 'node', args.overwrite, args.format)
            item.update(info, status='ok')
            warnings.extend(extra)
        except OpsError as error:
            item['error'] = _failure(error)
        files.append(item)
    return _result('export', target, response, files, warnings, {'complete': all(f['status'] == 'ok' for f in files)})


def fills(args, client):
    target = parse_target(args.target, args.node)
    tree_response = load_nodes(client, target)
    document = require_document(tree_response)
    root, _ = find_node(document, target.node_id) if target.node_id else (document, [])
    refs = []
    scanned = 0
    unresolved = 0
    for node, _ in walk_nodes(root):
        scanned += 1
        for field in ('fills', 'backgrounds', 'strokes'):
            for fill in node.get(field, []):
                if isinstance(fill, dict) and fill.get('type') == 'IMAGE':
                    ref = fill.get('imageRef')
                    if isinstance(ref, str) and ref:
                        refs.append(ref)
                    else:
                        unresolved += 1
    refs = list(dict.fromkeys(refs))
    response = client.get_json(f'files/{target.file_key}/images')
    meta = response.payload.get('meta')
    images = meta.get('images') if isinstance(meta, dict) else None
    if not isinstance(images, dict):
        raise OpsError('invalid_response', 'Figma image-fill response has no images mapping.')
    files = []
    warnings = [SOURCE_WARNING, LIMITATION]
    if unresolved:
        warnings.append(f'{unresolved} image fills in the loaded subtree have no usable imageRef.')
    available = 0
    downloaded = 0
    for ref in refs:
        item = {'image_ref': ref, 'status': 'error', 'scale_requested': None}
        try:
            url = images.get(ref)
            if not isinstance(url, str) or not url:
                raise OpsError('missing_image_ref', 'The API returned no source URL for this imageRef.')
            # Validate even URL-only mode through the same HTTPS policy, without a download.
            parsed = urlsplit(url)
            if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or any(ord(c) < 33 for c in url):
                raise OpsError('invalid_asset_url', 'Image-fill source URL must be valid HTTPS.')
            available += 1
            item.update(url=url, status='ok')
            if args.dest is not None:
                info, extra = _save(client, url, args.dest, ref, 'fill', args.overwrite)
                item.update(info)
                warnings.extend(extra)
                downloaded += 1
        except (OpsError, ValueError) as error:
            if isinstance(error, ValueError):
                error = OpsError('invalid_asset_url', 'Image-fill source URL must be valid HTTPS.')
            item.update(status='error', error=_failure(error))
        files.append(item)
    result = _result('fills', target, response, files, warnings,
                    {'scope': {'kind': 'node' if target.node_id else 'file', 'node_id': target.node_id},
                     'scanned_nodes': scanned, 'urls_available': available, 'downloaded': downloaded,
                     'unresolved_image_fills': unresolved, 'complete': False,
                     'completeness': 'loaded-subtree-only'}, version=tree_response.payload.get('version'))
    if unresolved and result['status'] == 'ok':
        result['status'] = 'partial'
    return result
