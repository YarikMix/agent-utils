"""Execute actual fenced Markdown against a small Plugin API boundary double."""
import json
import math
from pathlib import Path
import re
import shutil
import subprocess

NODE = shutil.which("node")


def load_recipe(reference: Path, marker: str, language: str = 'js') -> str:
    if not reference.exists():
        raise AssertionError(f"Recipe reference is not published: {reference.name}")
    pattern = rf"<!-- recipe:{re.escape(marker)} -->\s*```{re.escape(language)}\n(.*?)\n```"
    match = re.search(pattern, reference.read_text(), re.S)
    if match is None:
        raise AssertionError(f"Missing executable recipe: {marker}")
    return match.group(1)


HARNESS = r"""
const fs = require('fs');
const {code, fixture, input, nonfinite_inputs} = JSON.parse(fs.readFileSync(0, 'utf8'));
for (const [key, value] of Object.entries(nonfinite_inputs || {})) input[key] = Number(value);
const accesses = [];
const export_calls = [];
let base64_calls = 0;
const nodes = new Map(fixture.nodes.map(n => [n.id, {...n}]));
for (const node of nodes.values()) {
  node.parent = nodes.get(node.parentId) || null;
  if (node.childrenIds) node.children = node.childrenIds.map(id => nodes.get(id));
  if (node.lazy) Object.defineProperty(node, 'children', {get() {throw Error('unloaded');}});
  if (node.exportBytes !== undefined || node.exportError !== undefined) {
    node.exportAsync = async settings => {
      export_calls.push({nodeId: node.id, settings});
      if (node.exportError !== undefined) throw Error(node.exportError);
      return new Uint8Array(node.exportBytes);
    };
  }
  for (const field of node.throwFields || []) {
    Object.defineProperty(node, field, {get() {throw Error('unavailable');}});
  }
  node.toJSON = () => {throw Error('SceneNode serialization is forbidden');};
}
for (const [id, node] of nodes) nodes.set(id, new Proxy(node, {
  set() {throw Error('node mutation forbidden');}
}));
const figma = {
  fileKey: fixture.fileKey || 'DemoFile',
  base64Encode(bytes) {base64_calls++; return Buffer.from(bytes).toString('base64');},
  get currentPage() {
    accesses.push('selection');
    return {selection: (fixture.selection || []).map(id => nodes.get(id))};
  },
  async getNodeByIdAsync(id) {accesses.push(id); return nodes.get(id) || null;},
  async loadAllPagesAsync() {throw Error('unbounded page loading');}
};
(async () => {
  try {
    const run = new (Object.getPrototypeOf(async function(){}).constructor)('figma', 'input', code);
    const result = await run(figma, input);
    process.stdout.write(JSON.stringify({result, accesses, export_calls, base64_calls}));
  } catch (e) {process.stdout.write(JSON.stringify({error: e.message, accesses, export_calls, base64_calls}));}
})();
"""


def run_js_recipe(reference: Path, marker: str, fixture: dict, inputs: dict) -> dict:
    if NODE is None:
        raise RuntimeError("Node is unavailable")
    nonfinite = {key: str(value).replace('inf', 'Infinity').replace('nan', 'NaN')
                 for key, value in inputs.items()
                 if isinstance(value, float) and not math.isfinite(value)}
    payload = {"code": load_recipe(reference, marker), "fixture": fixture,
               "input": {key: value for key, value in inputs.items() if key not in nonfinite},
               "nonfinite_inputs": nonfinite}
    completed = subprocess.run([NODE, "-e", HARNESS], input=json.dumps(payload),
                               text=True, capture_output=True, check=True, timeout=10)
    return json.loads(completed.stdout)
