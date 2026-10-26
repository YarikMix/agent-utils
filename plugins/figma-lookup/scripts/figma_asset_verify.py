#!/usr/bin/env python3
"""Verify a local PNG and requested pixels without credentials or network access."""
import argparse
from datetime import datetime, timezone
import os
from pathlib import Path
import stat

from figma_ops_core import OpsError, serialize_json
from figma_ops_image import inspect_image

MAX_INPUT_BYTES = 64 * 1024 * 1024


def _receipt(path=None, width=None, height=None, transparency=False):
    return {
        'schema_version': 1,
        'operation': 'verify-asset',
        'source': 'local-file',
        'status': 'ok',
        'checked_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'data': {
            'path': path, 'bytes': None, 'format': 'png',
            'width': None, 'height': None, 'alpha': 'unknown',
            'expected': {'width': width, 'height': height, 'require_transparency': transparency},
            'checks': {
                'valid_png': 'unavailable',
                'width': 'unavailable' if width is not None else 'not_requested',
                'height': 'unavailable' if height is not None else 'not_requested',
                'transparency': 'unavailable' if transparency else 'not_requested',
            },
            'provenance_verified': False,
        },
        'warnings': [],
        'error': None,
    }


def _failure(receipt, code, message):
    receipt.update(status='error', error={'code': code, 'message': message})
    return receipt


def verify_file(path: Path, *, expect_width: int | None = None,
                expect_height: int | None = None, require_transparency: bool = False) -> dict:
    """Return a complete local receipt, including expected input/verification errors."""
    receipt = _receipt(width=expect_width if type(expect_width) is int else None,
                       height=expect_height if type(expect_height) is int else None,
                       transparency=require_transparency if type(require_transparency) is bool else False)
    data = receipt['data']
    try:
        local_path = os.fspath(path)
        if not isinstance(local_path, str):
            raise TypeError
        data['path'] = local_path
    except TypeError:
        return _failure(receipt, 'invalid_file', 'A local regular file is required.')
    if ((expect_width is None) != (expect_height is None)
            or any(value is not None and (type(value) is not int or value <= 0)
                   for value in (expect_width, expect_height))
            or type(require_transparency) is not bool):
        return _failure(receipt, 'invalid_argument',
                        'Expected width and height must be positive integers supplied together.')

    descriptor = None
    try:
        # Nonblocking open also prevents a FIFO substituted before open from hanging.
        descriptor = os.open(local_path, os.O_RDONLY | getattr(os, 'O_NONBLOCK', 0))
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            return _failure(receipt, 'invalid_file', 'A local regular file is required.')
        data['bytes'] = metadata.st_size
        if metadata.st_size > MAX_INPUT_BYTES:
            return _failure(receipt, 'asset_too_large', 'Local PNG exceeds the 64 MiB input limit.')
        with os.fdopen(descriptor, 'rb', buffering=0) as stream:
            descriptor = None  # The stream now owns the descriptor.
            content = stream.read(MAX_INPUT_BYTES + 1)
        data['bytes'] = len(content)
        if len(content) > MAX_INPUT_BYTES:
            return _failure(receipt, 'asset_too_large', 'Local PNG exceeds the 64 MiB input limit.')
    except (FileNotFoundError, NotADirectoryError, IsADirectoryError, ValueError, TypeError):
        return _failure(receipt, 'invalid_file', 'A readable local regular file is required.')
    except OSError:
        return _failure(receipt, 'file_read_failed', 'Local PNG could not be read.')
    finally:
        if descriptor is not None:
            os.close(descriptor)

    checks = data['checks']
    try:
        image = inspect_image(content, 'png')
    except OpsError as error:
        checks['valid_png'] = 'failed'
        return _failure(receipt, error.code, error.message)
    checks['valid_png'] = 'passed'
    data.update(width=image['width'], height=image['height'], alpha=image['alpha'])
    receipt['warnings'] = image['warnings']
    for dimension, expected in (('width', expect_width), ('height', expect_height)):
        if expected is not None:
            checks[dimension] = 'passed' if data[dimension] == expected else 'failed'
    if require_transparency:
        checks['transparency'] = {'transparent': 'passed', 'opaque': 'failed'}.get(
            data['alpha'], 'unavailable')
    if 'failed' in checks.values():
        return _failure(receipt, 'asset_mismatch', 'PNG does not meet the requested requirements.')
    if 'unavailable' in checks.values():
        return _failure(receipt, 'verification_unavailable',
                        'PNG pixel transparency could not be confirmed.')
    return receipt


class _ArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        # argparse diagnostics can contain arbitrary argument text. Keep JSON errors safe.
        raise OpsError('invalid_argument', 'Invalid arguments; use --help for usage.')


def _positive_integer(value):
    try:
        number = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError('A positive integer is required.') from None
    if number <= 0:
        raise argparse.ArgumentTypeError('A positive integer is required.')
    return number


def main(argv: list[str] | None = None) -> int:
    """Print one strict JSON receipt; help is ordinary argparse help."""
    parser = _ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument('file', metavar='FILE', help='Readable local PNG file')
    parser.add_argument('--expect-width', type=_positive_integer, metavar='PIXELS')
    parser.add_argument('--expect-height', type=_positive_integer, metavar='PIXELS')
    parser.add_argument('--require-transparency', action='store_true')
    try:
        arguments = parser.parse_args(argv)
    except OpsError as error:
        receipt = _failure(_receipt(), error.code, error.message)
    except SystemExit as exit_status:
        return int(exit_status.code)
    else:
        receipt = verify_file(arguments.file, expect_width=arguments.expect_width,
                              expect_height=arguments.expect_height,
                              require_transparency=arguments.require_transparency)
    print(serialize_json(receipt))
    if receipt['status'] == 'ok':
        return 0
    return 2 if receipt['error']['code'] == 'invalid_argument' else 1


if __name__ == '__main__':
    raise SystemExit(main())
