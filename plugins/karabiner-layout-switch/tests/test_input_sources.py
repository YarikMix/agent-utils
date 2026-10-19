import json
import subprocess
import sys
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "skills/karabiner-layout-switch/scripts/input_sources.py"


@unittest.skipUnless(sys.platform == "darwin", "macOS TIS integration")
class InputSourcesTests(unittest.TestCase):
    def test_read_only_discovery_returns_real_sources_and_one_current_source(self):
        result = subprocess.run([sys.executable, str(SCRIPT)], text=True,
                                capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        sources = json.loads(result.stdout)
        self.assertGreater(len(sources), 0)
        self.assertEqual(len({s["id"] for s in sources}), len(sources))
        self.assertEqual(sum(s["selected"] for s in sources), 1)
        for source in sources:
            self.assertIsInstance(source["id"], str)
            self.assertTrue(source["id"])
            self.assertIsInstance(source["languages"], list)


if __name__ == "__main__":
    unittest.main()
