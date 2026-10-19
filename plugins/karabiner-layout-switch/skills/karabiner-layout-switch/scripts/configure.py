#!/usr/bin/env python3
"""Preview or merge one Cmd+Shift rule; never install apps or change permissions."""

import argparse
import copy
import json
import os
import re
import stat
import tempfile
import time
from pathlib import Path


DESCRIPTION = "karabiner-layout-switch: Cmd + Shift (English / Russian)"
LEGACY_DESCRIPTION = "Cmd + Shift alone: toggle ABC / Russian; preserve shortcuts (both sides, either order)"


def make_rule(english, russian):
    manipulators = []
    for command in ("left_command", "right_command"):
        for shift in ("left_shift", "right_shift"):
            for key, held in ((shift, command), (command, shift)):
                for source, target in ((english, russian), (russian, english)):
                    manipulators.append({
                        "type": "basic",
                        "from": {"key_code": key, "modifiers": {
                            "mandatory": [held], "optional": ["caps_lock"],
                        }},
                        "to": [{"key_code": key, "modifiers": [held]}],
                        "to_if_alone": [{"select_input_source": {
                            "input_source_id": "^" + re.escape(target) + "$",
                        }}],
                        "conditions": [{"type": "input_source_if", "input_sources": [{
                            "input_source_id": "^" + re.escape(source) + "$",
                        }]}],
                        "parameters": {"basic.to_if_alone_timeout_milliseconds": 60000},
                    })
    return {"description": DESCRIPTION, "manipulators": manipulators}


def keychron_identifiers(devices):
    if not isinstance(devices, list) or any(not isinstance(d, dict) for d in devices):
        raise ValueError("devices-json must contain the array from karabiner_cli --list-connected-devices")
    result = []
    for device in devices:
        ids = device.get("device_identifiers", {})
        if not isinstance(ids, dict):
            raise ValueError("device_identifiers must be an object")
        if (device.get("product", "").strip().casefold() != "keychron k8 pro"
                or ids.get("vendor_id") != 13364 or ids.get("is_keyboard") is not True):
            continue
        if type(ids.get("product_id")) is not int or ids["product_id"] <= 0:
            raise ValueError("Keychron product_id is missing or invalid")
        if any(type(ids.get(k, False)) is not bool for k in ("is_pointing_device", "is_game_pad")):
            raise ValueError("Invalid Keychron device flags")
        identity = {"vendor_id": 13364, "product_id": ids["product_id"], "is_keyboard": True}
        for flag in ("is_pointing_device", "is_game_pad"):
            if ids.get(flag):
                identity[flag] = True
        if identity not in result:
            result.append(identity)
    return result


def merge(config, rule, observed, keyboard_type):
    candidate = copy.deepcopy(config)
    profiles = candidate.get("profiles")
    if not isinstance(profiles, list) or not profiles or any(not isinstance(p, dict) for p in profiles):
        raise ValueError("Config must contain a nonempty profiles array")
    selected = [p for p in profiles if p.get("selected") is True]
    if len(selected) == 1:
        profile = selected[0]
    elif not selected and len(profiles) == 1:
        profile = profiles[0]
        profile["selected"] = True
    else:
        raise ValueError("Cannot determine active profile; select exactly one in Karabiner Settings")
    modifications = profile.setdefault("complex_modifications", {})
    if not isinstance(modifications, dict):
        raise ValueError("complex_modifications must be an object")
    rules = modifications.setdefault("rules", [])
    if not isinstance(rules, list) or any(not isinstance(r, dict) for r in rules):
        raise ValueError("rules must be an array of objects")
    rules[:] = [r for r in rules if r.get("description") not in (DESCRIPTION, LEGACY_DESCRIPTION)]
    rules.insert(0, rule)
    if observed:
        devices = profile.setdefault("devices", [])
        if not isinstance(devices, list) or any(not isinstance(d, dict) for d in devices):
            raise ValueError("devices must be an array of objects")
        for identity in observed:
            # Omitted false flags and explicit false flags describe the same device.
            def matches(entry):
                ids = entry.get("identifiers", {})
                if not isinstance(ids, dict):
                    return False
                keys = set(ids) | set(identity)
                return all(ids.get(k, False) == identity.get(k, False) for k in keys)
            existing = [entry for entry in devices if matches(entry)]
            if not existing:
                existing = [{"identifiers": identity}]
                devices.extend(existing)
            for entry in existing:
                entry["ignore"] = False
    if keyboard_type:
        keyboard = profile.setdefault("virtual_hid_keyboard", {})
        if not isinstance(keyboard, dict):
            raise ValueError("virtual_hid_keyboard must be an object")
        # Retain a user's existing choice, including the older keyboard_type field.
        if not keyboard.get("keyboard_type_v2") and not keyboard.get("keyboard_type"):
            keyboard["keyboard_type_v2"] = keyboard_type
    return candidate, profile


