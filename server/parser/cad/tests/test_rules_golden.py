"""The circuit rules of the DWG bones (dwg_bones.py) against the golden cases
circuit_trace is held to as well (packages/files/src/dwg-circuit-rules.golden.json;
the TypeScript half is packages/tools/src/circuit-trace/rules-golden.test.ts).
The two sides used to copy the rules by hand; this file and its TypeScript
twin are what keeps them one rule.

Run (stdlib unittest, no ezdxf needed):
    python3 -m unittest discover -s server/parser/cad/tests -v

The golden file lives in the repo, outside the CAD folder: in a copy of the
CAD folder alone it is not there and the cases skip.
"""

from __future__ import annotations

import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import dwg_bones  # noqa: E402

GOLDEN = os.path.normpath(
    os.path.join(
        HERE, "..", "..", "..", "..", "packages", "files", "src", "dwg-circuit-rules.golden.json"
    )
)


def _load():
    if not os.path.exists(GOLDEN):
        return None
    with open(GOLDEN, encoding="utf-8") as f:
        return json.load(f)


G = _load()


@unittest.skipIf(G is None, "the golden file is not beside this checkout")
class RulesGolden(unittest.TestCase):
    def test_near_ratio_and_extent_trim(self):
        self.assertEqual(dwg_bones.NEAR_REL, G["nearRel"])
        self.assertEqual(dwg_bones.EXTENT_TRIM, G["extentTrim"])

    def test_layers(self):
        for case in G["layers"]:
            with self.subTest(layer=case["layer"]):
                parsed = dwg_bones.parse_circuit_layer(case["layer"])
                if case["circuit"] is None:
                    self.assertIsNone(parsed)
                    continue
                self.assertIsNotNone(parsed)
                circuit, role, _sub, parent = parsed
                kind = "injection point" if parent else "circuit"
                self.assertEqual(
                    {"circuit": circuit, "role": role, "kind": kind, "parent": parent},
                    {
                        "circuit": case["circuit"],
                        "role": case["role"],
                        "kind": case["kind"],
                        "parent": case["parent"],
                    },
                )

    def test_tags(self):
        for tag in G["lineTags"]["match"]:
            self.assertTrue(dwg_bones._LINE_TAG.match(tag), tag)
        for tag in G["lineTags"]["noMatch"]:
            self.assertFalse(dwg_bones._LINE_TAG.match(tag), tag)
        for tag in G["circuitTags"]["match"]:
            self.assertTrue(dwg_bones._CIRCUIT_TAG.match(tag), tag)
        for tag in G["circuitTags"]["noMatch"]:
            self.assertFalse(dwg_bones._CIRCUIT_TAG.match(tag), tag)

    def test_extent(self):
        for case in G["extent"]:
            with self.subTest(case=case["about"]):
                if "segments" in case:
                    rows = [list(s) for s in case["segments"]]
                else:
                    g = case["segmentsGenerated"]
                    rows = [[i * g["dx"], 0, i * g["dx"], g["length"]] for i in range(g["count"])]
                if "stray" in case:
                    rows.append(list(case["stray"]))
                segs = [{"x1": a, "y1": b, "x2": c, "y2": d} for a, b, c, d in rows]
                self.assertAlmostEqual(dwg_bones.extent_diagonal(segs), case["diag"], places=9)


if __name__ == "__main__":
    unittest.main()
