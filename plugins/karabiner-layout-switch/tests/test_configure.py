import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "skills/karabiner-layout-switch/scripts/configure.py"
DESCRIPTION = "karabiner-layout-switch: Cmd + Shift (English / Russian)"
KEYCHRON = {
    "product": "Keychron K8 Pro",
    "device_identifiers": {
        "vendor_id": 13364, "product_id": 640,
        "is_keyboard": True, "is_pointing_device": True,
    },
}


class ConfigureTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.config = self.root / "karabiner.json"
        self.devices = self.root / "devices.json"
        self.devices.write_text(json.dumps([KEYCHRON]))
        self.original = {
            "global": {"show_in_menu_bar": False},
            "profiles": [
                {"name": "Other", "selected": False, "devices": [{"ignore": True}]},
                {
                    "name": "Work", "selected": True,
                    "simple_modifications": [{"from": {"key_code": "a"}, "to": [{"key_code": "b"}]}],
                    "complex_modifications": {"parameters": {"basic.to_if_alone_timeout_milliseconds": 300},
                                              "rules": [{"description": "My existing rule", "manipulators": []}]},
                    "devices": [{"identifiers": {"vendor_id": 1133, "product_id": 45108,
                                                 "is_pointing_device": True}, "ignore": True}],
                    "virtual_hid_keyboard": {"keyboard_type_v2": "iso"},
                },
            ],
        }
        self.config.write_text(json.dumps(self.original))

    def run_tool(self, *args, success=True):
        result = subprocess.run([
            sys.executable, str(SCRIPT), "--config", str(self.config),
            "--english-id", "com.apple.keylayout.US",
            "--russian-id", "com.apple.keylayout.RussianWin",
            "--devices-json", str(self.devices), *args,
        ], text=True, capture_output=True)
        if success:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0)
        return result

    def read(self):
        return json.loads(self.config.read_text())

    def test_preview_does_not_write_or_backup(self):
        before = self.config.read_bytes()
        result = self.run_tool()
        self.assertEqual(self.config.read_bytes(), before)
        self.assertEqual(list(self.root.glob("karabiner.json.backup-*")), [])
        self.assertTrue(json.loads(result.stdout)["changed"])

    def test_apply_preserves_other_settings_and_backs_up_exact_bytes(self):
        before = self.config.read_bytes()
        self.run_tool("--apply", "--keyboard-type", "ansi")
        actual = self.read()
        active = actual["profiles"][1]
        self.assertEqual(actual["global"], self.original["global"])
        self.assertEqual(actual["profiles"][0], self.original["profiles"][0])
        self.assertEqual(active["simple_modifications"], self.original["profiles"][1]["simple_modifications"])
        self.assertEqual(active["virtual_hid_keyboard"], {"keyboard_type_v2": "iso"})
        self.assertEqual(active["complex_modifications"]["rules"][1:],
                         self.original["profiles"][1]["complex_modifications"]["rules"])
        self.assertEqual(active["complex_modifications"]["parameters"],
                         self.original["profiles"][1]["complex_modifications"]["parameters"])
        backups = list(self.root.glob("karabiner.json.backup-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), before)

    def test_enables_only_observed_keychron_preserving_other_device_settings(self):
        self.run_tool("--apply")
        devices = self.read()["profiles"][1]["devices"]
        self.assertEqual(devices[0], self.original["profiles"][1]["devices"][0])
        self.assertEqual(devices[1], {"identifiers": KEYCHRON["device_identifiers"], "ignore": False})

    def test_updates_existing_keychron_override_without_duplicate(self):
        d = copy.deepcopy(self.original)
        d["profiles"][1]["devices"].append({"identifiers": KEYCHRON["device_identifiers"],
                                          "ignore": True, "simple_modifications": [{"custom": True}]})
        self.config.write_text(json.dumps(d))
        self.run_tool("--apply")
        devices = self.read()["profiles"][1]["devices"]
        self.assertEqual(len(devices), 2)
        self.assertFalse(devices[1]["ignore"])
        self.assertEqual(devices[1]["simple_modifications"], [{"custom": True}])

    def test_repeat_is_byte_identical_and_creates_no_new_backup(self):
        self.run_tool("--apply")
        before = self.config.read_bytes()
        self.run_tool("--apply")
        self.assertEqual(self.config.read_bytes(), before)
        self.assertEqual(len(list(self.root.glob("karabiner.json.backup-*"))), 1)

    def test_rules_cover_both_sides_orders_and_actual_input_sources(self):
        self.run_tool("--apply")
        rule = self.read()["profiles"][1]["complex_modifications"]["rules"][0]
        self.assertEqual(rule["description"], DESCRIPTION)
        manipulators = rule["manipulators"]
        self.assertEqual(len(manipulators), 16)
        seen = set()
        for m in manipulators:
            key = m["from"]["key_code"]
            held = m["from"]["modifiers"]["mandatory"][0]
            self.assertEqual(m["to"], [{"key_code": key, "modifiers": [held]}])
            self.assertNotIn("any", m["from"]["modifiers"].get("optional", []))
            self.assertNotIn("to_after_key_up", m)
            self.assertNotIn("select_input_source", m["to"][0])
            source = m["conditions"][0]["input_sources"][0]["input_source_id"]
            target = m["to_if_alone"][0]["select_input_source"]["input_source_id"]
            self.assertNotEqual(source, target)
            self.assertIn(source, [r"^com\.apple\.keylayout\.US$", r"^com\.apple\.keylayout\.RussianWin$"])
            self.assertIn(target, [r"^com\.apple\.keylayout\.US$", r"^com\.apple\.keylayout\.RussianWin$"])
            seen.add((key, held, source))
        self.assertEqual(len(seen), 16)

    def test_creates_new_config_and_explicit_keyboard_type(self):
        self.config.unlink()
        self.run_tool("--apply", "--keyboard-type", "ansi")
        profile = self.read()["profiles"][0]
        self.assertTrue(profile["selected"])
        self.assertEqual(profile["virtual_hid_keyboard"]["keyboard_type_v2"], "ansi")
        self.assertEqual(list(self.root.glob("karabiner.json.backup-*")), [])

    def test_usb_product_id_is_discovered_instead_of_hardcoded(self):
        usb = copy.deepcopy(KEYCHRON)
        usb["device_identifiers"]["product_id"] = 999
        self.devices.write_text(json.dumps([usb]))
        self.run_tool("--apply")
        self.assertEqual(self.read()["profiles"][1]["devices"][1]["identifiers"]["product_id"], 999)

    def test_other_keyboards_do_not_get_keychron_override(self):
        other = copy.deepcopy(KEYCHRON)
        other["product"] = "Other keyboard"
        self.devices.write_text(json.dumps([other]))
        self.run_tool("--apply")
        self.assertEqual(self.read()["profiles"][1]["devices"], self.original["profiles"][1]["devices"])

    def test_invalid_config_is_untouched(self):
        for invalid in ["{bad", '{"profiles": []}', '{"profiles": [{"selected": true}, {"selected": true}]}']:
            with self.subTest(invalid=invalid):
                self.config.write_text(invalid)
                self.run_tool("--apply", success=False)
                self.assertEqual(self.config.read_text(), invalid)

    def test_invalid_devices_do_not_change_config(self):
        before = self.config.read_bytes()
        self.devices.write_text('{"error": "daemon unavailable"}')
        self.run_tool("--apply", success=False)
        self.assertEqual(self.config.read_bytes(), before)

    def test_identical_input_sources_rejected(self):
        before = self.config.read_bytes()
        self.run_tool("--russian-id", "com.apple.keylayout.US", "--apply", success=False)
        self.assertEqual(self.config.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
