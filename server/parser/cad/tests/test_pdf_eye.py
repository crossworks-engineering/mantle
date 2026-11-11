"""Tests for the picture reader (pdf_eye.py): the axes of the long lines, the
skew, the text areas, the pixel limit and the command line. Every picture
here is drawn by this test with OpenCV (the repo is public).

Run (stdlib unittest; skipped when OpenCV is missing, unless
PARSER_TESTS_REQUIRE_CAD is set):
    /tmp/dwgvenv/bin/python -m unittest discover -s server/parser/cad/tests -v
"""

from __future__ import annotations

import json
import math
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

try:
    import cv2
    import numpy as np

    import pdf_eye

    HAVE_CV = True
except ImportError:  # pragma: no cover - depends on the environment
    if os.environ.get("PARSER_TESTS_REQUIRE_CAD"):
        raise
    HAVE_CV = False

EYE_PY = os.path.join(os.path.dirname(HERE), "pdf_eye.py")
# An A4 landscape page at about 144 DPI.
W, H, WIDTH_MM = 1684, 1190, 297.0
PX_MM = W / WIDTH_MM


def blank() -> "np.ndarray":
    return np.full((H, W), 255, np.uint8)


def line(img, x0: float, y0: float, length_mm: float, deg: float, thick: int = 2) -> None:
    """A line from (x0, y0) px, `length_mm` long, at `deg` counterclockwise."""
    rad = math.radians(deg)
    x1 = x0 + math.cos(rad) * length_mm * PX_MM
    y1 = y0 - math.sin(rad) * length_mm * PX_MM
    cv2.line(img, (int(round(x0)), int(round(y0))), (int(round(x1)), int(round(y1))), 0, thick, cv2.LINE_AA)


def words(img, x: int, y: int, rows: int = 3) -> None:
    """A block of small text."""
    for r in range(rows):
        cv2.putText(
            img, "LINE 4 P 1001 A1B", (x, y + r * 22), cv2.FONT_HERSHEY_SIMPLEX, 0.5, 0, 1, cv2.LINE_AA
        )


def save(img) -> str:
    fd, path = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    cv2.imwrite(path, img)
    return path


