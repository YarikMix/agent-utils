#!/usr/bin/env python3
"""Read-only Figma operations CLI, runnable from any working directory."""
import argparse
from pathlib import Path
import sys

from figma_ops_core import Client, OpsError, atomic_write, envelope, serialize_json
from figma_ops_nodes import inspect, search
from figma_ops_comments import comments, thread
from figma_ops_assets import export, fills


class ArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        # argparse's message can include arbitrary supplied values, so do not echo it.
        raise OpsError('invalid_argument', 'Invalid command arguments; use --help for usage.')


def doctor(args, client):
    response = client.get_json('me')
    return envelope('doctor', None,
                    {'identity': response.payload, 'credential_source': client.credential_source},
                    response=response,
                    coverage={'endpoint': '/me', 'scopes_checked': False, 'mcp_checked': False})


def positive_integer(value):
    try:
        number = int(value)
    except ValueError:
        raise OpsError('invalid_argument', 'Expected a positive integer.') from None
    if number <= 0:
        raise OpsError('invalid_argument', 'Expected a positive integer.')
    return number


def nonempty(value):
    if not value or not value.strip():
        raise OpsError('invalid_argument', 'Expected nonempty text.')
    return value


def build_parser():
    parser = ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    diagnostic = commands.add_parser('doctor', help='Probe only GET /me identity and authentication.')
    diagnostic.set_defaults(handler=doctor)
    inspection = commands.add_parser('inspect', help='Inspect a node or list pages.')
    inspection.set_defaults(handler=inspect)
    inspection.add_argument('target')
    inspection.add_argument('--node')
    inspection.add_argument('--depth', type=positive_integer)
    searching = commands.add_parser('search', help='Search names and text in the loaded document.')
    searching.set_defaults(handler=search)
    searching.add_argument('target')
    searching.add_argument('--query', required=True, type=nonempty)
    search_scope = searching.add_mutually_exclusive_group()
    search_scope.add_argument('--page')
    search_scope.add_argument('--node')
    searching.add_argument('--type')
    searching.add_argument('--limit', type=positive_integer, default=20)
    discussions = commands.add_parser('comments', help='Read and filter full comment threads.')
    discussions.set_defaults(handler=comments)
    discussions.add_argument('target')
    discussions.add_argument('--query', type=nonempty)
    discussions.add_argument('--author', type=nonempty)
    discussions.add_argument('--status', choices=('open', 'resolved', 'all'), default='all')
    discussions.add_argument('--node')
    discussions.add_argument('--limit', type=positive_integer, default=20)
    conversation = commands.add_parser('thread', help='Read a full thread by root or reply ID.')
    conversation.set_defaults(handler=thread)
    conversation.add_argument('target')
    conversation.add_argument('--comment', required=True, type=nonempty)
    rendering = commands.add_parser('export', help='Download and verify node renders.')
    rendering.set_defaults(handler=export)
    rendering.add_argument('target')
    rendering.add_argument('--node', action='append')
    rendering.add_argument('--format', choices=('png', 'jpg', 'svg', 'pdf'), default='png')
    rendering.add_argument('--scale', type=float, default=1.)
    rendering.add_argument('--dest', type=Path, required=True)
    rendering.add_argument('--overwrite', action='store_true')
    sources = commands.add_parser('fills', help='List or download image-fill sources in a subtree.')
    sources.set_defaults(handler=fills)
    sources.add_argument('target')
    sources.add_argument('--node')
    sources.add_argument('--dest', type=Path)
    sources.add_argument('--overwrite', action='store_true')
    for command in (diagnostic, inspection, searching, discussions, conversation, rendering, sources):
        command.add_argument('--refresh', action='store_true', help='Fetch again and replace cached result.')
        command.add_argument('--no-cache', action='store_true', help='Do not read or write persistent cache.')
        command.add_argument('--cache-dir', type=Path)
        command.add_argument('--output', type=Path, help='Write full envelope atomically and print artifact summary.')
    return parser


def main(argv: list[str] | None = None) -> int:
    operation = None
    args = None
    try:
        args = build_parser().parse_args(argv)
        operation = args.command
        client = Client(cache_dir=args.cache_dir, refresh=args.refresh, no_cache=args.no_cache)
        result = args.handler(args, client)
        serialize_json(result)
        code = 1 if result['status'] == 'error' else 0
    except OpsError as error:
        result = envelope(operation or 'unknown', None, None, status='error',
                          error={'code': error.code, 'message': error.message,
                                 'http_status': error.http_status, 'retry_after': error.retry_after})
        code = 2 if error.code == 'invalid_argument' else 1
    if args is not None and args.output is not None:
        try:
            content = (serialize_json(result, indent=2) + '\n').encode()
            output = args.output.resolve()
            atomic_write(output, content)
            result = {**result, 'data': {'artifact': str(output), 'bytes': len(content)}}
        except OSError:
            result = envelope(operation or 'unknown', None, None, status='error',
                              error={'code': 'output_error', 'message': 'Could not write JSON output artifact.',
                                     'http_status': None, 'retry_after': None})
            code = 1
    print(serialize_json(result))
    return code


if __name__ == '__main__':
    sys.exit(main())
