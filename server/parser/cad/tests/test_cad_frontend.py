"""Tests for cad_frontend.py: the one ezdxf frontend of model.png, the crops
and the symbol SVGs. A pattern too fine for its area is drawn as its outline
and counted; a pattern too dense for ezdxf is filled where the hatch is, also
when the hatch is upside down (extrusion 0, 0, -1).

Run (stdlib unittest; the cases skip when ezdxf or matplotlib is missing,
unless PARSER_TESTS_REQUIRE_CAD is set):

    python -m unittest discover -s server/parser/cad/tests

Every drawing here is made up in the test.
"""

from __future__ import annotations

import json
import os
import resource
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(os.path.dirname(HERE), "cad.py")
sys.path.insert(0, os.path.dirname(HERE))

try:
    import ezdxf
    import matplotlib  # noqa: F401
    from ezdxf.addons.drawing import RenderContext
    from ezdxf.addons.drawing.recorder import Recorder

    import cad_frontend

    HAVE_RENDER = True
except Exception:  # pragma: no cover - the venv case
    HAVE_RENDER = False
    if os.environ.get("PARSER_TESTS_REQUIRE_CAD"):
        raise

# A boundary 40 km wide, under ANSI31 at a thousandth of its size: about 1e7
# lines. Drawn in full, ezdxf would hold them all in memory first.
HUGE = 40_000_000.0


def hatch(space, x0, x1, *, fill="ANSI31", scale=1.0, flip=False, spacing=None, dashes=()):
    """A pattern hatch over (x0, 0)-(x1, 10) in world coordinates; `flip`
    makes it upside down (extrusion 0, 0, -1) at the same world place."""
    attribs = {"elevation": (0, 0, 5.0)}
    if flip:
        attribs["extrusion"] = (0, 0, -1)
        x0, x1 = -x1, -x0  # its own x runs the other way
    h = space.add_hatch(color=1, dxfattribs=attribs)
    if spacing is not None:
        lines = [[0.0, (0.0, 0.0), (0.0, spacing), list(dashes)]]
        h.set_pattern_fill("_USER", style=0, pattern_type=0, definition=lines)
        h.set_pattern_definition(lines, factor=1.0, angle=0.0)
    else:
        h.set_pattern_fill(fill, scale=scale, style=0)
    h.paths.add_polyline_path([(x0, 0), (x1, 0), (x1, 10), (x0, 10)], is_closed=True)
    return h


def drawn(doc):
    """(outlined, (xmin, ymin, xmax, ymax)) of the model space as drawn."""
    rec = Recorder()
    front = cad_frontend.Frontend(RenderContext(doc), rec)
    front.draw_layout(doc.modelspace(), finalize=True)
    box = rec.player().bbox()
    return front.outlined, tuple(round(v, 6) for v in (box.extmin.x, box.extmin.y, box.extmax.x, box.extmax.y))


def huge_drawing(path):
    doc = ezdxf.new("R2010")
    msp = doc.modelspace()
    msp.add_lwpolyline([(0, 0), (800, 0), (800, 550), (0, 550)], close=True)
    msp.add_text("V-101", dxfattribs={"insert": (100, 100), "height": 5})
    hatch(msp, 0, HUGE, scale=0.001)
    doc.saveas(path)


@unittest.skipUnless(HAVE_RENDER, "ezdxf or matplotlib not installed")
class EstimateTests(unittest.TestCase):
    def test_lines_across_the_box_times_dashes_along_it(self):
        doc = ezdxf.new("R2010")
        plain = hatch(doc.modelspace(), 0, 10, spacing=1.0)
        dashed = hatch(doc.modelspace(), 0, 10, spacing=1.0, dashes=(0.5, -0.5))
        from ezdxf.render import hatching  # noqa: PLC0415

        diag = 200**0.5
        got = cad_frontend.dashes(plain, hatching.hatch_boundary_paths(plain), 1e-4)
        self.assertAlmostEqual(got, diag + 1.0)
        got = cad_frontend.dashes(dashed, hatching.hatch_boundary_paths(dashed), 1e-4)
        self.assertAlmostEqual(got, (diag + 1.0) * (diag * 2 + 2))

    def test_a_line_too_dense_for_ezdxf_is_not_counted(self):
        doc = ezdxf.new("R2010")
        h = hatch(doc.modelspace(), 0, 10, spacing=1e-5)
        from ezdxf.render import hatching  # noqa: PLC0415

        self.assertEqual(cad_frontend.dashes(h, hatching.hatch_boundary_paths(h), 1e-4), 0.0)


