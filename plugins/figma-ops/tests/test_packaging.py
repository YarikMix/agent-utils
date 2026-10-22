"""Installed roots are self-contained; generated compatibility cannot drift."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
CANONICAL = ROOT / 'plugins' / 'figma-ops'
LEGACY = ROOT / 'plugins' / 'figma-lookup'
COMMANDS = ('doctor', 'inspect', 'search', 'comments', 'thread', 'export', 'fills', 'annotations')


class PackagingTests(unittest.TestCase):
    def test_host_catalogs_resolve_both_plugins_and_discover_skills(self):
        for host, catalog in (('.claude-plugin', '.claude-plugin/marketplace.json'),
                              ('.codex-plugin', '.agents/plugins/marketplace.json')):
            entries = json.loads((ROOT / catalog).read_text())['plugins']
            for name, version in (('figma-ops', '1.0.0'), ('figma-lookup', '1.1.0')):
                with self.subTest(host=host, name=name):
                    entry, = [item for item in entries if item['name'] == name]
                    source = entry['source']
                    directory = ROOT / (source['path'] if isinstance(source, dict) else source)
                    self.assertEqual(directory.resolve(), (ROOT / 'plugins' / name).resolve())
                    manifest = json.loads((directory / host / 'plugin.json').read_text())
                    self.assertEqual((manifest['name'], manifest['version']), (name, version))
                    self.assertEqual(entry['version'], version)
                    skill, = (directory / manifest['skills']).glob('*/SKILL.md')
                    self.assertEqual(skill.parent.name, name)
                    self.assertIn('\nname: ' + name + '\n', skill.read_text())
                    self.assertTrue((directory / 'LICENSE').is_file())

    def test_all_skill_reference_links_resolve_inside_plugin(self):
        for plugin in (CANONICAL, LEGACY):
            with self.subTest(plugin=plugin.name):
                skill = plugin / 'skills' / plugin.name / 'SKILL.md'
                self.assertTrue(skill.is_file())
                references = list((skill.parent / 'references').glob('*.md'))
                self.assertEqual({p.name for p in references}, {'auth.md', 'reading.md', 'comments.md', 'assets.md'})
                for path in [skill, *references]:
                    for target in re.findall(r'\]\(([^)]+)\)', path.read_text()):
                        if '://' in target or target.startswith('#'):
                            continue
                        resolved = (path.parent / target.split('#', 1)[0]).resolve()
                        self.assertTrue(resolved.is_relative_to(plugin.resolve()), target)
                        self.assertTrue(resolved.exists(), str(resolved))
                for path in plugin.rglob('*'):
                    if path.is_symlink():
                        self.assertTrue(path.resolve().is_relative_to(plugin.resolve()), str(path))

    def test_generated_runtime_references_and_body_match(self):
        runtime = {p.name: p.read_bytes() for p in (CANONICAL / 'scripts').glob('*.py') if p.name != 'sync-compat.py'}
        copied = {p.name: p.read_bytes() for p in (LEGACY / 'scripts').glob('*.py')}
        self.assertTrue(runtime)
        self.assertEqual(copied, runtime)
        for source in (CANONICAL / 'skills/figma-ops/references').glob('*.md'):
            self.assertEqual((LEGACY / 'skills/figma-lookup/references' / source.name).read_bytes(), source.read_bytes())
        canonical = (CANONICAL / 'skills/figma-ops/SKILL.md').read_text()
        compatibility = (LEGACY / 'skills/figma-lookup/SKILL.md').read_text()
        self.assertEqual(compatibility.split('---', 2)[2], canonical.split('---', 2)[2])
        self.assertIn('compatibility', compatibility.split('---', 2)[1].lower())

    def test_sync_is_reproducible_and_excludes_maintenance_tool(self):
        with tempfile.TemporaryDirectory(prefix='figma sync ') as temporary:
            root = Path(temporary)
            for source in (CANONICAL, LEGACY):
                shutil.copytree(source, root / 'plugins' / source.name)
            script = root / 'plugins/figma-ops/scripts/sync-compat.py'
            stale = root / 'plugins/figma-lookup/scripts/obsolete.py'
            stale.write_text('obsolete')
            copied = root / 'plugins/figma-lookup/scripts/figma_ops.py'
            copied.write_text('drift')
            for _ in range(2):
                result = subprocess.run([sys.executable, str(script)], cwd=temporary, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(copied.read_bytes(), (CANONICAL / 'scripts/figma_ops.py').read_bytes())
            self.assertFalse(stale.exists())
            self.assertFalse((copied.parent / 'sync-compat.py').exists())

    def test_standalone_cli_from_cwd_with_spaces(self):
        for source in (CANONICAL, LEGACY):
            with self.subTest(plugin=source.name), tempfile.TemporaryDirectory(prefix='figma install ') as temporary:
                root = Path(temporary)
                plugin = root / 'only installed plugin'
                shutil.copytree(source, plugin)
                cwd = root / 'unrelated working directory'
                cwd.mkdir()
                script = plugin / 'scripts/figma_ops.py'
                for command in (None, *COMMANDS):
                    args = [sys.executable, str(script), *([command] if command else []), '--help']
                    result = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
                    self.assertEqual(result.returncode, 0, result.stderr)
                # A fake transport executes the installed runtime, without network or Keychain.
                binary = root / 'fake bin'
                binary.mkdir()
                curl = binary / 'curl'
                curl.write_text('#!' + sys.executable + '\n' + FAKE_CURL)
                curl.chmod(0o700)
                environment = dict(os.environ, FIGMA_TOKEN='synthetic-packaging-token', PATH=str(binary) + os.pathsep + os.defpath)
                examples = [
                    ['doctor'], ['inspect', 'SyntheticKey', '--node', '1:2', '--depth', '1'],
                    ['search', 'SyntheticKey', '--node', '1:2', '--query', 'Synthetic'],
                    ['comments', 'SyntheticKey', '--query', 'reply'],
                    ['thread', 'SyntheticKey', '--comment', 'reply'],
                    ['annotations', 'SyntheticKey', '--node', '1:2'],
                    ['export', 'SyntheticKey', '--node', '1:2', '--dest', str(cwd / 'export')],
                    ['fills', 'SyntheticKey', '--node', '1:2', '--dest', str(cwd / 'fills')],
                ]
                for arguments in examples:
                    result = subprocess.run([sys.executable, str(script), *arguments, '--no-cache'], cwd=cwd,
                                            env=environment, capture_output=True, text=True)
                    self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
                    response = json.loads(result.stdout)
                    self.assertEqual(response['status'], 'ok', response)
                    self.assertEqual(response['operation'], arguments[0])
                    self.assertNotIn('synthetic-packaging-token', result.stdout + result.stderr)
                self.assertEqual(len(list((cwd / 'export').glob('*.png'))), 1)
                self.assertEqual(len(list((cwd / 'fills').glob('*'))), 1)


FAKE_CURL = r'''
import json
from pathlib import Path
import sys
from urllib.parse import urlsplit
import zlib
import struct
arguments = sys.argv[1:]
assert 'synthetic-packaging-token' not in ' '.join(arguments)
url = arguments[arguments.index('--url') + 1]
if url.startswith('https://api.figma.com/'):
    assert 'synthetic-packaging-token' in sys.stdin.read()
node = {'id': '1:2', 'name': 'Synthetic frame', 'type': 'FRAME', 'children': [],
        'fills': [{'type': 'IMAGE', 'imageRef': 'synthetic-image'}],
        'annotations': [{'label': 'Synthetic note', 'properties': [{'type': 'width'}]}]}
document = {'id': '0:0', 'type': 'DOCUMENT', 'children': [
    {'id': '0:1', 'type': 'CANVAS', 'name': 'Synthetic page', 'children': [node]}]}
path = urlsplit(url).path
if path.endswith('/me'):
    payload = {'id': 'synthetic-user'}
elif path.endswith('/comments'):
    payload = {'comments': [
        {'id': 'root', 'parent_id': '', 'message': 'Synthetic root', 'created_at': '2026-01-01T00:00:00Z', 'user': {'handle': 'A'}},
        {'id': 'reply', 'parent_id': 'root', 'message': 'Synthetic reply', 'created_at': '2026-01-01T01:00:00Z', 'user': {'handle': 'B'}}]}
elif path.startswith('/v1/images/'):
    payload = {'images': {'1:2': 'https://assets.example.test/image.png'}}
elif path.endswith('/images'):
    payload = {'meta': {'images': {'synthetic-image': 'https://assets.example.test/image.png'}}}
else:
    payload = {'document': document, 'version': 'synthetic-version'}
if url.startswith('https://assets.example.test/'):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    body = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b'\x00\x00\x00\x00\x00')) + chunk(b'IEND', b'')
else:
    body = json.dumps(payload).encode()
Path(arguments[arguments.index('--output') + 1]).write_bytes(body)
Path(arguments[arguments.index('--dump-header') + 1]).write_text('HTTP/1.1 200 OK\r\n\r\n')
print('200', end='')
'''

if __name__ == '__main__':
    unittest.main()
