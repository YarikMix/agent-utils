#!/usr/bin/env python3
"""Read-only Figma operations CLI, runnable from any working directory."""
import argparse
from pathlib import Path
import sys

from figma_ops_core import Client, OpsError, atomic_write, envelope, serialize_json


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


def build_parser():
    parser = ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    diagnostic = commands.add_parser('doctor', help='Probe only GET /me identity and authentication.')
    diagnostic.set_defaults(handler=doctor)
    for command in (diagnostic,):
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
