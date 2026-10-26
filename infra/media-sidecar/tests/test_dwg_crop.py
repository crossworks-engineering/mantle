"""Tests for the image check's crops (dwg_crop.py and the --dwg-crop child):
the pure planning (zoom from text, point and path crops, caps) and the
render on synthetic DXF files this test writes with ezdxf (never a real
drawing: the repo is public).

Run (stdlib unittest; the render cases skip when ezdxf or matplotlib is
missing, unless MEDIA_TESTS_REQUIRE_EZDXF is set):
    /tmp/dwgvenv/bin/pip install "ezdxf==1.4.5" "matplotlib==3.11.2"
    /tmp/dwgvenv/bin/python -m unittest discover -s infra/media-sidecar/tests -v
"""

from __future__ import annotations

import json
import os
import struct
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import dwg_crop  # noqa: E402

try:
    import ezdxf  # noqa: F401
    import matplotlib  # noqa: F401

    HAVE_RENDER = True
except Exception:  # pragma: no cover - the venv case
    HAVE_RENDER = False
    if os.environ.get("MEDIA_TESTS_REQUIRE_EZDXF"):
        raise


def png_size(path):
    with open(path, "rb") as f:
        head = f.read(24)
    assert head[:8] == b"\x89PNG\r\n\x1a\n"
    return struct.unpack(">II", head[16:24])


def point(iid, x, y, pad=20.0, marks=None):
    return {"id": iid, "kind": "point", "at": [x, y], "pad": pad, "marks": marks or [[x, y]]}


class SpecTests(unittest.TestCase):
    def test_a_bad_spec_names_the_field(self):
        for bad, field in [
            ({}, "items"),
            ({"items": [{"id": "a", "kind": "box", "pad": 1}]}, "items[0].kind"),
            ({"items": [{"id": "a", "kind": "point", "pad": 0, "at": [0, 0]}]}, "items[0].pad"),
            ({"items": [{"id": "a", "kind": "point", "pad": 1, "at": [0, "x"]}]}, "items[0].at"),
            ({"items": [point("a", 0, 0)], "overlay": [{"color": "pink", "segs": []}]}, "overlay[0].color"),
        ]:
            with self.assertRaises(dwg_crop.SpecError) as ctx:
                dwg_crop.parse_spec(bad)
            self.assertIn(field, str(ctx.exception))

    def test_too_many_items_is_refused(self):
        items = [point(f"q{i}", i, 0) for i in range(dwg_crop.MAX_ITEMS + 1)]
        with self.assertRaises(dwg_crop.SpecError):
            dwg_crop.parse_spec({"items": items})


