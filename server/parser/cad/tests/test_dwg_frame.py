"""Tests for the sheet frame (dwg_frame.py) and the pictures that use it: the
pure stray rule, the framed `--dwg-render`, and `view` items of `--dwg-crop`.
Every drawing here is synthetic and written by this test (the repo is
public).

Run (stdlib unittest; the render cases skip when ezdxf or matplotlib is
missing, unless PARSER_TESTS_REQUIRE_CAD is set):
    /tmp/dwgvenv/bin/python -m unittest discover -s server/parser/cad/tests -v
"""

from __future__ import annotations

import json
import os
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import cad  # noqa: E402
import dwg_crop  # noqa: E402
import dwg_frame  # noqa: E402

CAD_PY = os.path.join(os.path.dirname(HERE), "cad.py")

try:
    import ezdxf
    import matplotlib  # noqa: F401

    HAVE_RENDER = True
except Exception:  # pragma: no cover - the venv case
    HAVE_RENDER = False
    if os.environ.get("PARSER_TESTS_REQUIRE_CAD"):
        raise


def sheet(x=0.0, y=0.0, w=800.0, h=500.0, n=200):
    """A sheet's boxes: a border, and small items across it."""
    boxes = [(x, y, x + w, y + h)]
    for i in range(n):
        px = x + (i % 20) * w / 20
        py = y + (i // 20 % 10) * h / 10
        boxes.append((px, py, px + 10, py + 5))
    return boxes


class FrameTests(unittest.TestCase):
    def test_a_far_note_is_left_out_and_reported(self):
        note = [(9000.0, 100.0, 9200.0, 140.0), (9000.0, 150.0, 9150.0, 180.0)]
        f = dwg_frame.sheet_frame(sheet() + note)
        self.assertTrue(f["framed"])
        self.assertLess(f["sheet"][2], 900)
        self.assertEqual(f["full"][2], 9200.0)
        self.assertEqual(len(f["off_sheet"]), 1)
        self.assertEqual(f["off_sheet"][0]["entities"], 2)
        x0, y0, x1, y1 = f["off_sheet"][0]["window"]
        self.assertLessEqual(x0, 9000.0)
        self.assertGreaterEqual(x1, 9200.0)
        self.assertLessEqual(y0, 100.0)
        self.assertGreaterEqual(y1, 180.0)

    def test_a_stray_at_the_origin_of_a_far_sheet(self):
        f = dwg_frame.sheet_frame(sheet(x=500000.0, y=300000.0) + [(0.0, 0.0, 0.0, 0.0)])
        self.assertTrue(f["framed"])
        self.assertGreater(f["sheet"][0], 499000)
        self.assertGreater(f["sheet"][1], 299000)

    def test_a_stray_on_the_y_axis(self):
        f = dwg_frame.sheet_frame(sheet() + [(100.0, 7000.0, 180.0, 7040.0)])
        self.assertTrue(f["framed"])
        self.assertLess(f["sheet"][3], 600)

    def test_a_note_just_off_the_sheet_stays(self):
        f = dwg_frame.sheet_frame(sheet() + [(850.0, 100.0, 930.0, 130.0)])
        self.assertFalse(f["framed"])

    def test_tiled_sheets_all_stay(self):
        boxes = sheet() + sheet(x=1000.0) + sheet(x=2000.0)
        f = dwg_frame.sheet_frame(boxes)
        self.assertFalse(f["framed"])
        self.assertEqual(f["sheet"], f["full"])

    def test_a_sparse_full_size_sheet_stays(self):
        # Few entities, but the size of a sheet: a cover beside the others,
        # far enough to pass the gap rule.
        cover = sheet(x=1400.0, n=8)
        f = dwg_frame.sheet_frame(sheet() + cover)
        self.assertFalse(f["framed"])

    def test_a_line_out_to_the_note_joins_it(self):
        f = dwg_frame.sheet_frame(sheet() + [(790.0, 100.0, 9000.0, 100.0), (9000.0, 90.0, 9100.0, 120.0)])
        self.assertFalse(f["framed"])

    def test_two_equal_parts_both_stay(self):
        f = dwg_frame.sheet_frame(sheet(w=100.0, h=100.0, n=50) + sheet(x=5000.0, w=100.0, h=100.0, n=50))
        self.assertFalse(f["framed"])

    def test_a_group_past_a_stray_is_measured_from_the_sheet(self):
        f = dwg_frame.sheet_frame(sheet() + [(5000.0, 0.0, 5100.0, 40.0), (9000.0, 0.0, 9100.0, 40.0)])
        self.assertTrue(f["framed"])
        self.assertEqual(len(f["off_sheet"]), 2)

    def test_nothing_to_read(self):
        self.assertIsNone(dwg_frame.sheet_frame([]))
        self.assertIsNone(dwg_frame.sheet_frame([(float("nan"), 0.0, 1.0, 1.0)]))

    def test_a_point_sized_drawing_does_not_divide_by_zero(self):
        f = dwg_frame.sheet_frame([(5.0, 5.0, 5.0, 5.0), (5.0, 5.0, 5.0, 5.0)])
        self.assertFalse(f["framed"])

    def test_the_report_is_capped(self):
        strays = [(x, 0.0, x + 10.0, 5.0) for x in (5000.0, 20000.0, 100000.0)]
        with mock.patch.object(dwg_frame, "MAX_OFF_SHEET", 2):
            f = dwg_frame.sheet_frame(sheet() + strays)
        self.assertTrue(f["framed"])
        self.assertLess(f["sheet"][2], 900)
        self.assertEqual(len(f["off_sheet"]), 2)

    def test_the_view_page_is_the_render_page(self):
        self.assertEqual(dwg_crop.VIEW_PAGE_INCHES, cad.RENDER_PAGE_INCHES)


def entities(boxes, kind=dwg_frame.OTHER):
    return [(kind, b) for b in boxes]


def bordered(x=0.0, y=0.0, w=800.0, h=500.0, n=200):
    """A sheet as entities: its first box, the border, is a closed polyline."""
    boxes = sheet(x, y, w, h, n)
    return [(dwg_frame.CLOSED, boxes[0])] + entities(boxes[1:])


class BorderTests(unittest.TestCase):
    def test_the_border_frames_even_a_near_note(self):
        note = [(dwg_frame.TEXT, (850.0, 100.0, 850.0, 100.0))]
        f = dwg_frame.drawing_frame(bordered() + note)
        self.assertTrue(f["framed"])
        self.assertLess(f["sheet"][2], 830)
        self.assertEqual(f["off_sheet"][0]["entities"], 1)

    def test_an_off_sheet_point_has_a_window_with_size(self):
        note = [(dwg_frame.TEXT, (9000.0, 100.0, 9000.0, 100.0))]
        w = dwg_frame.drawing_frame(bordered() + note)["off_sheet"][0]["window"]
        self.assertLess(w[0], 9000)
        self.assertGreater(w[2], 9000)
        self.assertGreater(w[3], w[1])

    def test_a_few_notes_outside_do_not_move_the_border(self):
        labels = [(dwg_frame.TEXT, (5000.0 + i, 0.0, 5000.0 + i, 0.0)) for i in range(15)]
        f = dwg_frame.drawing_frame(bordered() + labels)
        self.assertLess(f["sheet"][2], 830)
        self.assertEqual(f["off_sheet"][0]["entities"], 15)

    def test_no_stray_is_the_old_picture(self):
        f = dwg_frame.drawing_frame(bordered())
        self.assertFalse(f["framed"])
        self.assertEqual(f["sheet"], f["full"])

    def test_tiled_sheets_of_uneven_weight_all_stay(self):
        # The first sheet holds over 60% of the geometry: the second border
        # says it is not the only sheet.
        f = dwg_frame.drawing_frame(bordered(n=300) + bordered(x=1000.0, n=100))
        self.assertFalse(f["framed"])

    def test_a_small_closed_box_is_not_a_second_sheet(self):
        stamp = [(dwg_frame.CLOSED, (5000.0, 0.0, 5100.0, 60.0))]
        f = dwg_frame.drawing_frame(bordered() + stamp)
        self.assertTrue(f["framed"])
        self.assertLess(f["sheet"][2], 830)

    def test_a_closed_box_round_a_detail_is_not_the_border(self):
        boxes = entities(sheet(n=300))
        detail = [(dwg_frame.CLOSED, (10.0, 10.0, 60.0, 60.0))]
        f = dwg_frame.drawing_frame(boxes + detail)
        self.assertFalse(f["framed"])

    def test_with_no_border_the_stray_rule_decides(self):
        note = entities([(9000.0, 100.0, 9200.0, 140.0)], dwg_frame.TEXT)
        f = dwg_frame.drawing_frame(entities(sheet()) + note)
        self.assertTrue(f["framed"])
        self.assertLess(f["sheet"][2], 900)

    def test_a_box_inside_a_block_border_is_not_the_border(self):
        # The sheet is a block; the closed box is a battery limit in it, and
        # the title block and the legend are text.
        drawing = [(dwg_frame.OTHER, (0.0, 0.0, 841.0, 594.0))]
        drawing.append((dwg_frame.CLOSED, (100.0, 100.0, 500.0, 450.0)))
        drawing += entities(sheet(x=110.0, y=110.0, w=380.0, h=330.0, n=120)[1:])
        drawing += entities(sheet(x=510.0, y=20.0, w=320.0, h=540.0, n=100)[1:], dwg_frame.TEXT)
        f = dwg_frame.drawing_frame(drawing)
        self.assertFalse(f["framed"])

    def test_a_closed_box_with_the_legend_outside_it_is_not_the_border(self):
        # No block round it this time: what stands outside is too much.
        drawing = [(dwg_frame.CLOSED, (100.0, 100.0, 500.0, 450.0))]
        drawing += entities(sheet(x=110.0, y=110.0, w=380.0, h=330.0, n=120)[1:])
        drawing += entities(sheet(x=510.0, y=20.0, w=320.0, h=540.0, n=100)[1:], dwg_frame.TEXT)
        f = dwg_frame.drawing_frame(drawing)
        self.assertGreater(f["sheet"][2], 800)

    def test_a_smaller_tile_stays(self):
        boxes = bordered(n=300) + bordered(x=1000.0, w=400.0, h=300.0, n=60)
        self.assertFalse(dwg_frame.drawing_frame(boxes)["framed"])

    def test_nothing_to_read(self):
        self.assertIsNone(dwg_frame.drawing_frame([]))


class ViewSpecTests(unittest.TestCase):
    def test_a_view_needs_no_pad(self):
        s = dwg_crop.parse_spec({"items": [{"id": "v", "kind": "view"}], "overview": False})
        self.assertEqual(s["items"][0]["kind"], "view")
        self.assertIsNone(s["items"][0]["window"])
        self.assertFalse(s["items"][0]["full"])
        self.assertEqual(s["items"][0]["edge"], dwg_crop.MAX_EDGE)

    def test_a_window_must_have_size(self):
        with self.assertRaises(dwg_crop.SpecError):
            dwg_crop.parse_spec({"items": [{"id": "v", "kind": "view", "window": [5, 5, 5, 9]}]})
        with self.assertRaises(dwg_crop.SpecError):
            dwg_crop.parse_spec({"items": [{"id": "v", "kind": "view", "window": [1, 2, 3]}]})

    def test_a_window_too_large_to_draw(self):
        with self.assertRaises(dwg_crop.SpecError):
            dwg_crop.parse_spec(
                {"items": [{"id": "v", "kind": "view", "window": [-1e308, 0, 1e308, 1]}]}
            )

    def test_the_edge_is_held_to_its_range(self):
        for edge in (10, dwg_crop.MAX_VIEW_EDGE + 1, "wide"):
            with self.assertRaises(dwg_crop.SpecError):
                dwg_crop.parse_spec({"items": [{"id": "v", "kind": "view", "edge": edge}]})

    def test_point_items_still_need_a_pad(self):
        with self.assertRaises(dwg_crop.SpecError):
            dwg_crop.parse_spec({"items": [{"id": "p", "kind": "point", "at": [0, 0]}]})

    def test_a_view_plans_the_window_it_was_given_at_its_edge(self):
        item = {"id": "v", "kind": "view", "window": [0.0, 0.0, 400.0, 100.0], "edge": 1000,
                "full": False, "marks": []}
        c = dwg_crop.plan([item], [])["crops"][0]
        self.assertEqual(c["window"], [0.0, 0.0, 400.0, 100.0])
        self.assertEqual((c["width"], c["height"]), (1000, 250))
        self.assertTrue(c["view"])


def png_size(path):
    with open(path, "rb") as f:
        head = f.read(24)
    assert head[:8] == b"\x89PNG\r\n\x1a\n"
    return struct.unpack(">II", head[16:24])


def ink_bounds(path):
    """The inked box of a PNG, in pixels."""
    from PIL import Image, ImageChops

    with Image.open(path) as im:
        grey = im.convert("L")
        return ImageChops.invert(grey).getbbox(), grey.size


def write_drawing(path, note=True):
    """A bordered sheet with pipe lines and text, and a far-off red note."""
    doc = ezdxf.new("R2018")
    msp = doc.modelspace()
    msp.add_lwpolyline([(0, 0), (800, 0), (800, 500), (0, 500)], close=True)
    for i in range(1, 12):
        msp.add_line((20, i * 40), (780, i * 40))
    for i in range(30):
        msp.add_text(f"L{i}", height=6).set_placement((30 + i * 24, 20))
    if note:
        msp.add_text("FAR NOTE", height=20, dxfattribs={"color": 1}).set_placement((9000, 200))
    doc.saveas(path)


@unittest.skipUnless(HAVE_RENDER, "ezdxf or matplotlib missing")
class RenderTests(unittest.TestCase):
    def run_cad(self, *args):
        return subprocess.run([sys.executable, CAD_PY, *args], capture_output=True, text=True)

    def test_the_sheet_fills_the_picture(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "a.dxf")
            write_drawing(src)
            p = self.run_cad("--dwg-render", src, d, "100")
            self.assertEqual(p.returncode, 0, p.stderr)
            with open(os.path.join(d, "index.json"), encoding="utf-8") as f:
                index = json.load(f)
            self.assertIsNone(index["render_error"])
            self.assertTrue(index["frame"]["framed"])
            self.assertEqual(index["frame"]["off_sheet"][0]["entities"], 1)
            box, size = ink_bounds(os.path.join(d, "model.png"))
            # The sheet's border reaches near the picture's edges: it does not
            # sit in a corner of a page sized for the note.
            self.assertGreater((box[2] - box[0]) / size[0], 0.9)
            self.assertLess(size[0] / size[1], 2.0)

    def test_a_thin_sheet_past_the_page_shape_is_not_stretched(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "a.dxf")
            doc = ezdxf.new("R2018")
            msp = doc.modelspace()
            msp.add_lwpolyline([(0, 0), (1000, 0), (1000, 50), (0, 50)], close=True)
            for i in range(30):
                msp.add_line((i * 30, 5), (i * 30 + 20, 45))
            msp.add_text("FAR NOTE", height=10).set_placement((90000, 20))
            doc.saveas(src)
            p = self.run_cad("--dwg-render", src, d, "100")
            self.assertEqual(p.returncode, 0, p.stderr)
            box, _ = ink_bounds(os.path.join(d, "model.png"))
            # 20:1 on paper, past the page's 5:1 clamp, and 20:1 in the picture.
            self.assertAlmostEqual((box[2] - box[0]) / (box[3] - box[1]), 20, delta=2)

    def test_a_drawing_with_no_stray_says_so(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "a.dxf")
            write_drawing(src, note=False)
            p = self.run_cad("--dwg-render", src, d, "100")
            self.assertEqual(p.returncode, 0, p.stderr)
            with open(os.path.join(d, "index.json"), encoding="utf-8") as f:
                index = json.load(f)
            self.assertFalse(index["frame"]["framed"])
            self.assertEqual(index["frame"]["off_sheet"], [])

    def view(self, d, item):
        src = os.path.join(d, "a.dxf")
        write_drawing(src)
        spec = os.path.join(d, "spec.json")
        with open(spec, "w", encoding="utf-8") as f:
            json.dump({"items": [{"id": "v", "kind": "view", **item}], "overview": False}, f)
        out = os.path.join(d, "out")
        os.mkdir(out)
        p = self.run_cad("--dwg-crop", src, out, spec)
        self.assertEqual(p.returncode, 0, p.stderr)
        with open(os.path.join(out, "index.json"), encoding="utf-8") as f:
            return json.load(f), out

    def test_a_view_with_no_window_frames_the_sheet(self):
        with tempfile.TemporaryDirectory() as d:
            index, out = self.view(d, {"edge": 1000})
            c = index["crops"][0]
            self.assertLess(c["window"][2], 900)
            self.assertEqual(max(c["width"], c["height"]), 1000)
            self.assertFalse(c["blank"])
            self.assertEqual(index["frame"]["off_sheet"][0]["entities"], 1)
            self.assertEqual(png_size(os.path.join(out, c["file"])), (c["width"], c["height"]))

    def test_full_takes_the_whole_extents(self):
        with tempfile.TemporaryDirectory() as d:
            index, _ = self.view(d, {"full": True, "edge": 1000})
            self.assertGreater(index["crops"][0]["window"][2], 9000)

    def test_an_empty_drawing_fails_with_the_reason(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "a.dxf")
            ezdxf.new("R2018").saveas(src)
            spec = os.path.join(d, "spec.json")
            with open(spec, "w", encoding="utf-8") as f:
                json.dump({"items": [{"id": "v", "kind": "view"}], "overview": False}, f)
            p = self.run_cad("--dwg-crop", src, d, spec)
            self.assertEqual(p.returncode, 1)
            self.assertIn("nothing in model space", p.stderr)
            self.assertNotIn("Traceback", p.stderr)

    def test_a_window_on_the_note_reads_it(self):
        with tempfile.TemporaryDirectory() as d:
            index, _ = self.view(d, {"window": [8900, 150, 9300, 260], "edge": 800})
            c = index["crops"][0]
            self.assertEqual(c["window"], [8900.0, 150.0, 9300.0, 260.0])
            self.assertFalse(c["blank"])

    def test_the_off_sheet_window_shows_the_whole_note(self):
        with tempfile.TemporaryDirectory() as d:
            index, _ = self.view(d, {"edge": 800})
            x0, _, x1, _ = index["frame"]["off_sheet"][0]["window"]
            # 8 letters of height 20, not the start point alone.
            self.assertGreater(x1 - x0, 60)

    def test_a_lone_small_thing_is_not_blank(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "a.dxf")
            doc = ezdxf.new("R2018")
            msp = doc.modelspace()
            msp.add_lwpolyline([(0, 0), (800, 0), (800, 500), (0, 500)], close=True)
            msp.add_circle((2000, 2000), radius=3)
            doc.saveas(src)
            spec = os.path.join(d, "spec.json")
            with open(spec, "w", encoding="utf-8") as f:
                json.dump(
                    {
                        "items": [
                            {"id": "v", "kind": "view", "window": [1900, 1900, 2100, 2100],
                             "edge": 800}
                        ],
                        "overview": False,
                    },
                    f,
                )
            p = self.run_cad("--dwg-crop", src, d, spec)
            self.assertEqual(p.returncode, 0, p.stderr)
            with open(os.path.join(d, "index.json"), encoding="utf-8") as f:
                self.assertFalse(json.load(f)["crops"][0]["blank"])

    def test_with_nothing_off_the_sheet_the_view_keeps_long_text(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "a.dxf")
            doc = ezdxf.new("R2018")
            msp = doc.modelspace()
            msp.add_lwpolyline([(0, 0), (800, 0), (800, 500), (0, 500)], close=True)
            for i in range(1, 12):
                msp.add_line((20, i * 40), (780, i * 40))
            msp.add_text("A LONG LABEL", height=30).set_placement((600, 250))
            doc.saveas(src)
            spec = os.path.join(d, "spec.json")
            with open(spec, "w", encoding="utf-8") as f:
                json.dump({"items": [{"id": "v", "kind": "view"}], "overview": False}, f)
            p = self.run_cad("--dwg-crop", src, d, spec)
            self.assertEqual(p.returncode, 0, p.stderr)
            with open(os.path.join(d, "index.json"), encoding="utf-8") as f:
                index = json.load(f)
            self.assertEqual(index["crops"][0]["window"], index["frame"]["full"])
            self.assertFalse(index["frame"]["framed"])
            self.assertGreater(index["crops"][0]["window"][2], 830)

    def test_a_named_window_needs_no_frame(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "a.dxf")
            ezdxf.new("R2018").saveas(src)
            spec = os.path.join(d, "spec.json")
            with open(spec, "w", encoding="utf-8") as f:
                json.dump(
                    {"items": [{"id": "v", "kind": "view", "window": [0, 0, 10, 10]}],
                     "overview": False},
                    f,
                )
            p = self.run_cad("--dwg-crop", src, d, spec)
            self.assertEqual(p.returncode, 0, p.stderr)

    def test_an_empty_window_says_it_is_blank(self):
        with tempfile.TemporaryDirectory() as d:
            index, _ = self.view(d, {"window": [3000, 3000, 3100, 3100], "edge": 800})
            self.assertTrue(index["crops"][0]["blank"])


if __name__ == "__main__":
    unittest.main()
