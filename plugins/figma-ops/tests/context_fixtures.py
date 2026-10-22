"""Fresh synthetic context trees and the real CLI with an HTTPS boundary double."""
import contextlib
import io
import json
from unittest.mock import patch

from test_core import CurlBoundary, core
import figma_ops as cli


def payload() -> dict:
    return {'version': 'v1', 'document': {
        'id': '0:0', 'name': 'Document', 'type': 'DOCUMENT', 'children': [
            {'id': '9:0', 'name': 'Dependency page', 'type': 'CANVAS', 'children': [
                {'id': '9:9', 'name': 'Unrelated', 'type': 'FRAME',
                 'annotations': [{'label': 'Unrelated note'}]}]},
            {'id': '1:0', 'name': 'Page', 'type': 'CANVAS', 'children': [
                {'id': '2:0', 'name': 'Frame', 'type': 'FRAME', 'annotations': [], 'children': [
                    {'id': '2:1', 'name': 'Instance', 'type': 'INSTANCE',
                     'annotations': [{'label': 'Straße note', 'properties': [{'type': 'width'}]}],
                     'children': [{'id': 'I2:1;3:1', 'name': 'Text', 'type': 'TEXT',
                                   'characters': 'Synthetic text',
                                   'annotations': [{'labelMarkdown': 'STRASSE markdown', 'categoryId': 'category'}]}]},
                    {'id': '2:2', 'name': 'Sibling', 'type': 'TEXT', 'characters': 'Sibling text',
                     'annotations': [{'properties': [{'type': 'height'}]}]}]}]}]}}


def comment_payload() -> dict:
    return {'comments': [
        {'id': 'root', 'parent_id': '', 'message': 'Synthetic root',
         'client_meta': {'node_id': '2:1'}, 'created_at': '2026-01-01T00:00:00Z',
         'user': {'id': 'user-a', 'handle': 'A'}},
        {'id': 'reply', 'parent_id': 'root', 'message': 'Synthetic reply',
         'created_at': '2026-01-01T01:00:00Z', 'user': {'id': 'user-b', 'handle': 'B'}},
        {'id': 'neighbor', 'parent_id': '', 'message': 'Synthetic neighbor',
         'client_meta': {'node_id': '9:9'}, 'created_at': '2026-01-01T02:00:00Z',
         'user': {'id': 'user-c', 'handle': 'C'}}]}


def invoke(argv: list[str], responses: list[tuple[int, dict, dict]]) -> tuple[int, dict, CurlBoundary]:
    transport = CurlBoundary(responses)
    client = core.Client(token='synthetic-secret', no_cache=True)
    stdout = io.StringIO()
    with patch.object(cli, 'Client', return_value=client), patch('subprocess.run', transport), contextlib.redirect_stdout(stdout):
        code = cli.main(argv)
    return code, json.loads(stdout.getvalue()), transport
