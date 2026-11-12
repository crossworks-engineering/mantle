"""Tests for dwg_symbols.py: each block an INSERT in model space uses, keyed
by shape and drawn once as SVG, and each INSERT as a placement of its key.

Run (stdlib unittest; the cases skip when ezdxf is missing, unless
PARSER_TESTS_REQUIRE_CAD is set; the sample case needs our ezdwg build and
skips by name with the official one, as in CI):

    python -m unittest discover -s server/parser/cad/tests

Most cases draw a made-up document in memory. The "rebuild" here is the
check a rebuild tool would pass: every placement points at a symbol, and
the symbol's box, placed by the placement, lands where ezdxf puts the
original INSERT.
"""

from __future__ import annotations

import math
import os
import re
import sys
import tempfile
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

try:
    import ezdxf
    from ezdxf import bbox

    HAVE_EZDXF = True
except Exception:  # pragma: no cover - the venv case
    HAVE_EZDXF = False
    if os.environ.get("PARSER_TESTS_REQUIRE_CAD"):
        raise

import dwg_bones  # noqa: E402
import dwg_symbols  # noqa: E402

SAMPLE = os.path.join(HERE, "data", "sample_AC1032.dwg")


def valve(block, turn: bool = False) -> None:
    """A bowtie valve, 4 by 2, or the same turned a quarter."""
    pts = [(-2, -1), (2, 1), (2, -1), (-2, 1), (-2, -1)]
    if turn:
        pts = [(-y, x) for x, y in pts]
    block.add_lwpolyline(pts)


def made_up():
    """A document with every case a drawing's symbols meet."""
    doc = ezdxf.new("R2010")
    valve(doc.blocks.new("VALVE"))
    valve(doc.blocks.new("VALVE_COPY"))  # same shape, other name: one key
    valve(doc.blocks.new("VALVE_TURNED"), turn=True)  # other key, same shape
    tag = doc.blocks.new("TAG")  # text alone: a label, not drawn
    tag.add_attdef("LINENO", (0, 0), dxfattribs={"height": 1})
    tag.add_text("NOTE", dxfattribs={"height": 1})
    nest = doc.blocks.new("NEST")
    nest.add_blockref("VALVE", (5, 0))
    nest.add_circle((0, 0), 1)
    doc.layers.add("HIDDEN").off()
    doc.blocks.new("OFF").add_line((0, 0), (1, 1), dxfattribs={"layer": "HIDDEN"})
    doc.blocks.new("EMPTY")
    msp = doc.modelspace()
    msp.add_blockref("VALVE", (10, 20), dxfattribs={"rotation": 90, "xscale": 2, "yscale": 2})
    msp.add_blockref("VALVE_COPY", (30, 0), dxfattribs={"xscale": -1})
    msp.add_blockref("VALVE_TURNED", (50, 0))
    msp.add_blockref("TAG", (0, 40)).add_attrib("LINENO", "4-P-101", (0, 40))
    msp.add_blockref("NEST", (70, 0), dxfattribs={"rotation": 180})
    arr = msp.add_blockref("VALVE", (0, 100))
    arr.grid(size=(2, 3), spacing=(10, 20))  # 6 copies
    msp.add_blockref("VALVE", (90, 0), dxfattribs={"extrusion": (0, 0, -1)})
    msp.add_blockref("OFF", (0, 60))
    msp.add_blockref("EMPTY", (0, 80))
    return doc


def placed_box(sym: dict, p: dict) -> tuple:
    """The symbol's box as the placement puts it in model space."""
    a = math.radians(p["rotation"])
    out = []
    for bx in (sym["x0"], sym["x0"] + sym["width"]):
        for by in (sym["y0"], sym["y0"] + sym["height"]):
            sx, sy = bx * p["xscale"], by * p["yscale"]
            out.append((p["x"] + sx * math.cos(a) - sy * math.sin(a), p["y"] + sx * math.sin(a) + sy * math.cos(a)))
    xs = [q[0] for q in out]
    ys = [q[1] for q in out]
    return min(xs), min(ys), max(xs), max(ys)


