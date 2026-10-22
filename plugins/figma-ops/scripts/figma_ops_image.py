"""Validate downloaded assets and inspect PNG pixels without external libraries."""
import struct
import xml.etree.ElementTree as ET
import zlib

from figma_ops_core import OpsError

PNG_SIGNATURE = b'\x89PNG\r\n\x1a\n'
MAX_DECODED = 64 * 1024 * 1024


def _invalid():
    return OpsError('invalid_asset', 'Downloaded bytes are not a valid supported asset.')


def _paeth(a, b, c):
    p = a + b - c
    distances = (abs(p - a), abs(p - b), abs(p - c))
    return (a, b, c)[distances.index(min(distances))]


def _png(content):
    if not content.startswith(PNG_SIGNATURE):
        raise _invalid()
    chunks = {}
    offset = 8
    last = None
    idat_ended = False
    while offset < len(content):
        if offset + 12 > len(content):
            raise _invalid()
        length = struct.unpack_from('>I', content, offset)[0]
        kind = content[offset + 4:offset + 8]
        end = offset + 12 + length
        if end > len(content) or len(kind) != 4 or not all(65 <= n <= 90 or 97 <= n <= 122 for n in kind):
            raise _invalid()
        data = content[offset + 8:end - 4]
        if zlib.crc32(kind + data) != struct.unpack_from('>I', content, end - 4)[0]:
            raise _invalid()
        if last is None and kind != b'IHDR':
            raise _invalid()
        if kind in (b'IHDR', b'PLTE', b'tRNS', b'IEND') and kind in chunks:
            raise _invalid()
        if kind == b'IDAT' and idat_ended:
            raise _invalid()
        if last == b'IDAT' and kind != b'IDAT':
            idat_ended = True
        if kind == b'PLTE' and b'tRNS' in chunks:
            raise _invalid()
        if kind in (b'PLTE', b'tRNS') and b'IDAT' in chunks:
            raise _invalid()
        if kind[0] < 97 and kind not in (b'IHDR', b'PLTE', b'IDAT', b'IEND'):
            raise _invalid()
        chunks.setdefault(kind, []).append(data)
        offset = end
        last = kind
        if kind == b'IEND':
            if data or offset != len(content):
                raise _invalid()
            break
    if last != b'IEND' or b'IDAT' not in chunks or len(chunks[b'IHDR'][0]) != 13:
        raise _invalid()
    width, height, depth, color, compression, filtering, interlace = struct.unpack('>IIBBBBB', chunks[b'IHDR'][0])
    depths = {0: (1,2,4,8,16), 2: (8,16), 3: (1,2,4,8), 4: (8,16), 6: (8,16)}
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}
    if not width or not height or color not in depths or depth not in depths[color] or compression or filtering or interlace not in (0,1):
        raise _invalid()
    stride = (width * channels[color] * depth + 7) // 8
    # The extra rows bound Adam7 overhead as well, without allocating by hostile dimensions.
    limit = (stride + 8) * (height + 8) if interlace else (stride + 1) * height
    if limit > MAX_DECODED:
        raise OpsError('asset_too_large', 'PNG decoded data exceeds the bounded inspection limit.')
    palette = chunks.get(b'PLTE', [b''])[0]
    transparency = chunks.get(b'tRNS', [None])[0]
    if b'PLTE' in chunks and (not palette or len(palette) % 3 or len(palette) > 768 or color in (0,4)):
        raise _invalid()
    if color == 3 and (not palette or len(palette) // 3 > 2**depth):
        raise _invalid()
    if transparency is not None:
        if ((color == 0 and len(transparency) != 2) or (color == 2 and len(transparency) != 6)
                or (color == 3 and (not transparency or len(transparency) > len(palette)//3)) or color in (4,6)):
            raise _invalid()
        if color in (0, 2) and any(sample >= 1 << depth for sample in struct.unpack('>' + 'H' * (len(transparency)//2), transparency)):
            raise _invalid()
    try:
        decoder = zlib.decompressobj()
        raw = decoder.decompress(b''.join(chunks[b'IDAT']), limit + 1)
        if len(raw) > limit or decoder.unconsumed_tail or not decoder.eof or decoder.unused_data:
            raise _invalid()
    except zlib.error:
        raise _invalid() from None
    result = {'width': width, 'height': height, 'color_type': color, 'alpha': 'opaque', 'warnings': []}
    if interlace:
        # Validate Adam7 pass sizes and filter bytes without claiming decoded alpha.
        position = 0
        for x, y, dx, dy in [(0,0,8,8),(4,0,8,8),(0,4,4,8),(2,0,4,4),
                              (0,2,2,4),(1,0,2,2),(0,1,1,2)]:
            pass_width = max(0, (width-x+dx-1)//dx)
            pass_height = max(0, (height-y+dy-1)//dy)
            if not pass_width or not pass_height:
                continue
            pass_stride = (pass_width*channels[color]*depth+7)//8
            for _ in range(pass_height):
                if position >= len(raw) or raw[position] > 4:
                    raise _invalid()
                position += pass_stride + 1
        if position != len(raw):
            raise _invalid()
        result.update(alpha='unknown', warnings=['Interlaced PNG pixel transparency is not supported; alpha is unknown.'])
        return result
    if len(raw) != (stride + 1) * height:
        raise _invalid()
    bpp = max(1, (channels[color] * depth + 7) // 8)
    previous = bytearray(stride)
    transparent = False
    key = struct.unpack('>' + 'H' * (len(transparency)//2), transparency) if transparency is not None and color in (0,2) else None
    for start in range(0, len(raw), stride + 1):
        filter_type = raw[start]
        if filter_type > 4:
            raise _invalid()
        row = bytearray(raw[start + 1:start + stride + 1])
        for i in range(stride):
            a = row[i-bpp] if i >= bpp else 0
            b = previous[i]
            c = previous[i-bpp] if i >= bpp else 0
            prediction = (0, a, b, (a+b)//2, _paeth(a,b,c))[filter_type]
            row[i] = (row[i] + prediction) & 255
        for i in range(width):
            if depth == 16:
                pixel = struct.unpack_from('>' + 'H'*channels[color], row, i*channels[color]*2)
            elif depth == 8:
                pixel = tuple(row[i*channels[color]:(i+1)*channels[color]])
            else:
                mask = (1 << depth) - 1
                pixel = ((row[i*depth//8] >> (8-depth-i*depth%8)) & mask,)
            if color in (4,6) and pixel[-1] < (1 << depth) - 1:
                transparent = True
            elif color in (0,2) and key == pixel:
                transparent = True
            elif color == 3:
                index = pixel[0]
                if index >= len(palette)//3:
                    raise _invalid()
                if transparency is not None and index < len(transparency) and transparency[index] < 255:
                    transparent = True
        previous = row
    result['alpha'] = 'transparent' if transparent else 'opaque'
    return result


def inspect_image(content: bytes, expected_format: str) -> dict:
    """Return verified format/dimensions/alpha; unsupported PNG pixels stay unknown."""
    result = {'format': expected_format, 'width': None, 'height': None, 'alpha': 'unknown', 'warnings': []}
    if expected_format == 'png':
        return {**result, **_png(content)}
    if expected_format == 'jpg':
        if not content.startswith(b'\xff\xd8\xff'):
            raise _invalid()
    elif expected_format == 'pdf':
        if not content.startswith(b'%PDF-'):
            raise _invalid()
        result['alpha'] = 'not-applicable'
    elif expected_format == 'gif':
        if len(content) < 13 or not content.startswith((b'GIF87a', b'GIF89a')):
            raise _invalid()
        width, height = struct.unpack_from('<HH', content, 6)
        if not width or not height:
            raise _invalid()
        result.update(width=width, height=height,
                      warnings=['GIF signature/header verified; pixel transparency and animation were not decoded.'])
    elif expected_format == 'webp':
        if (len(content) < 20 or content[:4] != b'RIFF' or content[8:12] != b'WEBP'
                or struct.unpack_from('<I', content, 4)[0] != len(content) - 8
                or content[12:16] not in (b'VP8 ', b'VP8L', b'VP8X')
                or struct.unpack_from('<I', content, 16)[0] > len(content) - 20):
            raise _invalid()
        result['warnings'] = ['WebP signature/header verified; pixel transparency and animation were not decoded.']
    elif expected_format == 'svg':
        # ElementTree does not fetch entities; rejecting DTDs also avoids entity expansion.
        if b'<!DOCTYPE' in content.upper() or b'<!ENTITY' in content.upper() or len(content) > MAX_DECODED:
            raise _invalid()
        try:
            root = ET.fromstring(content)
            if root.tag not in ('svg', '{http://www.w3.org/2000/svg}svg'):
                raise _invalid()
        except (ET.ParseError, LookupError):
            raise _invalid() from None
    else:
        raise OpsError('unsupported_format', 'Asset format is not supported for validation.')
    return result