def save(path, before, candidate):
    """Back up original bytes and replace atomically, refusing a detected concurrent edit."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if (path.read_bytes() if path.exists() else None) != before:
        raise ValueError("Config changed during preparation; rerun preview")
    mode = stat.S_IMODE(path.stat().st_mode) if before is not None else 0o600
    backup = None
    if before is not None:
        backup = path.with_name(path.name + ".backup-" + str(time.time_ns()))
        with backup.open("xb") as stream:
            os.chmod(backup, mode)
            stream.write(before)
    fd, temporary = tempfile.mkstemp(prefix=".karabiner-", suffix=".json", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            os.fchmod(stream.fileno(), mode)
            json.dump(candidate, stream, ensure_ascii=False, indent=4)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        if (path.read_bytes() if path.exists() else None) != before:
            raise ValueError("Config changed before replacement; rerun preview")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return str(backup) if backup else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    config_root = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    parser.add_argument("--config", type=Path, default=config_root / "karabiner/karabiner.json")
    parser.add_argument("--english-id", required=True, help="Observed input source ID, not display name")
    parser.add_argument("--russian-id", required=True, help="Observed input source ID, not display name")
    parser.add_argument("--devices-json", type=Path, help="Saved successful karabiner_cli device array")
    parser.add_argument("--keyboard-type", choices=("ansi", "iso", "jis"), help="Only fills an unset type")
    parser.add_argument("--apply", action="store_true", help="Write changes; default is read-only preview")
    args = parser.parse_args()
    try:
        if (not args.english_id.strip() or not args.russian_id.strip()
                or args.english_id == args.russian_id):
            raise ValueError("Two distinct, observed input source IDs are required")
        path = args.config.expanduser().resolve()
        before = path.read_bytes() if path.exists() else None
        config = json.loads(before) if before is not None else {
            "profiles": [{"name": "Default profile", "selected": True}],
        }
        if not isinstance(config, dict):
            raise ValueError("Config root must be an object")
        devices = json.loads(args.devices_json.read_text()) if args.devices_json else []
        observed = keychron_identifiers(devices)
        candidate, profile = merge(config, make_rule(args.english_id, args.russian_id),
                                   observed, args.keyboard_type)
        changed = before is None or candidate != config
        backup = save(path, before, candidate) if changed and args.apply else None
        print(json.dumps({
            "config": str(path), "profile": profile.get("name"),
            "changed": changed, "applied": bool(changed and args.apply), "backup": backup,
            "english_id": args.english_id, "russian_id": args.russian_id,
            "manipulators": 16, "enabled_keychron_devices": observed,
            "keyboard_type": profile.get("virtual_hid_keyboard"),
        }, ensure_ascii=False, indent=2))
    except (ValueError, OSError, TypeError) as error:
        parser.exit(1, "Configuration unchanged or not completed: " + str(error) + "\n")


if __name__ == "__main__":
    main()
