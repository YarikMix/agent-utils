"""Execute the published Bridge recipes, without Node becoming a CLI dependency."""
import json
from pathlib import Path
import unittest

from recipe_harness import NODE, run_js_recipe


REFERENCE = Path(__file__).resolve().parents[1] / "skills/figma-ops/references/mcp-routing.md"


@unittest.skipUnless(NODE, "Node is unavailable; executable Markdown recipes require Node")
class MarkdownRecipesTest(unittest.TestCase):
    def run_recipe(self, marker, fixture, **inputs):
        return run_js_recipe(REFERENCE, marker, fixture,
                             {"expectedFileKey": "DemoFile", **inputs})

    def test_wrong_file_rejects_before_any_node_or_selection_access(self):
        for marker in ("identity-ancestry", "bounded-subtree"):
            with self.subTest(recipe=marker):
                out = self.run_recipe(marker, {"fileKey": "Other", "nodes": []},
                                      nodeId="I11:2;33:4", rootId="11:2")
                self.assertIn("file_mismatch", out["error"])
                self.assertEqual([], out["accesses"])

    def test_identity_keeps_composite_id_and_real_ancestry(self):
        out = self.run_recipe("identity-ancestry", {"nodes": [
            {"id": "0:1", "type": "PAGE", "name": "Page"},
            {"id": "11:2", "type": "FRAME", "name": "Root", "parentId": "0:1"},
            {"id": "I11:2;33:4", "type": "INSTANCE", "name": "Exact", "parentId": "11:2"},
        ]}, nodeId="I11:2;33:4")
        result = out["result"]
        self.assertEqual("I11:2;33:4", result["sourceId"])
        self.assertEqual(["11:2", "0:1"], [n["id"] for n in result["observations"]["ancestors"]])
        self.assertEqual(["I11:2;33:4"], out["accesses"])
        self.assertFalse(result["partial"])

    def test_empty_selection_returns_empty_without_scanning(self):
        out = self.run_recipe("identity-ancestry", {"nodes": []})
        self.assertEqual([], out["result"]["observations"]["selection"])
        self.assertEqual(["selection"], out["accesses"])
        self.assertFalse(out["result"]["partial"])

    def test_ancestry_is_bounded(self):
        fixture = {"nodes": [{"id": str(i), "parentId": str(i + 1)} for i in range(8)]}
        result = self.run_recipe("identity-ancestry", fixture, nodeId="0", maxAncestors=2)["result"]
        self.assertEqual(["1", "2"], [n["id"] for n in result["observations"]["ancestors"]])
        self.assertTrue(result["partial"])
        self.assertTrue(result["frontier"])

    def tree(self):
        return {"nodes": [
            {"id": "r", "childrenIds": ["a", "b"]},
            {"id": "a", "childrenIds": ["aa"]},
            {"id": "aa", "childrenIds": []}, {"id": "b", "childrenIds": []},
            {"id": "outside", "name": "must not leak"},
        ]}

    def test_explicit_root_does_not_expand_to_siblings(self):
        out = self.run_recipe("bounded-subtree", self.tree(), rootId="a")
        self.assertEqual(["a", "aa"], out["result"]["scope"]["nodeIds"])
        self.assertEqual(["a"], out["accesses"])
        self.assertFalse(out["result"]["partial"])

    def test_node_and_depth_caps_leave_frontier(self):
        for bounds, expected, reason in [({"maxNodes": 2}, ["r", "a"], "node_limit"),
                                         ({"maxDepth": 0}, ["r"], "depth_limit")]:
            with self.subTest(bounds=bounds):
                result = self.run_recipe("bounded-subtree", self.tree(), rootId="r", **bounds)["result"]
                self.assertEqual(expected, result["scope"]["nodeIds"])
                self.assertTrue(result["partial"])
                self.assertIn(reason, result["frontier"][0]["reasons"])

    def test_missing_fields_differ_from_empty_false_and_zero(self):
        fixture = {"nodes": [{"id": "r", "childrenIds": [], "reactions": [],
                               "annotations": [], "visible": False, "opacity": 0, "characters": ""}]}
        result = self.run_recipe("bounded-subtree", fixture, rootId="r")["result"]
        fields = result["observations"][0]["fields"]
        for name, value in [("reactions", []), ("annotations", []), ("visible", False),
                            ("opacity", 0), ("characters", "")]:
            self.assertEqual({"state": "read", "value": value}, fields[name])
        self.assertEqual({"state": "missing"}, fields["boundVariables"])

    def test_throwing_annotations_preserves_other_fields_and_bounded_child(self):
        fixture = {"nodes": [
            {"id": "r", "childrenIds": ["a"], "throwFields": ["annotations"],
             "visible": False, "opacity": 0},
            {"id": "a", "childrenIds": []},
        ]}
        result = self.run_recipe("bounded-subtree", fixture, rootId="r", maxNodes=2,
                                 maxDepth=1, maxBytes=32768)["result"]
        fields = result["observations"][0]["fields"]
        self.assertEqual({"state": "unavailable"}, fields["annotations"])
        self.assertEqual({"state": "read", "value": False}, fields["visible"])
        self.assertEqual({"state": "read", "value": 0}, fields["opacity"])
        self.assertEqual(["r", "a"], result["scope"]["nodeIds"])
        self.assertTrue(result["partial"])
        self.assertTrue(any("field_unavailable" in item["reasons"]
                            for item in result["frontier"]))

    def test_raw_actions_preserve_nested_unknown_and_legacy(self):
        reactions = [{"trigger": {"type": "ON_CLICK"}, "actions": [
            {"type": "CONDITIONAL", "conditionalBlocks": [{"condition": {"value": False},
             "actions": [{"type": "FUTURE_ACTION", "delay": 0, "extra": {"v": ""}}]}]},
            {"type": "NODE", "destinationId": "I9:8;7:6", "transition": {"duration": 0}},
        ]}, {"action": {"type": "BACK", "unknown": False}}]
        fixture = {"nodes": [{"id": "r", "childrenIds": [], "reactions": reactions}]}
        result = self.run_recipe("bounded-subtree", fixture, rootId="r")["result"]
        self.assertEqual(reactions, result["observations"][0]["fields"]["reactions"]["value"])

    def test_byte_cap_keeps_complete_actions_or_omits_whole_record(self):
        huge = [{"actions": [{"type": "UNKNOWN", "value": "ж" * 5000}]}]
        fixture = {"nodes": [{"id": "r", "childrenIds": ["a"]},
                              {"id": "a", "childrenIds": [], "reactions": huge}]}
        result = self.run_recipe("bounded-subtree", fixture, rootId="r", maxBytes=5000)["result"]
        self.assertLessEqual(len(json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode()), 5000)
        self.assertEqual(["r"], result["scope"]["nodeIds"])
        self.assertIn("byte_limit", result["frontier"][0]["reasons"])
        self.assertTrue(result["partial"])

    def test_lazy_children_remain_partial_without_loading_pages(self):
        result = self.run_recipe("bounded-subtree", {"nodes": [{"id": "r", "lazy": True}]}, rootId="r")["result"]
        self.assertTrue(result["partial"])
        self.assertIn("children_unavailable", result["frontier"][0]["reasons"])

    def test_missing_node_is_explicit(self):
        for marker, kwargs in [("identity-ancestry", {"nodeId": "absent"}),
                               ("bounded-subtree", {"rootId": "absent"})]:
            with self.subTest(recipe=marker):
                out = self.run_recipe(marker, {"nodes": []}, **kwargs)
                self.assertIn("node_not_found", out["error"])

    def test_expanded_root_preserves_source_and_rejects_unrelated_root(self):
        fixture = {"nodes": [{"id": "r", "childrenIds": ["s"]},
                              {"id": "s", "parentId": "r", "childrenIds": []},
                              {"id": "other", "childrenIds": []}]}
        out = self.run_recipe("bounded-subtree", fixture, rootId="r", sourceId="s")
        self.assertEqual("s", out["result"]["sourceId"])
        self.assertEqual("r", out["result"]["rootId"])
        self.assertEqual(["r", "s"], out["result"]["scope"]["nodeIds"])
        rejected = self.run_recipe("bounded-subtree", fixture, rootId="other", sourceId="s")
        self.assertIn("scope_unverified", rejected["error"])

    def test_selection_node_and_utf8_byte_caps_are_explicit(self):
        fixture = {"nodes": [{"id": "a"}, {"id": "b", "name": "🎨" * 500}],
                   "selection": ["a", "b"]}
        for bounds, reason in [({"maxNodes": 1}, "node_limit"),
                               ({"maxBytes": 800}, "byte_limit")]:
            with self.subTest(bounds=bounds):
                result = self.run_recipe("identity-ancestry", fixture, **bounds)["result"]
                self.assertEqual(["a"], result["scope"]["nodeIds"])
                self.assertEqual(reason, result["frontier"][0]["reason"])
                self.assertTrue(result["partial"])
                self.assertLessEqual(len(json.dumps(result, ensure_ascii=False,
                                                     separators=(",", ":")).encode()),
                                     bounds.get("maxBytes", 32768))

    def test_explicit_root_and_sufficient_receipt_budget_are_required(self):
        out = self.run_recipe("bounded-subtree", self.tree())
        self.assertIn("explicit_root_required", out["error"])
        for marker, kwargs in [("bounded-subtree", {"rootId": "r"}),
                               ("identity-ancestry", {})]:
            with self.subTest(recipe=marker):
                out = self.run_recipe(marker, self.tree(), maxBytes=1, **kwargs)
                self.assertIn("byte_budget_too_small", out["error"])


if __name__ == "__main__":
    unittest.main()