@unittest.skipUnless(HAVE_EZDXF, "ezdxf not installed")
class MadeUpDocument(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.doc = made_up()
        cls.out = dwg_symbols.symbols_index(cls.doc, dwg_bones.coord)
        cls.by_name = {s["name"]: s for s in cls.out["symbols"]}

    def test_one_row_per_exact_shape_and_one_placement_per_insert(self):
        facts = self.out["symbol_facts"]
        # 14 INSERTs: the grid is 6; the empty block has no key.
        self.assertEqual(facts["inserts"], 14)
        self.assertEqual(facts["unkeyed"], 1)
        self.assertEqual(len(self.out["placements"]), 13)
        # VALVE and VALVE_COPY are one key: 5 symbols, not 6.
        self.assertEqual(facts["symbols"], 5)
        self.assertEqual(len(self.out["symbols"]), 5)
        keys = [s["key"] for s in self.out["symbols"]]
        self.assertEqual(len(set(keys)), 5)
        self.assertFalse(self.out["symbols_capped"])
        self.assertFalse(self.out["placements_capped"])

    def test_the_name_is_a_label_and_the_key_comes_from_geometry(self):
        keys = dwg_symbols.Keys(self.doc)
        self.assertEqual(keys.exact("VALVE"), keys.exact("VALVE_COPY"))
        self.assertNotEqual(keys.exact("VALVE"), keys.exact("VALVE_TURNED"))
        self.assertEqual(keys.shape("VALVE"), keys.shape("VALVE_TURNED"))
        self.assertNotEqual(keys.shape("VALVE"), keys.shape("NEST"))
        # The most used is first: VALVE and its copy hold 9 of the INSERTs.
        first = self.out["symbols"][0]
        self.assertIn(first["name"], ("VALVE", "VALVE_COPY"))
        self.assertEqual(first["placements"], 9)

    def test_the_key_does_not_hang_on_entity_order_or_handles(self):
        doc = ezdxf.new("R2010")
        a = doc.blocks.new("A")
        a.add_line((0, 0), (1, 0))
        a.add_circle((0, 0), 2)
        b = doc.blocks.new("B")
        b.add_circle((0, 0), 2)
        b.add_line((0, 0), (1, 0))
        c = doc.blocks.new("C", base_point=(1, 0))  # the base point counts
        c.add_circle((0, 0), 2)
        c.add_line((0, 0), (1, 0))
        keys = dwg_symbols.Keys(doc)
        self.assertEqual(keys.exact("A"), keys.exact("B"))
        self.assertNotEqual(keys.exact("A"), keys.exact("C"))

    def test_a_tag_only_block_is_a_label_with_no_svg(self):
        tag = self.by_name["TAG"]
        self.assertEqual(tag["kind"], "label")
        self.assertIsNone(tag["svg"])
        self.assertEqual(tag["tags"], ["LINENO"])
        self.assertEqual(self.out["symbol_facts"]["labels"], 1)
        placed = [p for p in self.out["placements"] if p["key"] == tag["key"]]
        self.assertEqual(placed[0]["tags"], {"LINENO": "4-P-101"})

    def test_a_block_that_draws_nothing_is_counted_and_keeps_its_row(self):
        off = self.by_name["OFF"]
        self.assertEqual(off["kind"], "symbol")
        self.assertIsNone(off["svg"])
        self.assertEqual(self.out["symbol_facts"]["draw_errors"], 1)
        self.assertEqual(self.out["symbol_facts"]["drawn"], 3)

    def test_the_svg_viewbox_is_the_box(self):
        nest = self.by_name["NEST"]
        self.assertTrue(nest["svg"].lstrip().startswith("<?xml"))
        self.assertIn("<svg", nest["svg"])
        # A circle of radius 1 at 0,0 and a 4 by 2 valve at 5,0.
        self.assertAlmostEqual(nest["x0"], -1.0, places=3)
        self.assertAlmostEqual(nest["y0"], -1.0, places=3)
        self.assertAlmostEqual(nest["width"], 8.0, places=3)
        self.assertAlmostEqual(nest["height"], 2.0, places=3)
        w, h = (float(v) for v in re.search(r'viewBox="0 0 (\d+) (\d+)"', nest["svg"]).groups())
        self.assertAlmostEqual(w / h, 4.0, places=3)
        # A clear ground: a rebuild lays the SVG over its own page.
        self.assertIn('fill-opacity="0.0"', nest["svg"])

    def test_a_rebuild_from_placements_and_svgs_puts_every_insert_back(self):
        """Every placement has its symbol; each drawn symbol's box, placed
        by its placement, is ezdxf's box of the original INSERT. The count
        of placed symbols is the count of keyed INSERTs."""
        syms = {s["key"]: s for s in self.out["symbols"]}
        # An array's copies go under the array's handle, in its order.
        by_handle = {}
        for e in self.doc.modelspace():
            if e.dxftype() == "INSERT":
                by_handle[e.dxf.handle] = list(e.multi_insert()) if e.mcount > 1 else [e]
        originals = [one for copies in by_handle.values() for one in copies]
        placed = 0
        for p in self.out["placements"]:
            sym = syms[p["key"]]
            placed += 1
            if sym["svg"] is None:
                continue
            want = bbox.extents([by_handle[p["handle"]].pop(0)])
            got = placed_box(sym, p)
            for a, b in zip(got, (want.extmin.x, want.extmin.y, want.extmax.x, want.extmax.y)):
                self.assertAlmostEqual(a, b, delta=0.05, msg=(sym["name"], p))
        self.assertEqual(placed, len(originals) - 1)  # the empty block

    def test_a_mirror_seen_from_below_is_read_into_the_scales(self):
        below = [p for p in self.out["placements"] if p["x"] == -90.0]
        self.assertEqual(len(below), 1)
        p = below[0]
        self.assertLess(p["xscale"] * p["yscale"], 0)

    def test_the_caps_say_what_they_cut(self):
        with mock.patch.multiple(dwg_symbols, MAX_SYMBOLS=2, MAX_PLACEMENTS=3):
            out = dwg_symbols.symbols_index(self.doc, dwg_bones.coord)
        self.assertEqual(len(out["symbols"]), 2)
        self.assertEqual(len(out["placements"]), 3)
        self.assertTrue(out["symbols_capped"])
        self.assertTrue(out["placements_capped"])
        self.assertEqual(out["symbol_facts"]["symbols"], 5)

        with mock.patch.object(dwg_symbols, "MAX_SVG_BYTES", 10):
            out = dwg_symbols.symbols_index(self.doc, dwg_bones.coord)
        self.assertEqual(out["symbol_facts"]["drawn"], 0)
        self.assertEqual(out["symbol_facts"]["not_drawn"]["too_large"], 3)
        self.assertTrue(all(s["svg"] is None for s in out["symbols"]))

        first = len(self.out["symbols"][0]["svg"].encode())
        with mock.patch.object(dwg_symbols, "MAX_SVG_TOTAL", first):
            out = dwg_symbols.symbols_index(self.doc, dwg_bones.coord)
        self.assertEqual(out["symbol_facts"]["drawn"], 1)
        # The rest are not tried: OFF, which fails to draw, counts here too.
        self.assertEqual(out["symbol_facts"]["not_drawn"]["total_cap"], 3)
        self.assertLessEqual(out["symbol_facts"]["svg_bytes"], first)

        out = dwg_symbols.symbols_index(self.doc, dwg_bones.coord, deadline=time.time() - 1)
        self.assertEqual(out["symbol_facts"]["drawn"], 0)
        self.assertEqual(out["symbol_facts"]["not_drawn"]["time"], 4)
        self.assertEqual(len(out["symbols"]), 5)  # rows stay, with no SVG

    def test_the_temporary_layouts_are_gone(self):
        self.assertFalse(any(n.startswith(dwg_symbols.LAYOUT_PREFIX) for n in self.doc.layouts.names()))

    def test_a_block_that_holds_itself_does_not_loop(self):
        doc = ezdxf.new("R2010")
        loop = doc.blocks.new("LOOP")
        loop.add_line((0, 0), (1, 0))
        loop.add_blockref("LOOP", (2, 0))
        keys = dwg_symbols.Keys(doc)
        self.assertIsNotNone(keys.exact("LOOP"))
        self.assertIsNotNone(keys.shape("LOOP"))


@unittest.skipUnless(HAVE_EZDXF, "ezdxf not installed")
class InTheRenderWorker(unittest.TestCase):
    def test_a_failed_pass_ships_empty_lists_and_its_reason(self):
        import cad

        with mock.patch.object(dwg_symbols, "symbols_index", side_effect=RuntimeError("boom at /tmp/x")):
            out = cad.symbols_of(made_up())
        self.assertEqual(out["symbols"], [])
        self.assertEqual(out["placements"], [])
        self.assertEqual(out["symbols_error"], "RuntimeError: boom at <file>")

    def test_a_dxf_render_carries_symbols_and_placements(self):
        try:
            import matplotlib  # noqa: F401
        except Exception:
            self.skipTest("matplotlib not installed")
        import json

        import cad

        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "made-up.dxf")
            made_up().saveas(src)
            self.assertEqual(cad.dwg_render_worker(src, tmp, 50), 0)
            with open(os.path.join(tmp, "index.json"), encoding="utf-8") as f:
                index = json.load(f)
        self.assertIsNone(index["symbols_error"])
        self.assertEqual(len(index["symbols"]), 5)
        self.assertEqual(len(index["placements"]), 13)
        self.assertEqual(index["symbol_facts"]["drawn"], 3)


