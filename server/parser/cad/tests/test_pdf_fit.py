"""Tests for pdf_fit.py: one page of a PDF drawn again as a smaller
one-page PDF that one Scan reader call may send. Every PDF here is made up
by this test (the repo is public): an A0-size page holding one 300 dpi grey
scan of noise and lines, about 114 M pixels and past 10 MB, as a large
scanned drawing is.

Run (stdlib unittest; skipped when pypdfium2 or Pillow is missing, unless
PARSER_TESTS_REQUIRE_CAD is set):
    /opt/cad/bin/python -m unittest discover -s server/parser/cad/tests -v
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

try:
    import numpy as np
    import pypdfium2 as pdfium
    from PIL import Image

    import pdf_fit

    HAVE = True
except ImportError:  # pragma: no cover - depends on the environment
    if os.environ.get("PARSER_TESTS_REQUIRE_CAD"):
        raise
    HAVE = False

SCRIPT = os.path.join(os.path.dirname(HERE), "pdf_fit.py")
TEN_MB = 10 * 1024 * 1024
# The page of the large scans this was made for: 2160 x 3035 pt.
A0_DPI = 300
A0_PX = (9000, 12646)


def scan_pdf(path, size_px, dpi, seed=1):
    """A one-page PDF of one grey JPEG: noise (a scanner's grain, which a
    JPEG cannot pack small) with dark lines over it."""
    rng = np.random.default_rng(seed)
    w, h = size_px
    arr = rng.integers(170, 256, size=(h, w), dtype=np.uint8)
    for y in range(400, h - 400, 600):
        arr[y : y + 6, 300 : w - 300] = 20
    for x in range(400, w - 400, 900):
        arr[300 : h - 300, x : x + 6] = 20
    Image.fromarray(arr, "L").save(path, "PDF", resolution=dpi, quality=92)


def page_of(path):
    pdf = pdfium.PdfDocument(path)
    try:
        w, h = pdf[0].get_size()
        return len(pdf), w, h
    finally:
        pdf.close()


@unittest.skipUnless(HAVE, "pypdfium2 or Pillow missing")
class FitLargeScan(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp(prefix="pdf-fit-")
        cls.src = os.path.join(cls.dir, "a0.pdf")
        scan_pdf(cls.src, A0_PX, A0_DPI)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir, ignore_errors=True)

    def test_the_made_up_scan_is_the_case(self):
        # Past what one call may send, and its picture past the 75 M pixels
        # pdfjs decodes (PDF_MAX_IMAGE_PIXELS): the page as cut is unread.
        self.assertGreater(os.path.getsize(self.src), TEN_MB)
        self.assertGreater(A0_PX[0] * A0_PX[1], pdf_fit.MAX_PIXELS)
        n, w, h = page_of(self.src)
        self.assertEqual(n, 1)
        self.assertAlmostEqual(w, 2160, delta=1)
        self.assertAlmostEqual(h, 3035, delta=1)

    def test_drawn_again_under_both_limits_same_size_on_paper(self):
        out = os.path.join(self.dir, "fit.pdf")
        r = pdf_fit.fit(self.src, out, TEN_MB)
        self.assertIsNotNone(r["dpi"])
        self.assertLess(r["dpi"], A0_DPI)
        self.assertGreaterEqual(r["dpi"], pdf_fit.MIN_DPI)
        self.assertLessEqual(r["bytes"], TEN_MB)
        self.assertEqual(os.path.getsize(out), r["bytes"])
        self.assertLessEqual(r["width_px"] * r["height_px"], pdf_fit.MAX_PIXELS)
        with open(out, "rb") as f:
            self.assertEqual(f.read(5), b"%PDF-")
        n, w, h = page_of(out)
        self.assertEqual(n, 1)
        self.assertAlmostEqual(w, 2160, delta=2)
        self.assertAlmostEqual(h, 3035, delta=2)
        # The dots an inch it says are those of its picture on that page.
        self.assertAlmostEqual(r["width_px"] / (w / 72.0), r["dpi"], delta=1)

    def test_no_fit_writes_nothing_and_says_so(self):
        out = os.path.join(self.dir, "none.pdf")
        self.assertEqual(pdf_fit.fit(self.src, out, 1000), {"dpi": None})
        self.assertFalse(os.path.exists(out))

    def test_the_script_prints_one_json_line(self):
        out = os.path.join(self.dir, "cli.pdf")
        done = subprocess.run(
            [sys.executable, SCRIPT, self.src, out, str(TEN_MB)],
            capture_output=True,
            text=True,
            check=True,
        )
        r = json.loads(done.stdout.strip())
        self.assertLessEqual(r["bytes"], TEN_MB)
        self.assertTrue(os.path.exists(out))


@unittest.skipUnless(HAVE, "pypdfium2 or Pillow missing")
class FitSmallPage(unittest.TestCase):
    def test_a_small_page_that_fits_keeps_300_dpi(self):
        d = tempfile.mkdtemp(prefix="pdf-fit-")
        try:
            src = os.path.join(d, "a4.pdf")
            scan_pdf(src, (1240, 1754), 150)
            out = os.path.join(d, "fit.pdf")
            r = pdf_fit.fit(src, out, TEN_MB)
            self.assertEqual(r["dpi"], 300.0)
            n, w, h = page_of(out)
            self.assertEqual(n, 1)
            self.assertAlmostEqual(w, 1240 / 150 * 72, delta=1)
        finally:
            shutil.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
