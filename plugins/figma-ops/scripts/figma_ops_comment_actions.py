"""User-requested comment changes with fresh public REST preflight and readback."""
from datetime import datetime

from figma_ops_core import OpsError, envelope, parse_target
from figma_ops_comments import load_threads
from figma_ops_session import load_session, put_comment, validate_comment_target


def _read(client, target, comment_id):
    previous = client.refresh
    try:
        client.refresh = True
        response, threads, _ = load_threads(client, target)
    finally:
        client.refresh = previous
    raw = response.payload['comments']
    ids = [c['id'] for c in raw]
    if len(ids) != len(set(ids)):
        raise OpsError('invalid_response', 'Duplicate comment IDs prevent a verified mutation.')
    item = next((c for c in raw if c['id'] == comment_id), None)
    if item is None:
        raise OpsError('not_found_or_inaccessible', 'Requested comment was not found in this file.')
    if item.get('file_key', target.file_key) != target.file_key:
        raise OpsError('invalid_response', 'Comment belongs to another file.')
    thread = next(t for t in threads if (t['root'] and t['root']['id'] == comment_id)
                  or any(c['id'] == comment_id for c in t['replies']))
    if thread['orphan']:
        raise OpsError('invalid_response', 'Cannot mutate an incomplete comment thread.')
    return response, item, thread['root_id']


def _resolved(item):
    if 'resolved_at' not in item:
        raise OpsError('invalid_response', 'Comment resolution state is missing.')
    value = item['resolved_at']
    if value is None:
        return False
    try:
        if not isinstance(value, str) or datetime.fromisoformat(value.replace('Z', '+00:00')).utcoffset() is None:
            raise ValueError
    except ValueError:
        raise OpsError('invalid_response', 'Comment resolution time is invalid.') from None
    return True


def _result(operation, target, comment_id, root_id, response, *, changed=False,
            attempted=False, verified=True, error=None, warnings=None):
    result = envelope(operation, target.file_key,
                      {'comment_id': comment_id, 'root_id': root_id, 'action': operation.removeprefix('comment-'),
                       'changed': changed, 'verified': verified, 'write_attempted': attempted},
                      response=response, status='error' if error else 'ok', warnings=warnings,
                      coverage={'read_source': 'public-rest', 'write_source': 'internal-web-api',
                                'scope': 'comment', 'fresh_readback': attempted and verified},
                      error=({'code': error.code, 'message': error.message,
                              'http_status': error.http_status, 'retry_after': error.retry_after} if error else None))
    return result


def _mutate(args, client, operation):
    target = parse_target(args.target)
    validate_comment_target(target.file_key, args.comment)
    text = None
    if operation == 'comment-edit':
        try:
            # read_bytes preserves CRLF and trailing newlines exactly.
            text = args.body_file.read_bytes().decode('utf-8')
        except (OSError, UnicodeError):
            raise OpsError('invalid_argument', 'Comment body must be a readable UTF-8 file.') from None
        if not text.strip():
            raise OpsError('invalid_argument', 'Comment body must not be empty.')
    response, before, root_id = _read(client, target, args.comment)
    if operation != 'comment-edit' and before.get('parent_id'):
        raise OpsError('invalid_argument', 'Resolve and Unresolve require a root comment ID.')
    desired = operation == 'comment-resolve'
    matches = before.get('message') == text if text is not None else _resolved(before) == desired
    if matches:
        return _result(operation, target, args.comment, root_id, response)
    session = load_session()
    client.invalidate(f'files/{target.file_key}/comments')
    payload = {'message_meta': [{'t': text}]} if text is not None else {'resolved_at': 'true' if desired else None}
    warning = []
    try:
        put_comment(target.file_key, args.comment, payload, session)
    except OpsError as error:
        if error.http_status is not None and 400 <= error.http_status < 500:
            return _result(operation, target, args.comment, root_id, response, changed=None,
                           attempted=True, verified=False, error=error)
        warning.append('Write response was unavailable or invalid; state was checked with a fresh REST read.')
    try:
        response, after, after_root = _read(client, target, args.comment)
        matches = after.get('message') == text if text is not None else _resolved(after) == desired
        preserved = (after_root == root_id and after.get('parent_id') == before.get('parent_id')
                     and after.get('client_meta') == before.get('client_meta'))
        if not matches or not preserved:
            raise OpsError('write_unconfirmed', 'Fresh state does not match the requested change.')
    except OpsError:
        return _result(operation, target, args.comment, root_id, response, changed=None,
                       attempted=True, verified=False,
                       error=OpsError('write_unconfirmed', 'Comment write is unconfirmed; reread the thread before retrying.'))
    return _result(operation, target, args.comment, root_id, response,
                   changed=True, attempted=True, warnings=warning)


def comment_resolve(args, client) -> dict:
    return _mutate(args, client, 'comment-resolve')


def comment_unresolve(args, client) -> dict:
    return _mutate(args, client, 'comment-unresolve')


def comment_edit(args, client) -> dict:
    return _mutate(args, client, 'comment-edit')
