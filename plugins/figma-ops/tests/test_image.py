"""Image validation catches false transparency and malformed asset downloads."""
import struct
import sys
from pathlib import Path
import unittest
import zlib

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from figma_ops_core import OpsError


def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))


def png(raw=b'\x00\x10\x20\x30\xff', width=1, height=1, color=6, depth=8, extra=b'', interlace=0):
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, depth, color, 0, 0, interlace))
            + extra + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


class ImageTests(unittest.TestCase):
    def inspect(self, data, fmt='png'):
        from figma_ops_image import inspect_image
        return inspect_image(data, fmt)

    def test_alpha_comes_from_pixels_including_filters_and_palette(self):
        # Removing unfiltering, treating RGBA as transparent, or ignoring tRNS breaks this.
        cases = [
            (png(), 'opaque'),
            (png(b'\x00\x10\x20\x30\x00'), 'transparent'),
            (png(b'\x00\x10\x20\x30', color=2), 'opaque'),
            (png(b'\x01\x10\x20\x30\xff\x00\x00\x00\x01', width=2), 'transparent'),
            (png(b'\x00\x01', color=3, extra=chunk(b'PLTE', b'\x00\x00\x00\xff\xff\xff') + chunk(b'tRNS', b'\xff\x00')), 'transparent'),
            (png(b'\x00\x00', color=3, extra=chunk(b'PLTE', b'\x00\x00\x00\xff\xff\xff') + chunk(b'tRNS', b'\xff\x00')), 'opaque'),
        ]
        for content, want in cases:
            with self.subTest(want=want):
                result = self.inspect(content)
                self.assertEqual(result['alpha'], want)
                self.assertEqual(result['height'], 1)
                self.assertEqual(result['format'], 'png')

    def test_all_png_filters_reconstruct_alpha(self):
        # Each row's RGBA pixel is [1,2,3,255]; previous row is the same.
        for filter_id, row in [(0,b'\x01\x02\x03\xff'), (1,b'\x01\x02\x03\xff'),
                               (2,b'\x00\x00\x00\x00'), (3,b'\x01\x01\x02\x80'),
                               (4,b'\x00\x00\x00\x00')]:
            content = png(b'\x00\x01\x02\x03\xff' + bytes([filter_id]) + row, height=2)
            self.assertEqual(self.inspect(content)['alpha'], 'opaque')

    def test_grayscale_and_truecolor_transparency_keys(self):
        self.assertEqual(self.inspect(png(b'\x00\x12', color=0, extra=chunk(b'tRNS', b'\x00\x12')))['alpha'], 'transparent')
        self.assertEqual(self.inspect(png(b'\x00\x12\x34\x56', color=2, extra=chunk(b'tRNS', b'\x00\x12\x00\x34\x00\x56')))['alpha'], 'transparent')

    def test_invalid_png_crc_truncation_filters_stream_and_limits_rejected(self):
        good = png()
        corrupt = bytearray(good)
        corrupt[30] ^= 1
        bad = [b'<html>error</html>', good[:-4], bytes(corrupt), png(b'\x05\x00\x00\x00\xff'),
               png(b'\x00'), png(width=2**30), png(b'\x00' * 100000)]
        for data in bad:
            with self.subTest(size=len(data)), self.assertRaises(OpsError):
                self.inspect(data)

    def test_invalid_transparency_chunks_cannot_confirm_alpha(self):
        invalid = [png(b'\x00\x00', color=3,
                       extra=chunk(b'tRNS', b'\x00') + chunk(b'PLTE', b'\x00\x00\x00')),
                   png(b'\x00\x00', color=0, extra=chunk(b'tRNS', b'\xff\xff'))]
        for content in invalid:
            with self.assertRaises(OpsError):
                self.inspect(content)

    def test_adam7_invalid_scanlines_are_rejected_and_valid_encoding_unknown(self):
        for raw in [b'\x05\x00\x00\x00\xff', b'\x00', b'\x00'*10]:
            with self.subTest(raw=raw), self.assertRaises(OpsError):
                self.inspect(png(raw, interlace=1))

    def test_subbyte_palette_and_16bit_alpha_are_actual_samples(self):
        palette = chunk(b'PLTE', b'\x00\x00\x00\xff\xff\xff') + chunk(b'tRNS', b'\xff\x00')
        cases = [(png(b'\x00\x80', color=3, depth=1, extra=palette),'transparent'),
                 (png(b'\x00\x00', color=3, depth=1, extra=palette),'opaque'),
                 (png(b'\x00'+struct.pack('>HHHH',1,2,3,65535),depth=16),'opaque'),
                 (png(b'\x00'+struct.pack('>HHHH',1,2,3,65534),depth=16),'transparent')]
        for content, want in cases:
            self.assertEqual(self.inspect(content)['alpha'], want)

    def test_interlaced_png_does_not_claim_confirmed_alpha(self):
        result = self.inspect(png(interlace=1))
        self.assertEqual(result['alpha'], 'unknown')
        self.assertTrue(result['warnings'])

    def test_fill_gif_webp_validate_headers_without_alpha_promises(self):
        gif = b'GIF87a' + struct.pack('<HHBBB', 2, 3, 0, 0, 0) + b'\x3b'
        webp = b'RIFF' + struct.pack('<I', 12) + b'WEBPVP8 ' + b'\x00'*4
        for fmt, content in [('gif',gif), ('webp',webp)]:
            result = self.inspect(content, fmt)
            self.assertEqual(result['alpha'], 'unknown')
            self.assertTrue(result['warnings'])
            if fmt == 'gif':
                self.assertEqual((result['width'],result['height']), (2,3))
        for fmt, content in [('gif',b'GIF89a'), ('gif',b'GIF89a'+b'\x00'*7),
                             ('webp',b'RIFF'+struct.pack('<I',999)+b'WEBPVP8 '+b'\x00'*4)]:
            with self.assertRaises(OpsError):
                self.inspect(content,fmt)

    def test_other_formats_validate_signature_and_xml(self):
        for fmt, content in [('jpg', b'\xff\xd8\xff\xe0test\xff\xd9'), ('pdf', b'%PDF-1.7\n%%EOF'),
                             ('svg', b'<svg xmlns="http://www.w3.org/2000/svg" width="1"/>')]:
            result = self.inspect(content, fmt)
            self.assertEqual(result['format'], fmt)
            self.assertIsNone(result['width'])
            self.assertEqual(result['alpha'], 'not-applicable' if fmt == 'pdf' else 'unknown')
            with self.assertRaises(OpsError):
                self.inspect(b'<html>upstream failure</html>', fmt)
        for content in [b'<svg', b'<html/>', b'<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>']:
            with self.assertRaises(OpsError):
                self.inspect(content, 'svg')


if __name__ == '__main__':
    unittest.main()