@unittest.skipUnless(HAVE_RENDER, "ezdxf or matplotlib not installed")
class DrawTests(unittest.TestCase):
    def test_a_usual_pattern_is_drawn_as_ezdxf_draws_it(self):
        doc = ezdxf.new("R2010")
        hatch(doc.modelspace(), 90, 100, scale=0.5)
        from ezdxf.addons.drawing import Frontend  # noqa: PLC0415

        rec = Recorder()
        Frontend(RenderContext(doc), rec).draw_layout(doc.modelspace(), finalize=True)
        ours = Recorder()
        cad_frontend.Frontend(RenderContext(doc), ours).draw_layout(doc.modelspace(), finalize=True)
        self.assertEqual(len(list(ours.records)), len(list(rec.records)))
        self.assertEqual(drawn(doc), (0, (90.0, 0.0, 100.0, 10.0)))

    def test_a_pattern_too_fine_for_its_area_is_its_outline_and_counted(self):
        doc = ezdxf.new("R2010")
        hatch(doc.modelspace(), 0, HUGE, scale=0.001)
        started = time.time()
        self.assertEqual(drawn(doc), (1, (0.0, 0.0, HUGE, 10.0)))
        self.assertLess(time.time() - started, 10)

    def test_an_upside_down_hatch_draws_where_its_twin_does(self):
        # Pattern, outline, and a pattern denser than ezdxf draws: ezdxf
        # 1.4.5 fills that last one in the hatch's own plane, mirrored in x.
        for kw in ({"scale": 0.5}, {"spacing": 0.5, "dashes": (0.5, -0.25)}, {"spacing": 5e-5},
                   {"scale": 1e-9}):
            for x0, x1 in ((90, 100), (0, HUGE)):
                if x1 == HUGE and "spacing" in kw:
                    continue
                up = ezdxf.new("R2010")
                hatch(up.modelspace(), x0, x1, **kw)
                down = ezdxf.new("R2010")
                hatch(down.modelspace(), x0, x1, flip=True, **kw)
                a, b = drawn(up), drawn(down)
                self.assertEqual(a[0], b[0], kw)
                for u, d in zip(a[1], b[1]):
                    # A dashed line starts its dashes from the other side.
                    self.assertAlmostEqual(u, d, delta=0.3, msg=f"{kw} {a} {b}")
                self.assertAlmostEqual(b[1][0], x0, delta=0.3, msg=f"{kw} {b}")
                self.assertAlmostEqual(b[1][2], x1, delta=0.3, msg=f"{kw} {b}")


@unittest.skipUnless(HAVE_RENDER, "ezdxf or matplotlib not installed")
class ChildTests(unittest.TestCase):
    """The children that draw: model.png, the crops, the symbol SVGs."""

    def test_the_picture_of_a_huge_fine_hatch_is_quick_small_and_partial(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "huge.dxf")
            huge_drawing(src)
            out = os.path.join(tmp, "out")
            os.makedirs(out)
            started = time.time()
            proc = subprocess.run([sys.executable, APP, "--dwg-render", src, out, "50"],
                                  capture_output=True, text=True, timeout=120)
            took = time.time() - started
            self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
            with open(os.path.join(out, "index.json")) as f:
                index = json.load(f)
            self.assertEqual(index["hatches_outlined"], 1)
            self.assertIsNone(index["render_error"])
            self.assertTrue(os.path.exists(os.path.join(out, "model.png")))
            self.assertLess(took, 60)
            # The largest child this test process has waited for, in KB on Linux.
            peak = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
            if sys.platform.startswith("linux"):
                self.assertLess(peak, 1_500_000, f"peak {peak} KB")

    def test_a_dwg_says_it_in_its_partial_list(self):
        import cad  # noqa: PLC0415

        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "huge.dxf")
            huge_drawing(src)
            doc = ezdxf.readfile(src)
            notes = {"version": "AC1032", "partial": [{"reason": "a style not carried", "count": 2}]}
            out = os.path.join(tmp, "out")
            os.makedirs(out)
            with mock.patch.object(cad, "open_cad", return_value=(doc, "ezdwg", notes)), \
                    mock.patch.object(cad, "symbols_of", return_value={}):
                self.assertEqual(cad.dwg_render_worker(src, out, 50), 0)
            with open(os.path.join(out, "index.json")) as f:
                index = json.load(f)
            self.assertEqual(index["hatches_outlined"], 1)
            self.assertEqual(index["dwg"]["partial"], [
                {"reason": "a style not carried", "count": 2},
                {"reason": cad_frontend.OUTLINED, "count": 1},
            ])

    def test_the_crops_count_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "huge.dxf")
            huge_drawing(src)
            spec = os.path.join(tmp, "spec.json")
            with open(spec, "w") as f:
                json.dump({"items": [{"id": "a", "kind": "point", "at": [100, 100], "pad": 20,
                                      "marks": [[100, 100]]}]}, f)
            out = os.path.join(tmp, "out")
            os.makedirs(out)
            proc = subprocess.run([sys.executable, APP, "--dwg-crop", src, out, spec],
                                  capture_output=True, text=True, timeout=120)
            self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
            with open(os.path.join(out, "index.json")) as f:
                index = json.load(f)
            self.assertEqual(index["hatches_outlined"], 1)
            self.assertEqual([c["id"] for c in index["crops"]], ["a"])

    def test_the_symbols_count_it(self):
        import dwg_bones  # noqa: PLC0415
        import dwg_symbols  # noqa: PLC0415

        doc = ezdxf.new("R2010")
        block = doc.blocks.new("BIG")
        hatch(block, 0, HUGE, scale=0.001)
        doc.blocks.new("SMALL").add_circle((0, 0), 1)
        doc.modelspace().add_blockref("BIG", (0, 0))
        doc.modelspace().add_blockref("SMALL", (0, 0))
        out = dwg_symbols.symbols_index(doc, dwg_bones.coord)
        facts = out["symbol_facts"]
        self.assertEqual((facts["hatches_outlined"], facts["drawn"], facts["draw_errors"]), (1, 2, 0))


if __name__ == "__main__":
    unittest.main()
