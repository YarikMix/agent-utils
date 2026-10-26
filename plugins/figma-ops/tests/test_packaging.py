"""Installed roots are self-contained; generated compatibility cannot drift."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

from test_image import png

ROOT = Path(__file__).resolve().parents[3]
CANONICAL = ROOT / 'plugins' / 'figma-ops'
LEGACY = ROOT / 'plugins' / 'figma-lookup'
COMMANDS = ('doctor', 'inspect', 'search', 'comments', 'thread', 'export', 'fills', 'annotations', 'prototype', 'context', 'bindings')


class PackagingTests(unittest.TestCase):
    def test_host_catalogs_resolve_both_plugins_and_discover_skills(self):
        for host, catalog in (('.claude-plugin', '.claude-plugin/marketplace.json'),
                              ('.codex-plugin', '.agents/plugins/marketplace.json')):
            entries = json.loads((ROOT / catalog).read_text())['plugins']
            for name, version in (('figma-ops', '1.4.0'), ('figma-lookup', '1.5.0')):
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
                    frontmatter, body = skill.read_text().split('---', 2)[1:]
                    self.assertRegex(frontmatter, r'\ndescription: \S[^\n]+\n')
                    self.assertTrue(body.strip())
                    self.assertTrue((directory / 'LICENSE').is_file())

    def test_all_skill_reference_links_resolve_inside_plugin(self):
        for plugin in (CANONICAL, LEGACY):
            with self.subTest(plugin=plugin.name):
                skill = plugin / 'skills' / plugin.name / 'SKILL.md'
                self.assertTrue(skill.is_file())
                references = list((skill.parent / 'references').glob('*.md'))
                self.assertEqual({p.name for p in references}, {'auth.md', 'reading.md', 'comments.md', 'assets.md', 'context.md', 'bindings.md', 'mcp-routing.md', 'native-assets.md'})
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
        self.assertEqual(len(runtime), 16)
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
            snapshots = []
            for _ in range(2):
                result = subprocess.run([sys.executable, str(script)], cwd=temporary, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(copied.read_bytes(), (CANONICAL / 'scripts/figma_ops.py').read_bytes())
                snapshots.append({str(p.relative_to(copied.parents[1])): p.read_bytes()
                                  for p in copied.parents[1].rglob('*') if p.is_file()})
            self.assertEqual(snapshots[0], snapshots[1])
            self.assertFalse(stale.exists())
            self.assertFalse((copied.parent / 'sync-compat.py').exists())

    def test_standalone_asset_verifier_from_cwd_with_spaces(self):
        for source in (CANONICAL, LEGACY):
            with self.subTest(plugin=source.name), tempfile.TemporaryDirectory(prefix='figma asset install ') as temporary:
                root = Path(temporary)
                plugin = root / 'only installed plugin'
                shutil.copytree(source, plugin)
                self.assertEqual([path.name for path in root.iterdir()], ['only installed plugin'])
                cwd = root / 'unrelated working directory'
                cwd.mkdir()
                script = plugin / 'scripts/figma_asset_verify.py'
                transparent = cwd / 'transparent asset.dat'
                opaque = cwd / 'opaque asset.png'
                transparent.write_bytes(png(b'\x00\x10\x20\x30\x00'))
                opaque.write_bytes(png(b'\x00\x10\x20\x30\xff'))
                binary = root / 'fake bin'
                binary.mkdir()
                call_log = root / 'forbidden calls.log'
                call_log.write_text('')
                for name in ('curl', 'security'):
                    command = binary / name
                    command.write_text('#!' + sys.executable + '\nimport os\n'
                                       "with open(os.environ['FIGMA_PACKAGING_CALL_LOG'], 'a') as log: log.write('called\\n')\n"
                                       'raise SystemExit(99)\n')
                    command.chmod(0o700)
                environment = dict(os.environ, FIGMA_TOKEN='', FIGMA_ACCESS_TOKEN='',
                                   FIGMA_PACKAGING_CALL_LOG=str(call_log), PYTHONDONTWRITEBYTECODE='1',
                                   PATH=str(binary) + os.pathsep + os.defpath)
                cache = Path.home() / '.cache' / 'figma-ops'

                def cache_snapshot():
                    return (cache.exists(), {str(path.relative_to(cache)): (path.stat().st_size, path.stat().st_mtime_ns)
                                             for path in cache.rglob('*') if path.is_file()})

                def snapshot():
                    return {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
                            if path.is_file() else None for path in root.rglob('*')}

                before, cache_before = snapshot(), cache_snapshot()
                help_result = subprocess.run([sys.executable, str(script), '--help'], cwd=cwd,
                                             env=environment, capture_output=True, text=True)
                self.assertEqual(help_result.returncode, 0, help_result.stderr)
                self.assertIn('--require-transparency', help_result.stdout)
                cases = [([str(transparent), '--expect-width', '1', '--expect-height', '1',
                           '--require-transparency'], 0, None),
                         ([str(opaque), '--require-transparency'], 1, 'asset_mismatch'),
                         ([str(transparent), '--expect-width', '1'], 2, 'invalid_argument')]
                helper_count = 0
                for arguments, code, error in cases:
                    with self.subTest(arguments=arguments):
                        result = subprocess.run([sys.executable, str(script), *arguments], cwd=cwd,
                                                env=environment, capture_output=True, text=True)
                        self.assertEqual(result.returncode, code, result.stderr + result.stdout)
                        receipt = json.loads(result.stdout)
                        self.assertEqual(result.stderr, '')
                        self.assertEqual(receipt['source'], 'local-file')
                        self.assertIs(receipt['data']['provenance_verified'], False)
                        if error is None:
                            self.assertEqual((result.returncode, json.loads(result.stdout)['source']), (0, 'local-file'))
                            self.assertEqual(receipt['status'], 'ok')
                            self.assertEqual(receipt['data']['checks'], {'valid_png': 'passed', 'width': 'passed',
                                                                       'height': 'passed', 'transparency': 'passed'})
                        else:
                            self.assertEqual((receipt['status'], receipt['error']['code']), ('error', error))
                        self.assertEqual(snapshot(), before)
                        self.assertEqual(cache_snapshot(), cache_before)
                        helper_count += 1
                self.assertEqual(helper_count, 3)
                self.assertEqual(call_log.read_text(), '')
                print(f'{source.name}: {helper_count} standalone asset helper cases, 1 helper help call')

    def test_standalone_cli_from_cwd_with_spaces(self):
        for source in (CANONICAL, LEGACY):
            with self.subTest(plugin=source.name), tempfile.TemporaryDirectory(prefix='figma install ') as temporary:
                root = Path(temporary)
                plugin = root / 'only installed plugin'
                shutil.copytree(source, plugin)
                cwd = root / 'unrelated working directory'
                cwd.mkdir()
                script = plugin / 'scripts/figma_ops.py'
                help_count = 0
                for command in (None, *COMMANDS):
                    args = [sys.executable, str(script), *([command] if command else []), '--help']
                    result = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    help_count += 1
                self.assertEqual(help_count, 12)
                # A fake transport executes the installed runtime, without network or Keychain.
                binary = root / 'fake bin'
                binary.mkdir()
                curl = binary / 'curl'
                curl.write_text('#!' + sys.executable + '\n' + FAKE_CURL)
                curl.chmod(0o700)
                request_log = root / 'requests.jsonl'
                environment = dict(os.environ, FIGMA_TOKEN='synthetic-packaging-token',
                                   FIGMA_PACKAGING_REQUEST_LOG=str(request_log),
                                   PATH=str(binary) + os.pathsep + os.defpath)

                def invoke(arguments):
                    request_log.write_text('')
                    result = subprocess.run([sys.executable, str(script), *arguments, '--no-cache'], cwd=cwd,
                                            env=environment, capture_output=True, text=True)
                    self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
                    self.assertNotIn('synthetic-packaging-token', result.stdout + result.stderr)
                    return json.loads(result.stdout), request_log.read_text().splitlines()

                def assert_inventory(response, *, root_id='1:2', definition_state='not_requested', file_key='SyntheticKey'):
                    self.assertEqual(response['file_key'], file_key)
                    self.assertEqual(response['data']['source_node']['id'], '1:2')
                    self.assertEqual(response['data']['scope_root']['id'], root_id)
                    inventory = response['data']['sections']['bindings']['data']
                    instance, = inventory['instances']
                    self.assertEqual(instance['node']['id'], '1:2')
                    self.assertEqual(instance['component_id'], '5:1')
                    self.assertEqual(instance['component_properties']['Enabled#1']['value'], False)
                    self.assertEqual(instance['component_properties']['Label#2']['value'], '')
                    self.assertEqual(instance['component_properties']['Content#3']['value'],
                                     {'guid': {'sessionID': 7, 'localID': 8}})
                    component, = inventory['components']
                    self.assertEqual((component['id'], component['metadata']['key']), ('5:1', 'component-key'))
                    self.assertEqual([row['id'] for row in inventory['styles']], ['style:1'])
                    self.assertEqual(inventory['styles'][0]['metadata']['key'], 'style-key')
                    usage, = inventory['style_usages']
                    self.assertEqual((usage['node']['id'], usage['style_id']), ('1:2', 'style:1'))
                    binding, = inventory['variable_bindings']
                    self.assertEqual(binding['reference_id'], 'A')
                    self.assertEqual(binding['definition_state'], definition_state)

                examples = [
                    ['doctor'], ['inspect', 'SyntheticKey', '--node', '1:2', '--depth', '1'],
                    ['search', 'SyntheticKey', '--node', '1:2', '--query', 'Synthetic'],
                    ['comments', 'SyntheticKey', '--query', 'reply'],
                    ['thread', 'SyntheticKey', '--comment', 'reply'],
                    ['annotations', 'SyntheticKey', '--node', '1:2'],
                    ['prototype', 'SyntheticKey', '--node', '1:2'],
                    ['context', 'SyntheticKey', '--node', '1:2'],
                    ['bindings', 'SyntheticKey', '--node', '1:2'],
                    ['export', 'SyntheticKey', '--node', '1:2', '--dest', str(cwd / 'export')],
                    ['fills', 'SyntheticKey', '--node', '1:2', '--dest', str(cwd / 'fills')],
                ]
                operation_count = 0
                for arguments in examples:
                    response, requests = invoke(arguments)
                    self.assertEqual(response['status'], 'ok', response)
                    self.assertEqual(response['operation'], arguments[0])
                    operation_count += 1
                    if arguments[0] == 'annotations':
                        self.assertEqual(response['data']['annotations'][0]['raw']['label'], 'Synthetic note')
                    if arguments[0] == 'prototype':
                        self.assertEqual(response['data']['interactions'][0]['raw']['actions'][0]['destinationId'], '1:2')
                    if arguments[0] == 'bindings':
                        assert_inventory(response)
                        self.assertEqual(response['data']['sections']['variables']['state'], 'not_requested')
                        self.assertEqual(requests, ['/v1/files/SyntheticKey?ids=1%3A2'])
                    if arguments[0] == 'context':
                        self.assertEqual(len(response['data']['sections']), 6)
                        self.assertEqual(len(response['data']['next_actions']), 2)
                        self.assertEqual(response['data']['sections']['comments']['data']['threads'][0]['root']['id'], 'root')
                        self.assertEqual(len(response['data']['sections']['comments']['data']['threads'][0]['replies']), 1)
                self.assertEqual(operation_count, 11)
                additional_count = 0
                partial, _ = invoke(['annotations', 'PartialKey', '--node', '1:2'])
                self.assertEqual(partial['status'], 'partial')
                additional_count += 1
                for operation, flags in [('bindings', []), ('context', ['--with-bindings'])]:
                    if operation == 'context':
                        response, requests = invoke([operation, 'SyntheticKey', '--node', '1:2',
                                                     '--scope-root', '1:1', *flags])
                        assert_inventory(response, root_id='1:1')
                        self.assertEqual(len(requests), 2)
                        self.assertEqual(sum('/variables/' in path for path in requests), 0)
                        self.assertEqual(sum('?ids=' in path for path in requests), 1)
                        self.assertEqual(len(response['data']['sections']), 8)
                        self.assertEqual(len(response['data']['next_actions']), 4)
                        thread, = response['data']['sections']['comments']['data']['threads']
                        self.assertEqual((thread['root']['id'], len(thread['replies'])), ('root', 1))
                        additional_count += 1
                    for target in ['SyntheticKey', 'ForbiddenKey']:
                        response, requests = invoke([operation, target, '--node', '1:2', *flags, '--with-variables'])
                        variables = response['data']['sections']['variables']
                        self.assertEqual(len(requests), 2 if operation == 'bindings' else 3)
                        self.assertEqual(sum('?ids=' in path for path in requests), 1)
                        self.assertEqual(sum('/variables/local' in path for path in requests), 1)
                        self.assertIsNone(variables['version'])
                        self.assertEqual(variables['coverage']['request_scope'], 'file-variable-metadata')
                        if target == 'ForbiddenKey':
                            self.assertEqual(response['status'], 'partial')
                            self.assertEqual(variables['state'], 'failed')
                            self.assertEqual(variables['error']['http_status'], 403)
                            assert_inventory(response, definition_state='unresolved', file_key=target)
                        else:
                            self.assertEqual(response['status'], 'ok')
                            self.assertEqual(len(variables['data']['alias_links']), 1)
                            self.assertEqual([row['raw']['id'] for row in variables['data']['variables']], ['A', 'B'])
                            assert_inventory(response, definition_state='available')
                        additional_count += 1
                self.assertEqual(additional_count, 6)
                print(f'{source.name}: {operation_count} base operations, {help_count} help calls, '
                      f'{additional_count} additional enrichment/partial/context cases')
                self.assertEqual(len(list((cwd / 'export').glob('*.png'))), 1)
                self.assertEqual(len(list((cwd / 'fills').glob('*'))), 1)


FAKE_CURL = r'''
import json
import os
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
        'annotations': [{'label': 'Synthetic note', 'properties': [{'type': 'width'}]}],
        'interactions': [{'trigger': {'type': 'ON_CLICK'}, 'actions': [
            {'type': 'NODE', 'destinationId': '1:2', 'navigation': 'CHANGE_TO',
             'transition': {'type': 'SMART_ANIMATE', 'duration': 0.2, 'easing': {'type': 'LINEAR'}}}]}]}
node.update(type='INSTANCE', componentId='5:1', componentProperties={
                'Enabled#1': {'type': 'BOOLEAN', 'value': False},
                'Label#2': {'type': 'TEXT', 'value': ''},
                'Content#3': {'type': 'SLOT', 'value': {'guid': {'sessionID': 7, 'localID': 8}}}},
            styles={'fill': 'style:1'},
            boundVariables={'opacity': {'type': 'VARIABLE_ALIAS', 'id': 'A'}})
document = {'id': '0:0', 'type': 'DOCUMENT', 'children': [
    {'id': '0:1', 'type': 'CANVAS', 'name': 'Synthetic page', 'children': [{'id': '1:1', 'type': 'FRAME', 'children': [node]}]}]}
parsed = urlsplit(url)
path = parsed.path
if url.startswith('https://api.figma.com/'):
    with Path(os.environ['FIGMA_PACKAGING_REQUEST_LOG']).open('a') as log:
        log.write(path + ('?' + parsed.query if parsed.query else '') + '\n')
http_status = 200
if '/PartialKey' in path:
    node['annotations'] = 'malformed synthetic field'
if path.endswith('/me'):
    payload = {'id': 'synthetic-user'}
elif path.endswith('/comments'):
    payload = {'comments': [
        {'id': 'root', 'parent_id': '', 'message': 'Synthetic root', 'client_meta': {'node_id': '1:2'}, 'created_at': '2026-01-01T00:00:00Z', 'user': {'handle': 'A'}},
        {'id': 'reply', 'parent_id': 'root', 'message': 'Synthetic reply', 'created_at': '2026-01-01T01:00:00Z', 'user': {'handle': 'B'}}]}
elif path.endswith('/variables/local'):
    if '/ForbiddenKey/' in path:
        http_status = 403
    payload = {'status': 200, 'error': False, 'meta': {'variables': {
        'A': {'id': 'A', 'variableCollectionId': 'c', 'valuesByMode': {'m': {'type': 'VARIABLE_ALIAS', 'id': 'B'}}},
        'B': {'id': 'B', 'variableCollectionId': 'c', 'valuesByMode': {'m': 0}}},
        'variableCollections': {'c': {'id': 'c', 'modes': [{'modeId': 'm', 'name': 'Default'}]}}}}
elif path.startswith('/v1/images/'):
    payload = {'images': {'1:2': 'https://assets.example.test/image.png'}}
elif path.endswith('/images'):
    payload = {'meta': {'images': {'synthetic-image': 'https://assets.example.test/image.png'}}}
else:
    payload = {'document': document, 'version': 'synthetic-version',
               'components': {'5:1': {'key': 'component-key', 'name': 'Synthetic component'},
                              'unused-component': {'key': 'unused-key', 'name': 'Unused component'}},
               'styles': {'style:1': {'key': 'style-key', 'name': 'Synthetic fill', 'styleType': 'FILL'},
                          'unused-style': {'key': 'unused-style-key', 'name': 'Unused style'}}}
if url.startswith('https://assets.example.test/'):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    body = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b'\x00\x00\x00\x00\x00')) + chunk(b'IEND', b'')
else:
    body = json.dumps(payload).encode()
Path(arguments[arguments.index('--output') + 1]).write_bytes(body)
Path(arguments[arguments.index('--dump-header') + 1]).write_text(f'HTTP/1.1 {http_status} Synthetic\r\n\r\n')
print(str(http_status), end='')
'''

if __name__ == '__main__':
    unittest.main()