class PlanTests(unittest.TestCase):
    # Texts: (x, y, height). A sheet of 2.5-unit labels with one 1.8 tag.
    texts = [(x * 50.0, y * 50.0, 2.5) for x in range(20) for y in range(10)] + [(102, 98, 1.8)]

    def test_a_point_crop_zooms_to_its_smallest_text(self):
        p = dwg_crop.plan([point("q1", 100, 100, pad=30)], self.texts)
        (c,) = p["crops"]
        self.assertEqual(c["id"], "q1")
        # 1.8-unit text at 14 px: 7.78 px per unit, a 60-unit window ~467 px,
        # under MIN_EDGE, so the window grows to MIN_EDGE at the same zoom.
        self.assertAlmostEqual(c["text_px"], 14.0, delta=0.2)
        self.assertEqual(max(c["width"], c["height"]), dwg_crop.MIN_EDGE)
        x0, y0, x1, y1 = c["window"]
        self.assertAlmostEqual((x0 + x1) / 2, 100)
        self.assertAlmostEqual((y0 + y1) / 2, 100)

    def test_a_wide_point_crop_holds_the_edge_cap(self):
        p = dwg_crop.plan([point("q1", 100, 100, pad=400)], self.texts)
        (c,) = p["crops"]
        self.assertLessEqual(max(c["width"], c["height"]), dwg_crop.MAX_EDGE)
        self.assertLess(c["text_px"], 14.0)

    def test_noise_text_does_not_set_the_zoom(self):
        texts = self.texts + [(100, 100, 0.05)]
        (c,) = dwg_crop.plan([point("q1", 100, 100, pad=30)], texts)["crops"]
        self.assertAlmostEqual(c["text_px"], 14.0, delta=0.2)

    def test_a_long_path_is_overlapping_tiles_with_every_joint_inside(self):
        # An L-shaped path 1200 + 800 units long: far past one crop at text zoom.
        pts = [[0, 0], [1200, 0], [1200, 800]]
        item = {"id": "j1", "kind": "path", "points": pts, "pad": 10, "marks": []}
        p = dwg_crop.plan([item], self.texts)
        crops = p["crops"]
        self.assertGreater(len(crops), 1)
        self.assertLessEqual(len(crops), dwg_crop.MAX_PATH_TILES)
        for c in crops:
            self.assertLessEqual(max(c["width"], c["height"]), dwg_crop.MAX_EDGE)
            self.assertEqual(c["of"], len(crops))
        # Every vertex lies in the middle half of some crop (no joint only on an edge).
        for vx, vy in pts:
            inside = False
            for c in crops:
                x0, y0, x1, y1 = c["window"]
                qx, qy = (x1 - x0) / 4, (y1 - y0) / 4
                if x0 + qx <= vx <= x1 - qx and y0 + qy <= vy <= y1 - qy:
                    inside = True
            self.assertTrue(inside, (vx, vy))
        # Neighbouring tiles overlap.
        for a, b in zip(crops, crops[1:]):
            ax0, ay0, ax1, ay1 = a["window"]
            bx0, by0, bx1, by1 = b["window"]
            self.assertTrue(ax0 < bx1 and bx0 < ax1 and ay0 < by1 and by0 < ay1)

    def test_a_short_path_is_one_crop(self):
        item = {"id": "j1", "kind": "path", "points": [[90, 100], [120, 100]], "pad": 10, "marks": []}
        (c,) = dwg_crop.plan([item], self.texts)["crops"]
        self.assertEqual(c["of"], 1)

    def test_the_crop_cap_is_said(self):
        items = [point(f"q{i}", i * 10.0, 0) for i in range(dwg_crop.MAX_CROPS + 3)]
        p = dwg_crop.plan(items, self.texts)
        self.assertEqual(len(p["crops"]), dwg_crop.MAX_CROPS)
        self.assertEqual(len(p["capped"]), 3)

    def test_a_sheet_with_no_text_still_plans(self):
        (c,) = dwg_crop.plan([point("q1", 0, 0, pad=50)], [])["crops"]
        self.assertIsNone(c["text_px"])
        self.assertLessEqual(max(c["width"], c["height"]), dwg_crop.MAX_EDGE)


