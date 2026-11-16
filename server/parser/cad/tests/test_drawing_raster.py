"""Tests for the built-in Reader drawing-raster (drawing_raster.py): a 1-bit TIF, an
SMF raster, an HP-GL/2 plot, and what it leaves alone (a photo TIFF, a tiled
TIFF, bytes that only carry the extension). Every file here is made up by
this test (the repo is public).

Run (stdlib unittest; skipped when Pillow, OpenCV or ezdxf is missing,
unless PARSER_TESTS_REQUIRE_CAD is set):
    /tmp/dwgvenv/bin/python -m unittest discover -s server/parser/cad/tests -v
"""

from __future__ import annotations

import gzip
import io
import json
import os
import struct
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

try:
    import cv2  # noqa: F401
    import ezdxf  # noqa: F401
    import numpy as np
    from PIL import Image, ImageDraw

    import drawing_raster

    HAVE = True
except ImportError:  # pragma: no cover - depends on the environment
    if os.environ.get("PARSER_TESTS_REQUIRE_CAD"):
        raise
    HAVE = False

STEP_PY = os.path.join(os.path.dirname(HERE), "drawing_raster.py")


def sheet_tiff(w=2100, h=1500, dpi=200, mode="1", compression="group4"):
    """A made-up drawing sheet: a border, a title block box, a pipe run."""
    im = Image.new("L", (w, h), 255)
    d = ImageDraw.Draw(im)
    d.rectangle([20, 20, w - 21, h - 21], outline=0, width=3)
    if int(h * 0.8) < h - 21:  # a sliver has no room for it
        d.rectangle([int(w * 0.8), int(h * 0.8), w - 21, h - 21], outline=0, width=2)
    d.line([(100, h // 2), (w // 2, h // 3), (w // 2, h - 200)], fill=0, width=1)
    out = io.BytesIO()
    if mode == "1":
        im.convert("1").save(out, "TIFF", compression=compression, dpi=(dpi, dpi))
    else:
        im.convert(mode).save(out, "TIFF", dpi=(dpi, dpi))
    return out.getvalue()


def bare_tiff(w, h, extra=()):
    """A 1-bit G4 TIFF header with one strip of 4 bytes: its tags only, so a
    huge size costs nothing to make."""
    entries = [
        (256, 4, w),
        (257, 4, h),
        (258, 3, 1),
        (259, 3, 4),
        (262, 3, 0),
        (273, 4, 8),
        (277, 3, 1),
        (278, 4, h),
        (279, 4, 4),
        *extra,
    ]
    entries.sort()
    ifd = 12
    out = b"II*\x00" + struct.pack("<I", ifd) + b"\x00\x00\x00\x00"
    out += struct.pack("<H", len(entries))
    for tag, typ, value in entries:
        out += struct.pack("<HHI", tag, typ, 1) + struct.pack("<I" if typ == 4 else "<HH", *((value,) if typ == 4 else (value, 0)))
    return out + b"\x00\x00\x00\x00"


def smf_of(tiff, title="SAMPLE-LINE-1;SAMPLE-LINE-2(1234)  (SMF)", gz=True):
    raw = (
        drawing_raster.SMF_MAGIC
        + b"\x00" * 12
        + b"\x01\xb0"
        + title.encode()
        + b"\x00\x00\x01\xb0New Raster 1\x00"
        + tiff
        + b"\x01\xb0Untitled Layer 1\x00"
    )
    return gzip.compress(raw) if gz else raw


HPGL = (
    b"\x1b%0BIN;BP1,\"SAMPLE-PLOT(77).dgn\";SP1;PW0.35,1;PU0,0;"
    b"PD40000,0,40000,30000,0,30000,0,0;PU2000,2000;PD38000,28000;PU30000,2000;PD38000,2000,38000,6000;"
    b"\x1b%0A"
)


@unittest.skipUnless(HAVE, "Pillow, OpenCV or ezdxf is missing")
class DrawingRasterTest(unittest.TestCase):
    def run_step(self, data, ext, options=None):
        job = tempfile.mkdtemp(prefix="iso-")
        with open(os.path.join(job, "in.bin"), "wb") as f:
            f.write(data)
        request = {"step": 1, "file": {"name": "x." + ext, "ext": ext, "size": len(data)}, "options": options or {}}
        return drawing_raster.step(request, data, job), job

    def write_of(self, result):
        self.assertEqual(result["status"], "ok", result)
        (call,) = result["calls"]
        self.assertEqual(call["tool"], "file_tabs_write")
        return call["input"]

    def rows_of(self, write):
        (tab,) = write["tabs"]
        self.assertEqual(tab["name"], "Drawing")
        return dict(tab["rows"])

    def test_a_1bit_tif_is_a_drawing_sheet(self):
        result, job = self.run_step(sheet_tiff(), "tif")
        write = self.write_of(result)
        rows = self.rows_of(write)
        self.assertEqual(rows["Format"], "TIFF raster")
        self.assertEqual(rows["Compression"], "CCITT G4")
        self.assertEqual((rows["Width px"], rows["Height px"], rows["DPI"]), ("2100", "1500", "200"))
        self.assertEqual(rows["Width mm"], "267")
        self.assertIn("a drawing sheet of 267 x 190 mm", write["text"])
        files = [p["file"] for p in write["pictures"]]
        self.assertEqual(files, ["sheet.png", "crop1.png", "crop2.png", "crop3.png"])
        with Image.open(os.path.join(job, "sheet.png")) as im:
            sheet = np.asarray(im)
        # The ink is dark and the paper white, whatever the TIFF's polarity.
        self.assertGreater(sheet.mean(), 200)
        self.assertLess(sheet[sheet.shape[0] // 2, :40].min(), 128)

    def test_the_raster_stays_one_bit_in_memory(self):
        data = sheet_tiff(w=1001, h=300)
        job = tempfile.mkdtemp(prefix="iso-")
        path = os.path.join(job, "in.bin")
        with open(path, "wb") as f:
            f.write(data)
        raster = drawing_raster.Raster(path, drawing_raster.open_tiff(data))
        self.assertEqual(raster.ink.dtype, np.uint8)
        self.assertEqual(raster.ink.shape, (300, 126))  # 8 pixels a byte

    def test_no_picture_is_under_200_px(self):
        result, job = self.run_step(sheet_tiff(w=900, h=500, dpi=100), "tiff")
        for p in self.write_of(result)["pictures"]:
            with Image.open(os.path.join(job, p["file"])) as im:
                self.assertGreaterEqual(min(im.size), drawing_raster.MIN_SIDE, p["file"])

    def test_crops_off_gives_the_whole_sheet_only(self):
        result, _ = self.run_step(sheet_tiff(), "tif", {"crops": False, "page_px": 1000})
        (pic,) = self.write_of(result)["pictures"]
        self.assertEqual(pic["file"], "sheet.png")

    def test_a_photo_tiff_is_not_mine(self):
        for mode in ("L", "RGB"):
            result, _ = self.run_step(sheet_tiff(w=400, h=300, mode=mode), "tif")
            self.assertEqual(result, {"status": "not_mine"}, mode)

    def test_a_tiled_tiff_is_not_mine(self):
        data = bare_tiff(512, 512, extra=[(322, 3, 256), (323, 3, 256), (324, 4, 8), (325, 4, 4)])
        result, _ = self.run_step(data, "tif")
        self.assertEqual(result, {"status": "not_mine"})

    def test_bytes_that_are_no_tiff_are_not_mine(self):
        result, _ = self.run_step(b"\x89PNG\r\n\x1a\n" + b"\x00" * 64, "tif")
        self.assertEqual(result, {"status": "not_mine"})

    def test_a_raster_past_the_cap_fails_with_a_sentence(self):
        result, _ = self.run_step(bare_tiff(60000, 50000), "tif")
        self.assertEqual(result["status"], "failed")
        self.assertIn("gigapixels", result["warnings"][0])

    def test_a_raster_with_one_very_long_side_fails_with_a_sentence(self):
        # Under the pixel cap, but a narrow or a very wide sheet would still
        # make a buffer of gigabytes: the side cap refuses both, at the header.
        for w, h in ((1, 2_500_000_000), (330_000, 7_500)):
            result, _ = self.run_step(bare_tiff(w, h), "tif")
            self.assertEqual(result["status"], "failed", (w, h))
            self.assertIn("gigapixels", result["warnings"][0])

    def test_an_smf_gives_its_title_and_layers(self):
        for gz in (True, False):
            result, _ = self.run_step(smf_of(sheet_tiff(), gz=gz), "smf")
            write = self.write_of(result)
            rows = self.rows_of(write)
            self.assertEqual(rows["Format"], "Imagenation SMF raster")
            self.assertEqual(rows["Title"], "SAMPLE-LINE-1;SAMPLE-LINE-2(1234)")
            self.assertEqual((rows["Part 1"], rows["Part 2"], rows["Sheet ref"]), ("SAMPLE-LINE-1", "SAMPLE-LINE-2", "1234"))
            self.assertEqual(rows["Layers"], "New Raster 1, Untitled Layer 1")
            self.assertIn("Title: SAMPLE-LINE-1;SAMPLE-LINE-2(1234).", write["text"])
            self.assertEqual(len(write["pictures"]), 4)

    def test_an_smf_past_the_cap_fails_with_a_sentence(self):
        cap = drawing_raster.SMF_MAX_BYTES
        drawing_raster.SMF_MAX_BYTES = 1000
        try:
            for gz in (True, False):
                result, _ = self.run_step(smf_of(sheet_tiff(), gz=gz), "smf")
                self.assertEqual(result["status"], "failed", gz)
                self.assertIn("past the", result["warnings"][0])
        finally:
            drawing_raster.SMF_MAX_BYTES = cap

    def test_a_sliver_of_a_sheet_gives_no_picture_and_still_its_tab(self):
        result, _ = self.run_step(sheet_tiff(w=6000, h=45), "tif")
        write = self.write_of(result)
        self.assertEqual(write["pictures"], [])
        self.assertEqual(self.rows_of(write)["Height px"], "45")

    def test_an_smf_with_another_magic_is_not_mine(self):
        result, _ = self.run_step(gzip.compress(b"NOTSMF" + sheet_tiff()), "smf")
        self.assertEqual(result, {"status": "not_mine"})

    def test_an_hpgl2_plot_gives_its_name_and_pictures(self):
        result, job = self.run_step(HPGL, "000")
        write = self.write_of(result)
        rows = self.rows_of(write)
        self.assertEqual(rows["Format"], "HP-GL/2 plot")
        self.assertEqual(rows["Plot name"], "SAMPLE-PLOT(77).dgn")
        self.assertEqual(rows["Title"], "SAMPLE-PLOT(77)")
        self.assertEqual(rows["Sheet ref"], "77")
        self.assertEqual(rows["Width mm"], "1000")
        self.assertEqual(len(write["pictures"]), 4)
        with Image.open(os.path.join(job, "sheet.png")) as im:
            sheet = np.asarray(im)
        self.assertLess(sheet.min(), 128)

    def test_a_000_that_is_no_plot_is_not_mine(self):
        for data in (
            b"\x1b%-12345X@PJL ENTER LANGUAGE=PCL\r\n\x1bE",  # PCL, not HP-GL/2
            b"INFO 1,2,3\nsome data file\n",
            b"\x00\x01\x02\x03" * 100,
            b"\x1b%0BIN;SP1;",  # HP-GL/2 with nothing drawn
        ):
            result, _ = self.run_step(data, "000")
            self.assertEqual(result, {"status": "not_mine"}, data[:20])

    def test_the_command_line_writes_result_json(self):
        job = tempfile.mkdtemp(prefix="iso-")
        with open(os.path.join(job, "in.bin"), "wb") as f:
            f.write(sheet_tiff(w=800, h=600))
        with open(os.path.join(job, "request.json"), "w") as f:
            json.dump({"step": 1, "file": {"ext": "tif"}}, f)
        subprocess.run([sys.executable, STEP_PY, job], check=True, cwd=job)
        with open(os.path.join(job, "result.json")) as f:
            self.assertEqual(json.load(f)["status"], "ok")


if __name__ == "__main__":
    unittest.main()
