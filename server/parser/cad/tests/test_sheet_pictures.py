"""Tests for the sheet pictures (sheet_pictures.py): a 1-bit TIFF, an
Imagenation SMF raster and an HP-GL/2 plot, each cut into gray pictures,
and the files that are none of them. Every file here is made by this test
(the repo is public).

Run (stdlib unittest; skipped when a library is missing, unless
PARSER_TESTS_REQUIRE_CAD is set):
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
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

try:
    import cv2  # noqa: F401 (the plot pictures need it)
    import ezdxf  # noqa: F401 (the plot reader needs it)
    import numpy as np
    from PIL import Image, ImageDraw

    import sheet_pictures

    HAVE_LIBS = True
except ImportError:  # pragma: no cover - depends on the environment
    if os.environ.get("PARSER_TESTS_REQUIRE_CAD"):
        raise
    HAVE_LIBS = False

SCRIPT = os.path.join(os.path.dirname(HERE), "sheet_pictures.py")
# A sheet of 400 x 200 mm at 200 dots an inch, with a filled box in its
# right fifth and a thin line across its left half.
W, H, DPI = 3150, 1575, 200
SPEC = [
    {"file": "sheet.png", "part": [0, 0, 1, 1], "maxSide": 1000, "dpiCap": None},
    {"file": "right-side.png", "part": [0.8, 0, 1, 1], "maxSide": 4000, "dpiCap": 100},
]


def tiff_bytes(mode: str = "1") -> bytes:
    img = Image.new(mode, (W, H), 1 if mode == "1" else 255)
    draw = ImageDraw.Draw(img)
    draw.rectangle([2700, 600, 3000, 900], fill=0)
    draw.line([100, 300, 1400, 300], fill=0, width=1)
    out = io.BytesIO()
    if mode == "1":
        img.save(out, format="TIFF", compression="group4", dpi=(DPI, DPI))
    else:
        img.save(out, format="TIFF", dpi=(DPI, DPI))
    return out.getvalue()


def claimed_tiff_bytes(width: int, height: int) -> bytes:
    """A tiny 1-bit TIFF, written by hand, whose header claims this size.
    It holds one byte of pixels."""
    tags = [
        (256, 4, width),  # ImageWidth
        (257, 4, height),  # ImageLength
        (258, 3, 1),  # BitsPerSample
        (259, 3, 1),  # Compression: none
        (262, 3, 0),  # Photometric: min is white
        (273, 4, 8 + 2 + 9 * 12 + 4),  # StripOffsets: right after the tags
        (277, 3, 1),  # SamplesPerPixel
        (278, 4, height),  # RowsPerStrip
        (279, 4, 1),  # StripByteCounts
    ]
    ifd = struct.pack("<H", len(tags))
    for tag, kind, value in tags:
        ifd += struct.pack("<HHI", tag, kind, 1)
        ifd += struct.pack("<I", value) if kind == 4 else struct.pack("<HH", value, 0)
    return b"II*\x00" + struct.pack("<I", 8) + ifd + struct.pack("<I", 0) + b"\x00"


def run(data: bytes, ext: str, spec=SPEC):
    """Run the command on made-up bytes: the reply and the folder's pictures."""
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "in.bin")
        outdir = os.path.join(tmp, "out")
        os.mkdir(outdir)
        with open(src, "wb") as f:
            f.write(data)
        spec_path = os.path.join(tmp, "spec.json")
        with open(spec_path, "w", encoding="utf-8") as f:
            json.dump(spec, f)
        done = subprocess.run(
            [sys.executable, SCRIPT, src, ext, outdir, spec_path],
            capture_output=True,
            text=True,
            timeout=120,
        )
        if done.returncode != 0:
            raise AssertionError(done.stderr)
        with open(os.path.join(outdir, "sheet-pictures.json"), encoding="utf-8") as f:
            reply = json.load(f)
        pictures = {}
        for name in sorted(os.listdir(outdir)):
            if name.endswith(".png"):
                with Image.open(os.path.join(outdir, name)) as im:
                    pictures[name] = (im.mode, np.asarray(im).copy())
        # Nothing but the reply and the pictures stays in the folder.
        left = sorted(n for n in os.listdir(outdir) if not n.endswith(".png"))
        return reply, pictures, left