@unittest.skipUnless(HAVE_RENDER, "ezdxf and matplotlib are not installed")
class RenderTests(unittest.TestCase):
    def drawing(self, tmp):
        doc = ezdxf.new("R2013")
        msp = doc.modelspace()
        doc.layers.add("Circuit 90000-020-01")
        doc.layers.add("PIPE")
        doc.layers.add("EQUIP")
        msp.add_line((0, 0), (400, 0), dxfattribs={"layer": "Circuit 90000-020-01"})
        msp.add_line((400, 0), (400, 300), dxfattribs={"layer": "PIPE"})
        msp.add_circle((400, 340), 40, dxfattribs={"layer": "EQUIP"})
        msp.add_text("V-101", dxfattribs={"insert": (390, 335), "height": 5})
        msp.add_text("6\"-P-0001", dxfattribs={"insert": (100, 3), "height": 2.5})
        path = os.path.join(tmp, "synthetic.dxf")
        doc.saveas(path)
        return path

    def spec(self):
        return {
            "items": [
                point("end", 400, 300, pad=50),
                {"id": "join", "kind": "path", "points": [[300, 0], [400, 0], [400, 300]],
                 "pad": 10, "marks": [[400, 0]]},
            ],
            "overlay": [
                {"color": "main", "segs": [[0, 0, 400, 0]]},
                {"color": "branch", "segs": [[400, 0, 400, 300]]},
            ],
        }

    def test_the_child_writes_crops_and_an_overview(self):
        app = os.path.join(os.path.dirname(HERE), "app.py")
        with tempfile.TemporaryDirectory() as tmp:
            src = self.drawing(tmp)
            spec_path = os.path.join(tmp, "spec.json")
            with open(spec_path, "w") as f:
                json.dump(self.spec(), f)
            out = os.path.join(tmp, "out")
            os.makedirs(out)
            proc = subprocess.run([sys.executable, app, "--dwg-crop", src, out, spec_path],
                                  capture_output=True, text=True, timeout=180)
            self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
            with open(os.path.join(out, "index.json")) as f:
                index = json.load(f)
            self.assertEqual(index["converter"], "none")
            self.assertEqual(index["capped"], [])
            ids = [c["id"] for c in index["crops"]]
            self.assertIn("end", ids)
            self.assertIn("join", ids)
            for c in index["crops"]:
                w, h = png_size(os.path.join(out, c["file"]))
                self.assertEqual((w, h), (c["width"], c["height"]))
                self.assertLessEqual(max(w, h), dwg_crop.MAX_EDGE)
            ov = index["overview"]
            w, h = png_size(os.path.join(out, ov["file"]))
            self.assertLessEqual(max(w, h), dwg_crop.OVERVIEW_EDGE)

    def test_the_overlay_colours_reach_the_pixels(self):
        doc = ezdxf.readfile(self._path())
        with tempfile.TemporaryDirectory() as out:
            spec = dwg_crop.parse_spec(self.spec())
            index = dwg_crop.render(doc, spec, out, deadline=time.time() + 120)
            import matplotlib.image as mpimg  # noqa: PLC0415

            crop = next(c for c in index["crops"] if c["id"] == "end")
            img = mpimg.imread(os.path.join(out, crop["file"]))
            reds = ((img[:, :, 0] > 0.8) & (img[:, :, 1] < 0.6) & (img[:, :, 2] < 0.6)).sum()
            blues = ((img[:, :, 2] > 0.8) & (img[:, :, 0] < 0.6)).sum()
            greens = ((img[:, :, 1] > 0.45) & (img[:, :, 0] < 0.3) & (img[:, :, 2] < 0.3)).sum()
            # The end crop sits on the blue branch with its green ring; the red
            # main line is far off its window.
            self.assertGreater(blues, 50)
            self.assertGreater(greens, 50)
            self.assertEqual(reds, 0)

    def test_the_overlay_is_the_solid_colour_its_name_says(self):
        """Phase 6: the overlay is drawn solid, so a red line is red on the
        page (#E00000), never the pink a translucent red over white makes."""
        self.assertEqual(dwg_crop.OVERLAY_ALPHA, 1.0)
        self.assertEqual(set(dwg_crop.COLOR_NAMES), set(dwg_crop.COLORS))
        doc = ezdxf.readfile(self._path())
        with tempfile.TemporaryDirectory() as out:
            spec = dwg_crop.parse_spec(self.spec())
            index = dwg_crop.render(doc, spec, out, deadline=time.time() + 120)
            import matplotlib.image as mpimg  # noqa: PLC0415

            def close_to(img, hexcol, tol=0.08):
                want = [int(hexcol[i:i + 2], 16) / 255.0 for i in (1, 3, 5)]
                return (
                    (abs(img[:, :, 0] - want[0]) <= tol)
                    & (abs(img[:, :, 1] - want[1]) <= tol)
                    & (abs(img[:, :, 2] - want[2]) <= tol)
                ).sum()

            # The join crop holds both the red main line and the blue branch.
            crop = next(c for c in index["crops"] if c["id"] == "join")
            img = mpimg.imread(os.path.join(out, crop["file"]))
            red = close_to(img, dwg_crop.COLORS["main"])
            self.assertGreater(red, 50)
            self.assertGreater(close_to(img, dwg_crop.COLORS["branch"]), 50)
            # Pink (red at half strength over white) is only the anti-aliased
            # edge of the line, never its body: the line reads as red.
            pink = ((img[:, :, 0] > 0.9) & (img[:, :, 1] > 0.3) & (img[:, :, 1] < 0.75)
                    & (img[:, :, 2] > 0.3) & (img[:, :, 2] < 0.75)).sum()
            self.assertGreater(red, 2 * pink)

    def test_a_spent_deadline_cuts_and_says_so(self):
        doc = ezdxf.readfile(self._path())
        with tempfile.TemporaryDirectory() as out:
            index = dwg_crop.render(doc, dwg_crop.parse_spec(self.spec()), out, deadline=0)
            self.assertEqual(index["crops"], [])
            self.assertEqual(index["capped"], ["end", "join"])
            self.assertIsNone(index["overview"])

    def _path(self):
        if not hasattr(self, "_tmp"):
            self._tmp = tempfile.TemporaryDirectory()
            self.addCleanup(self._tmp.cleanup)
            self._file = self.drawing(self._tmp.name)
        return self._file


if __name__ == "__main__":
    unittest.main()
