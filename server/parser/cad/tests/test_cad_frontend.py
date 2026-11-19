"""Tests for cad_frontend.py: the one ezdxf frontend of model.png, the crops
and the symbol SVGs. A pattern too fine for its area, or past the picture's
dash budget, is drawn as its outline and counted; a pattern too dense for
ezdxf is filled where the hatch is, also when the hatch is upside down
(extrusion 0, 0, -1).

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


def comb(space, teeth, depth, *, spacing, dashes=()):
    """A hatch of horizontal pattern lines over a comb: `teeth` teeth 1 wide
    and `depth` - 1 deep, 1 apart, on a back 1 high. Every line through the
    teeth is cut once per tooth."""
    pts = [(0, 0)]
    for i in range(teeth):
        x = 2 * i
        pts += [(x, depth), (x + 1, depth), (x + 1, 1), (x + 2, 1)]
    pts += [(2 * teeth, 0)]
    h = space.add_hatch(color=1)
    lines = [[0.0, (0.0, 0.0), (0.0, spacing), list(dashes)]]
    h.set_pattern_fill("_USER", style=0, pattern_type=0, definition=lines)
    h.set_pattern_definition(lines, factor=1.0, angle=0.0)
    h.paths.add_polyline_path(pts, is_closed=True)
    return h


def made(polygon, loops):
    """The dashes ezdxf makes for `polygon`'s pattern, counted as its
    draw_hatch_pattern makes them."""
    from ezdxf.render import hatching  # noqa: PLC0415

    n = 0
    for baseline in hatching.pattern_baselines(polygon, jiggle_origin=True):
        for line in hatching.hatch_paths(baseline, loops):
            n += sum(1 for _ in baseline.pattern_renderer(line.distance).render(line.start, line.end))
    return n


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
    def test_lines_across_the_box_times_dashes_along_it_plus_the_cuts(self):
        doc = ezdxf.new("R2010")
        plain = hatch(doc.modelspace(), 0, 10, spacing=1.0)
        dashed = hatch(doc.modelspace(), 0, 10, spacing=1.0, dashes=(0.5, -0.5))
        from ezdxf.render import hatching  # noqa: PLC0415

        diag = 200**0.5
        loops = hatching.hatch_boundary_paths(plain)
        edges = sum(len(p) for p in loops)
        got = cad_frontend.dashes(plain, loops, 1e-4)
        self.assertAlmostEqual(got, (diag + 1.0) + (40 + edges))
        # (0.5, -0.5): one dash and one gap a unit; the gap is not a dash.
        got = cad_frontend.dashes(dashed, hatching.hatch_boundary_paths(dashed), 1e-4)
        self.assertAlmostEqual(got, (diag + 1.0) * (diag + 1) + (40 + edges))
        # A dot (0) is drawn, so it counts as a dash: (0.5, 0, -0.5) is two a unit.
        dotted = hatch(doc.modelspace(), 0, 10, spacing=1.0, dashes=(0.5, 0.0, -0.5))
        got = cad_frontend.dashes(dotted, hatching.hatch_boundary_paths(dotted), 1e-4)
        self.assertAlmostEqual(got, (diag + 1.0) * (diag * 2 + 2) + (40 + edges) * 2)

    def test_the_estimate_is_never_under_what_ezdxf_makes(self):
        from ezdxf.render import hatching  # noqa: PLC0415

        for dashes in ((), (0.5, -0.5), (0.5, 0.0, -0.5), (0.3,), (0.2, -0.1, 0.0, -0.1)):
            doc = ezdxf.new("R2010")
            h = hatch(doc.modelspace(), 0, 10, spacing=0.25, dashes=dashes)
            loops = hatching.hatch_boundary_paths(h)
            got, real = cad_frontend.dashes(h, loops, 1e-4), made(h, loops)
            self.assertGreaterEqual(got, real, dashes)
            # And, with dashes, not far over it: a gap is not a dash. (A solid
            # line is one dash; there the boundary's cuts make up the count.)
            if dashes:
                self.assertLess(got, real * 3, dashes)

    def test_a_line_too_dense_for_ezdxf_is_not_counted(self):
        doc = ezdxf.new("R2010")
        h = hatch(doc.modelspace(), 0, 10, spacing=1e-5)
        from ezdxf.render import hatching  # noqa: PLC0415

        self.assertEqual(cad_frontend.dashes(h, hatching.hatch_boundary_paths(h), 1e-4), 0.0)

    def test_a_tiny_dash_pattern_is_one_solid_line_as_in_ezdxf(self):
        doc = ezdxf.new("R2010")
        tiny = hatch(doc.modelspace(), 0, 10, spacing=1.0, dashes=(1e-12, -1e-12))
        plain = hatch(doc.modelspace(), 0, 10, spacing=1.0)
        from ezdxf.render import hatching  # noqa: PLC0415

        loops = hatching.hatch_boundary_paths(tiny)
        self.assertEqual(cad_frontend.dashes(tiny, loops, 1e-4), cad_frontend.dashes(plain, loops, 1e-4))
        self.assertEqual(drawn(doc)[0], 0)

    def test_a_jagged_boundary_counts_every_piece(self):
        # A pattern longer than the comb is wide: the box gives about one
        # dash per line, but every tooth cuts its own dash.
        from ezdxf.render import hatching  # noqa: PLC0415

        doc = ezdxf.new("R2010")
        h = comb(doc.modelspace(), 200, 400, spacing=1.0, dashes=(1000.0, -1000.0))
        loops = hatching.hatch_boundary_paths(h)
        real = made(h, loops)
        diag = hatching_box_diag(loops)
        box_only = (diag / 1.0 + 1.0) * (diag / 2000.0 + 1)
        self.assertGreater(real, box_only * 5)
        self.assertGreaterEqual(cad_frontend.dashes(h, loops, 1e-4), real)


def hatching_box_diag(loops):
    from ezdxf import path as ezpath  # noqa: PLC0415

    return ezpath.bbox(loops, fast=True).size.magnitude


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

    def test_past_the_budget_further_hatches_are_outlines(self):
        # Many hatches each under MAX_DASHES: the picture's dashes stay
        # under DASH_BUDGET, and the rest are counted as outlines.
        doc = ezdxf.new("R2010")
        for i in range(8):
            hatch(doc.modelspace(), 20 * i, 20 * i + 10, spacing=0.1, dashes=(0.05, -0.05))
        from ezdxf.render import hatching  # noqa: PLC0415

        one = hatch(ezdxf.new("R2010").modelspace(), 0, 10, spacing=0.1, dashes=(0.05, -0.05))
        each = cad_frontend.dashes(one, hatching.hatch_boundary_paths(one), 1e-4)
        from ezdxf.addons.drawing.recorder import SolidLinesRecord  # noqa: PLC0415

        with mock.patch.object(cad_frontend, "MAX_DASHES", each * 1.5), \
                mock.patch.object(cad_frontend, "DASH_BUDGET", each * 3.5):
            rec = Recorder()
            front = cad_frontend.Frontend(RenderContext(doc), rec)
            front.draw_layout(doc.modelspace(), finalize=True)
        self.assertEqual(front.outlined, 5)
        self.assertLessEqual(front.spent, each * 3.5)
        lines = sum(len(r.lines) // 2 for r in rec.records if isinstance(r, SolidLinesRecord))
        self.assertGreater(lines, 0)
        self.assertLessEqual(lines, front.spent)
        # The outlines are drawn: the whole row is in the picture.
        self.assertEqual(round(rec.player().bbox().extmax.x, 6), 150.0)

    def test_a_dense_upside_down_hatch_in_a_turned_mirrored_block_lands_where_its_twin_does(self):
        # The block: a hatch at x 90..100, y 0..10. Inserted at (1000, 500),
        # mirrored in x and turned 90 degrees: (x, y) -> (1000 - y, 500 - x).
        for kw in ({"spacing": 5e-5}, {"scale": 1e-9}, {"scale": 0.5}):
            boxes = []
            for flip in (False, True):
                doc = ezdxf.new("R2010")
                block = doc.blocks.new("B")
                hatch(block, 90, 100, flip=flip, **kw)
                doc.modelspace().add_blockref("B", (1000, 500), dxfattribs={"xscale": -1, "rotation": 90})
                boxes.append(drawn(doc))
            for (n, box) in boxes:
                for got, want in zip(box, (990.0, 400.0, 1000.0, 410.0)):
                    self.assertAlmostEqual(got, want, delta=0.3, msg=f"{kw} {boxes}")
            self.assertEqual(boxes[0][0], boxes[1][0], kw)

    def test_a_dense_fallback_gives_back_the_dashes_it_was_charged(self):
        # The first pattern line is counted; ezdxf stops at the second (too
        # dense) and fills the hatch solid, so none of those dashes are drawn.
        doc = ezdxf.new("R2010")
        h = doc.modelspace().add_hatch(color=1)
        lines = [[0.0, (0.0, 0.0), (0.0, 1.0), []], [0.0, (0.0, 0.0), (0.0, 5e-5), []]]
        h.set_pattern_fill("_USER", style=0, pattern_type=0, definition=lines)
        h.set_pattern_definition(lines, factor=1.0, angle=0.0)
        h.paths.add_polyline_path([(90, 0), (100, 0), (100, 10), (90, 10)], is_closed=True)
        from ezdxf.render import hatching  # noqa: PLC0415

        self.assertGreater(cad_frontend.dashes(h, hatching.hatch_boundary_paths(h), 1e-4), 0)
        rec = Recorder()
        front = cad_frontend.Frontend(RenderContext(doc), rec)
        front.draw_layout(doc.modelspace(), finalize=True)
        self.assertEqual((front.outlined, front.spent), (0, 0))
        box = rec.player().bbox()
        self.assertEqual((round(box.extmin.x, 6), round(box.extmax.x, 6)), (90.0, 100.0))

    def test_an_outlined_mpolygon_draws_its_boundary_once(self):
        from ezdxf.addons.drawing.recorder import PathRecord  # noqa: PLC0415

        def paths(scale):
            doc = ezdxf.new("R2010")
            mp = doc.modelspace().add_mpolygon(color=1)
            mp.set_pattern_fill("ANSI31", scale=scale)
            mp.paths.add_polyline_path([(0, 0), (HUGE, 0), (HUGE, 10), (0, 10)], is_closed=True)
            rec = Recorder()
            front = cad_frontend.Frontend(RenderContext(doc), rec)
            front.draw_layout(doc.modelspace(), finalize=True)
            return front.outlined, sum(isinstance(r, PathRecord) for r in rec.records)

        self.assertEqual(paths(0.001), (1, 1))
        # A pattern ezdxf draws: the boundary is drawn once there too.
        self.assertEqual(paths(HUGE / 100)[1], 1)

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

    def test_many_medium_hatches_stop_at_the_budget(self):
        # Eight hatches of about 0.45 million estimated dashes each, every
        # one under MAX_DASHES: six are drawn, two are outlines, and the
        # picture and its index are written.
        with tempfile.TemporaryDirectory() as tmp:
            doc = ezdxf.new("R2010")
            for i in range(8):
                hatch(doc.modelspace(), 20 * i, 20 * i + 10, spacing=0.015, dashes=(0.015, -0.015))
            src = os.path.join(tmp, "many.dxf")
            doc.saveas(src)
            out = os.path.join(tmp, "out")
            os.makedirs(out)
            proc = subprocess.run([sys.executable, APP, "--dwg-render", src, out, "50"],
                                  capture_output=True, text=True, timeout=120)
            self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
            with open(os.path.join(out, "index.json")) as f:
                index = json.load(f)
            self.assertEqual(index["hatches_outlined"], 2)
            self.assertIsNone(index["render_error"])
            peak = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
            if sys.platform.startswith("linux"):
                self.assertLess(peak, 1_500_000, f"peak {peak} KB")

    def test_a_picture_drawn_up_to_the_budget_stays_small(self):
        # A dash-only pattern (no gaps): every estimated dash along a line is
        # drawn. Four hatches fill the budget to within 5% and are drawn; a
        # fifth is an outline. A square box holds half of what its diagonal
        # estimates, so this draws about as many dashes as the budget lets in.
        from ezdxf.render import hatching  # noqa: PLC0415

        s = 0.0165
        one = hatch(ezdxf.new("R2010").modelspace(), 0, 10, spacing=s, dashes=(s,))
        loops = hatching.hatch_boundary_paths(one)
        each, real = cad_frontend.dashes(one, loops, 1e-4), made(one, loops)
        budget = cad_frontend.DASH_BUDGET
        self.assertTrue(budget * 0.95 < 4 * each <= budget < 5 * each, each)
        self.assertGreater(4 * real, budget * 0.45, real)
        with tempfile.TemporaryDirectory() as tmp:
            doc = ezdxf.new("R2010")
            for i in range(5):
                hatch(doc.modelspace(), 20 * i, 20 * i + 10, spacing=s, dashes=(s,))
            src = os.path.join(tmp, "full.dxf")
            doc.saveas(src)
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
            self.assertLess(took, 60)
            peak = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
            if sys.platform.startswith("linux"):
                self.assertLess(peak, 1_500_000, f"peak {peak} KB")

    def test_a_dwg_counts_it_in_the_index_not_in_its_partial_list(self):
        # The digest says "Partly drawn" from hatches_outlined for every
        # converter; a DWG's `partial` (what reading lost) does not repeat it.
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
            self.assertEqual(index["dwg"]["partial"], [{"reason": "a style not carried", "count": 2}])

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