@unittest.skipUnless(HAVE_CV, "OpenCV is not installed")
class AxesTest(unittest.TestCase):
    def read(self, img, **kw) -> dict:
        path = save(img)
        try:
            return pdf_eye.read_picture(path, WIDTH_MM, **kw)
        finally:
            os.unlink(path)

    def test_a_ruled_form_is_horizontal_and_vertical(self):
        img = blank()
        for i in range(8):
            line(img, 100, 150 + i * 100, 250, 0)
        for i in range(6):
            line(img, 100 + i * 280, 1000, 150, 90)
        r = self.read(img)
        self.assertTrue(r["ok"])
        self.assertGreater(r["axes"]["h"], 0.55)
        self.assertGreater(r["axes"]["v"], 0.2)
        self.assertLess(r["axes"]["iso"], 0.02)
        self.assertLess(r["axes"]["other"], 0.05)
        # 8 x 250 + 6 x 150 = 2,900 mm of line; LSD finds both edges of each.
        self.assertGreater(r["axes"]["longMm"], 2900)
        self.assertLess(r["axes"]["longMm"], 2 * 2900 * 1.15)
        self.assertEqual(r["dpi"], round(PX_MM * 25.4, 1))

    def test_isometric_lines_land_on_the_isometric_axes(self):
        img = blank()
        for i in range(5):
            line(img, 200 + i * 120, 900, 120, 30)
            line(img, 1500 - i * 120, 900, 120, 150)
        for i in range(3):
            line(img, 400 + i * 300, 1100, 80, 90)
        r = self.read(img)
        self.assertGreater(r["axes"]["iso"], 0.7)
        self.assertGreater(r["axes"]["iso"], r["axes"]["other"])
        self.assertLess(r["axes"]["h"], 0.05)

    def test_lines_at_45_degrees_are_other_not_isometric(self):
        img = blank()
        for i in range(6):
            line(img, 200 + i * 150, 900, 120, 45)
        r = self.read(img)
        self.assertGreater(r["axes"]["other"], 0.9)
        self.assertLess(r["axes"]["iso"], 0.05)

    def test_short_strokes_do_not_vote(self):
        img = blank()
        for i in range(200):
            line(img, 50 + (i % 40) * 40, 100 + (i // 40) * 40, 2.0, 45, 1)
        r = self.read(img)
        self.assertEqual(r["axes"]["longMm"], 0)
        self.assertEqual(r["axes"]["other"], 0.0)

    def test_a_small_tilt_is_measured_and_taken_off(self):
        img = blank()
        for i in range(8):
            line(img, 100, 150 + i * 100, 250, 1.5)
        for i in range(6):
            line(img, 150 + i * 250, 1050, 150, 91.5)
        r = self.read(img)
        self.assertAlmostEqual(r["skew_deg"], 1.5, delta=0.3)
        self.assertGreater(r["axes"]["h"], 0.5)
        self.assertGreater(r["axes"]["v"], 0.2)

    def test_a_drawing_with_no_frame_is_not_called_tilted(self):
        # All lines at 30 degrees fold to 30, past MAX_SKEW_DEG: no skew.
        img = blank()
        for i in range(6):
            line(img, 200 + i * 150, 900, 120, 30)
        r = self.read(img)
        self.assertEqual(r["skew_deg"], 0.0)
        self.assertGreater(r["axes"]["iso"], 0.9)

    def test_a_picture_with_no_ink_is_refused(self):
        # A white picture is a white page or a page whose image did not draw:
        # it must not be read as "a page with no lines".
        with self.assertRaises(pdf_eye.EyeError) as ctx:
            self.read(blank())
        self.assertEqual(ctx.exception.code, "empty")

    def test_a_page_with_one_short_mark_is_read(self):
        img = blank()
        cv2.circle(img, (100, 100), 3, 0, -1)
        r = self.read(img)
        self.assertEqual(r["axes"], {"h": 0.0, "v": 0.0, "iso": 0.0, "other": 0.0, "longMm": 0})
        self.assertEqual(r["skew_deg"], 0.0)
        self.assertTrue(r["ok"])


@unittest.skipUnless(HAVE_CV, "OpenCV is not installed")
class AreasAndSegmentsTest(unittest.TestCase):
    def test_text_areas_hold_the_text_and_not_the_ruled_lines(self):
        img = blank()
        line(img, 100, 600, 250, 0)
        line(img, 100, 100, 150, -90)
        words(img, 300, 200)
        words(img, 1100, 800)
        path = save(img)
        try:
            r = pdf_eye.read_picture(path, WIDTH_MM, want_areas=True, want_segments=True)
        finally:
            os.unlink(path)
        self.assertEqual(r["text_areas"], len(r["areas"]))
        self.assertGreaterEqual(r["text_areas"], 2)
        for x0, y0, x1, y1 in r["areas"]:
            self.assertTrue(0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1)
        # Every area lies in one of the two text blocks (with a margin).
        blocks = [(300, 180, 520, 260), (1100, 780, 1320, 860)]

        def inside(a) -> bool:
            cx, cy = (a[0] + a[2]) / 2 * W, (a[1] + a[3]) / 2 * H
            return any(bx0 - 30 <= cx <= bx1 + 30 and by0 - 30 <= cy <= by1 + 30 for bx0, by0, bx1, by1 in blocks)

        self.assertTrue(all(inside(a) for a in r["areas"]))
        # The segments are in page fractions, and hold the long ruled line.
        self.assertTrue(all(0 <= v <= 1 for s in r["segments"] for v in s))
        longest = max(abs(s[2] - s[0]) * WIDTH_MM for s in r["segments"])
        self.assertGreater(longest, 200)

    def test_the_result_has_no_areas_or_segments_unless_asked(self):
        img = blank()
        cv2.circle(img, (100, 100), 3, 0, -1)
        path = save(img)
        try:
            r = pdf_eye.read_picture(path, WIDTH_MM)
        finally:
            os.unlink(path)
        self.assertNotIn("areas", r)
        self.assertNotIn("segments", r)


@unittest.skipUnless(HAVE_CV, "OpenCV is not installed")
class LimitsTest(unittest.TestCase):
    def test_a_picture_over_the_pixel_limit_is_refused(self):
        old = pdf_eye.MAX_PIXELS
        pdf_eye.MAX_PIXELS = 1000
        path = save(blank())
        try:
            with self.assertRaises(pdf_eye.EyeError) as ctx:
                pdf_eye.read_picture(path, WIDTH_MM)
            self.assertEqual(ctx.exception.code, "too_large")
        finally:
            pdf_eye.MAX_PIXELS = old
            os.unlink(path)

    def test_a_png_over_the_limit_is_refused_from_its_header_with_no_decode(self):
        # A header that declares 100,000 x 100,000 pixels, and no pixel data:
        # a decode would fail as unreadable, so too_large proves it was not tried.
        import struct
        import zlib

        ihdr = struct.pack(">IIBBBBB", 100_000, 100_000, 8, 0, 0, 0, 0)
        chunk = struct.pack(">I", len(ihdr)) + b"IHDR" + ihdr + struct.pack(">I", zlib.crc32(b"IHDR" + ihdr))
        fd, path = tempfile.mkstemp(suffix=".png")
        os.write(fd, b"\x89PNG\r\n\x1a\n" + chunk)
        os.close(fd)
        try:
            self.assertEqual(pdf_eye.png_size(path), (100_000, 100_000))
            with self.assertRaises(pdf_eye.EyeError) as ctx:
                pdf_eye.read_picture(path, WIDTH_MM)
            self.assertEqual(ctx.exception.code, "too_large")
        finally:
            os.unlink(path)

    def test_a_file_that_is_no_picture_and_a_bad_width(self):
        fd, path = tempfile.mkstemp(suffix=".png")
        os.write(fd, b"not a picture")
        os.close(fd)
        try:
            with self.assertRaises(pdf_eye.EyeError) as ctx:
                pdf_eye.read_picture(path, WIDTH_MM)
            self.assertEqual(ctx.exception.code, "unreadable")
            for width in (0.0, -5.0, float("nan"), float("inf")):
                with self.assertRaises(pdf_eye.EyeError) as bad:
                    pdf_eye.read_picture(path, width)
                self.assertEqual(bad.exception.code, "bad_size")
        finally:
            os.unlink(path)


@unittest.skipUnless(HAVE_CV, "OpenCV is not installed")
class CommandLineTest(unittest.TestCase):
    def run_eye(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, EYE_PY, *args], capture_output=True, text=True, timeout=120)

    def test_writes_the_answer_to_the_out_file(self):
        img = blank()
        for i in range(8):
            line(img, 100, 150 + i * 100, 250, 0)
        path = save(img)
        out = path + ".json"
        try:
            done = self.run_eye(path, str(WIDTH_MM), "--out", out, "--threads", "1")
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(done.stdout, "")
            with open(out, encoding="utf-8") as fh:
                r = json.load(fh)
            self.assertTrue(r["ok"])
            self.assertGreater(r["axes"]["h"], 0.9)
        finally:
            os.unlink(path)
            if os.path.exists(out):
                os.unlink(out)

    def test_a_refusal_is_an_answer_with_exit_0(self):
        fd, path = tempfile.mkstemp(suffix=".png")
        os.write(fd, b"not a picture")
        os.close(fd)
        try:
            done = self.run_eye(path, "297")
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(json.loads(done.stdout), {"ok": False, "code": "unreadable"})
            bad = self.run_eye(path, "wide")
            self.assertEqual(json.loads(bad.stdout), {"ok": False, "code": "bad_request"})
            self.assertEqual(self.run_eye().returncode, 2)
        finally:
            os.unlink(path)


if __name__ == "__main__":
    unittest.main()