def _our_ezdwg() -> bool:
    try:
        import dwg_read
        import ezdwg

        return dwg_read.reads_dwg(ezdwg)
    except Exception:
        return False


@unittest.skipUnless(HAVE_EZDXF and _our_ezdwg(), "needs our ezdwg build (the bench, the parser image)")
class TheSample(unittest.TestCase):
    def test_the_public_sample_gives_its_symbols_and_placements(self):
        import cad

        with tempfile.TemporaryDirectory() as tmp:
            doc, converter, _ = cad.open_cad(SAMPLE, tmp)
        self.assertEqual(converter, "ezdwg")
        out = cad.symbols_of(doc)
        self.assertIsNone(out["symbols_error"])
        inserts = [e for e in doc.modelspace() if e.dxftype() == "INSERT"]
        self.assertEqual(len(out["placements"]), len(inserts))
        keys = {s["key"] for s in out["symbols"]}
        self.assertTrue(all(p["key"] in keys for p in out["placements"]))
        self.assertEqual(sum(s["placements"] for s in out["symbols"]), len(inserts))
        drawn = [s for s in out["symbols"] if s["svg"]]
        self.assertEqual(len(drawn), out["symbol_facts"]["drawn"])
        self.assertGreater(len(drawn), 0)
        my = next(s for s in out["symbols"] if s["name"] == "MyBlock")
        self.assertEqual(my["tags"], ["ATTINFO"])
        self.assertEqual((my["x0"], my["y0"], my["width"], my["height"]), (-40.0, -40.0, 80.0, 80.0))


if __name__ == "__main__":
    unittest.main()