@unittest.skipUnless(HAVE_LIBS, "Pillow, OpenCV or ezdxf is not installed")
class RasterTest(unittest.TestCase):
    def check_raster(self, reply, pictures, fmt):
        self.assertEqual(reply["ok"], True)
        self.assertEqual(reply["format"], fmt)
        self.assertAlmostEqual(reply["widthMm"], 400.0, delta=0.5)
        self.assertAlmostEqual(reply["heightMm"], 200.0, delta=0.5)
        self.assertEqual(reply["pictures"], ["sheet.png", "right-side.png"])
        mode, sheet = pictures["sheet.png"]
        self.assertEqual(mode, "L")
        self.assertEqual(sheet.dtype, np.uint8)
        # The longest side is at most the one asked for, and near it.
        self.assertLessEqual(max(sheet.shape), 1000)
        self.assertGreater(max(sheet.shape), 700)
        self.assertAlmostEqual(sheet.shape[1] / sheet.shape[0], W / H, delta=0.02)
        # The box is black where it was drawn, the paper white beside it.
        f = W / sheet.shape[1]
        self.assertLess(sheet[int(750 / f), int(2850 / f)], 10)
        self.assertGreater(sheet[int(200 / f), int(2000 / f)], 245)
        # A line one pixel wide is still seen in the small picture.
        self.assertLess(sheet[int(300 / f) - 1 : int(300 / f) + 2, int(700 / f)].min(), 250)
        # The right side: a fifth of the width, at 100 dots an inch at most.
        mode, right = pictures["right-side.png"]
        self.assertEqual(mode, "L")
        self.assertAlmostEqual(right.shape[0], H / 2, delta=2)
        self.assertAlmostEqual(right.shape[1], W * 0.2 / 2, delta=6)
        self.assertLess(right.min(), 10)
        self.assertGreater(right.max(), 245)

    def test_a_one_bit_tiff_gives_both_pictures(self):
        reply, pictures, left = run(tiff_bytes(), "tif")
        self.check_raster(reply, pictures, "TIFF raster")
        self.assertEqual(left, ["sheet-pictures.json"])
        reply, pictures, _ = run(tiff_bytes(), "TIFF")
        self.check_raster(reply, pictures, "TIFF raster")

    def test_an_smf_holds_one_tiff_gzip_or_not(self):
        smf = sheet_pictures.SMF_MAGIC + b"\x00\x01\xb0made-up title\x00" + b"\x00" * 64 + tiff_bytes()
        for data in (smf, gzip.compress(smf)):
            reply, pictures, left = run(data, "smf")
            self.check_raster(reply, pictures, "Imagenation SMF raster")
            self.assertEqual(left, ["sheet-pictures.json"])

    def test_files_that_are_not_mine(self):
        not_mine = {"ok": False, "notMine": True}
        cases = [
            (b"not a tiff at all", "tif"),
            (tiff_bytes("L"), "tif"),  # 8 bit gray: not a 1-bit raster
            (tiff_bytes(), "smf"),  # no Imagenation magic
            (b"\x1f\x8b broken gzip", "smf"),
            (gzip.compress(b"other bytes"), "smf"),
            (sheet_pictures.SMF_MAGIC + b"no raster inside", "smf"),
            (b"plain words, no plot", "000"),
            (tiff_bytes(), "png"),
        ]
        for data, ext in cases:
            reply, pictures, _ = run(data, ext)
            self.assertEqual(reply, not_mine, ext)
            self.assertEqual(pictures, {})

    def test_an_smf_past_the_gunzip_cap_is_not_mine(self):
        data = gzip.compress(sheet_pictures.SMF_MAGIC + b"\x00" * sheet_pictures.SMF_MAX_BYTES)
        reply, pictures, _ = run(data, "smf")
        self.assertEqual(reply, {"ok": False, "notMine": True})
        self.assertEqual(pictures, {})

    def test_a_raster_that_claims_too_many_pixels_is_not_mine(self):
        # 90 gigapixels in the header, one byte in the file: refused at the
        # header, before a buffer of 11 GB is made or libtiff reads a strip.
        data = claimed_tiff_bytes(300000, 300000)
        self.assertLess(len(data), 200)
        for ext, sent in (("tif", data), ("smf", sheet_pictures.SMF_MAGIC + b"\x00" * 16 + data)):
            start = time.monotonic()
            reply, pictures, left = run(sent, ext)
            self.assertEqual(reply, {"ok": False, "notMine": True}, ext)
            self.assertEqual(pictures, {})
            self.assertEqual(left, ["sheet-pictures.json"])
            self.assertLess(time.monotonic() - start, 20)

    def test_a_picture_name_stays_in_the_folder(self):
        spec = [{"file": "../escaped.png", "part": [0, 0, 1, 1], "maxSide": 300, "dpiCap": None}]
        reply, pictures, _ = run(tiff_bytes(), "tif", spec)
        self.assertEqual(reply["pictures"], ["escaped.png"])
        self.assertEqual(list(pictures), ["escaped.png"])


@unittest.skipUnless(HAVE_LIBS, "Pillow, OpenCV or ezdxf is not installed")
class PlotTest(unittest.TestCase):
    # A frame of 400 x 200 mm (16000 x 8000 plot units) with one line in its
    # right fifth.
    PLOT = (
        b"\x1b%-1BIN;SP1;PW0.35;"
        b"PU0,0;PD16000,0,16000,8000,0,8000,0,0;"
        b"PU14000,1000;PD14000,7000;PU;"
    )

    def test_an_hpgl_plot_gives_both_pictures(self):
        reply, pictures, left = run(self.PLOT, "000")
        self.assertEqual(reply["ok"], True)
        self.assertEqual(reply["format"], "HP-GL/2 plot")
        self.assertAlmostEqual(reply["widthMm"], 400.0, delta=1.0)
        self.assertAlmostEqual(reply["heightMm"], 200.0, delta=1.0)
        self.assertEqual(reply["pictures"], ["sheet.png", "right-side.png"])
        self.assertEqual(left, ["sheet-pictures.json"])
        mode, sheet = pictures["sheet.png"]
        self.assertEqual(mode, "L")
        self.assertAlmostEqual(max(sheet.shape), 1000, delta=2)
        self.assertAlmostEqual(sheet.shape[1] / sheet.shape[0], 2.0, delta=0.02)
        # The line is at 7/8 of the width, and the middle of the sheet is paper.
        x = int(sheet.shape[1] * 14000 / 16000)
        self.assertLess(sheet[sheet.shape[0] // 2, x - 2 : x + 3].min(), 128)
        self.assertGreater(sheet[sheet.shape[0] // 2, sheet.shape[1] // 2], 245)
        # The right side at 100 dots an inch: 80 x 200 mm.
        _, right = pictures["right-side.png"]
        self.assertAlmostEqual(right.shape[1], 80 / 25.4 * 100, delta=3)
        self.assertAlmostEqual(right.shape[0], 200 / 25.4 * 100, delta=3)
        self.assertLess(right.min(), 128)


if __name__ == "__main__":
    unittest.main()
