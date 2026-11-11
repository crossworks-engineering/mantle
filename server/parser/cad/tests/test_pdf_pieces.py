"""Tests for the piece cutter (pdf_pieces.py): where the pieces are, how they
are packed, what is left out and how it is stated. Every picture here is
drawn by this test with OpenCV (the repo is public).

Run (stdlib unittest; skipped when OpenCV is missing, unless
PARSER_TESTS_REQUIRE_CAD is set):
    /tmp/dwgvenv/bin/python -m unittest discover -s server/parser/cad/tests -v
"""

from __future__ import annotations

import json
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

    import pdf_pieces

    HAVE_CV = True
except ImportError:  # pragma: no cover - depends on the environment
    if os.environ.get("PARSER_TESTS_REQUIRE_CAD"):
        raise
    HAVE_CV = False

PIECES_PY = os.path.join(os.path.dirname(HERE), "pdf_pieces.py")
# An A4 portrait page at 300 DPI.
W, H, WIDTH_MM = 2480, 3508, 210.0


def blank() -> "np.ndarray":
    return np.full((H, W), 255, np.uint8)


def word(img, text: str, x: int, y: int, scale: float = 1.0) -> None:
    cv2.putText(img, text, (x, y), cv2.FONT_HERSHEY_SIMPLEX, scale, 0, 2, cv2.LINE_AA)


def save(img) -> str:
    fd, path = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    cv2.imwrite(path, img)
    return path


def run(img) -> tuple[dict, list]:
    """One page through read_page: the answer and the packed pictures."""
    path = save(img)
    out = tempfile.mkdtemp()
    try:
        r = pdf_pieces.read_page(path, WIDTH_MM, out)
        pictures = [cv2.imread(os.path.join(out, f"{k}.png"), cv2.IMREAD_GRAYSCALE) for k in range(r["pictures"])]
        return r, pictures
    finally:
        os.unlink(path)
        for name in os.listdir(out):
            os.unlink(os.path.join(out, name))
        os.rmdir(out)


@unittest.skipUnless(HAVE_CV, "OpenCV is not installed")
class PiecesTest(unittest.TestCase):
    def test_each_text_place_is_one_piece_with_its_box_on_the_page(self):
        img = blank()
        spots = [(300, 400), (1500, 400), (300, 2000), (1500, 3000)]
        for x, y in spots:
            word(img, "MADE UP 4 P 1001", x, y)
        # A long ruled line is no text and gives no piece.
        cv2.line(img, (100, 1000), (2300, 1000), 0, 3)
        r, pictures = run(img)
        self.assertTrue(r["ok"])
        self.assertEqual(r["dpi"], 300.0)
        self.assertEqual(len(r["pieces"]), 4)
        self.assertEqual(r["not_sent"], [])
        self.assertEqual(r["pictures"], 1)
        self.assertEqual(pictures[0].shape, (pdf_pieces.PICTURE_SIDE, pdf_pieces.PICTURE_SIDE))
        # In reading order, and each box holds the text it was drawn at.
        for piece, (x, y) in zip(r["pieces"], spots):
            x0, y0, x1, y1 = piece["box"]
            self.assertTrue(0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1)
            self.assertTrue(x0 * W <= x + 10 and x1 * W >= x + 250)
            self.assertTrue(y0 * H <= y - 20 and y1 * H >= y)
            self.assertEqual(piece["scale"], 1.0)
            self.assertEqual(piece["picture"], 0)

    def test_the_packed_picture_holds_the_pixels_of_each_piece_at_full_size(self):
        img = blank()
        word(img, "FT 1001", 400, 500)
        word(img, "PSV 0012", 400, 2500)
        r, pictures = run(img)
        ink_page = int(np.count_nonzero(img < 128))
        ink_packed = int(np.count_nonzero(pictures[0] < 128))
        # The letters, and the two number labels on top of them.
        self.assertGreaterEqual(ink_packed, ink_page)
        self.assertLess(ink_packed, ink_page * 1.5)

    def test_text_that_is_near_is_one_piece_and_text_that_is_far_is_two(self):
        img = blank()
        word(img, "ONE", 300, 500)
        word(img, "LINE", 385, 500)  # under 2 mm from the first
        word(img, "FAR", 1800, 500)
        r, _ = run(img)
        self.assertEqual(len(r["pieces"]), 2)

    def test_many_pieces_go_into_more_pictures_and_never_more_than_four(self):
        img = blank()
        n = 0
        for row in range(60):
            for col in range(4):
                word(img, f"TAG {n:04d} MADE UP", 80 + col * 600, 80 + row * 56, 0.9)
                n += 1
        r, pictures = run(img)
        self.assertGreater(len(r["pieces"]), 100)
        self.assertGreater(r["pictures"], 1)
        self.assertLessEqual(r["pictures"], pdf_pieces.MAX_PICTURES)
        self.assertEqual(len(pictures), r["pictures"])
        # Every piece is packed or stated: nothing is lost.
        self.assertLessEqual(max(p["picture"] for p in r["pieces"]), r["pictures"] - 1)
        self.assertTrue(all(pdf_pieces.MIN_SCALE <= p["scale"] <= 1 for p in r["pieces"]))

    def test_what_does_not_fit_is_stated_as_not_sent(self):
        img = blank()
        word(img, "A", 100, 100)
        boxes = [(10 + (i % 40) * 60, 10 + (i // 40) * 60, 50, 50) for i in range(pdf_pieces.MAX_PIECES + 7)]
        pictures, packed, left_out = pdf_pieces.pack(img, boxes)
        self.assertEqual(len(packed) + len(left_out), len(boxes))
        self.assertGreaterEqual(len(left_out), 7)
        self.assertLessEqual(len(pictures), pdf_pieces.MAX_PICTURES)
        # With room for one picture only, the last pieces are left out.
        big = [(0, 0, 700, 700)] * 30
        pictures, packed, left_out = pdf_pieces.pack(img, big, max_pictures=1)
        self.assertEqual(len(pictures), 1)
        self.assertEqual(len(packed) + len(left_out), 30)
        self.assertGreater(len(left_out), 0)
        self.assertEqual(sorted(left_out), left_out)
        self.assertTrue(all(p["scale"] >= pdf_pieces.MIN_SCALE for p in packed))

    def test_a_piece_larger_than_a_picture_is_made_to_fit_by_itself(self):
        img = blank()
        pictures, packed, left_out = pdf_pieces.pack(img, [(0, 0, 2400, 300), (0, 400, 200, 60)])
        self.assertEqual(left_out, [])
        self.assertLess(packed[0]["scale"], 1.0)
        self.assertEqual(packed[1]["scale"], 1.0)

    def test_a_white_page_is_refused_and_a_page_with_no_text_gives_no_picture(self):
        path = save(blank())
        out = tempfile.mkdtemp()
        try:
            with self.assertRaises(pdf_pieces.pdf_eye.EyeError) as ctx:
                pdf_pieces.read_page(path, WIDTH_MM, out)
            self.assertEqual(ctx.exception.code, "empty")
        finally:
            os.unlink(path)
            os.rmdir(out)
        img = blank()
        cv2.line(img, (100, 1000), (2300, 1000), 0, 3)
        r, pictures = run(img)
        self.assertEqual((r["pieces"], r["pictures"], pictures), ([], 0, []))


@unittest.skipUnless(HAVE_CV, "OpenCV is not installed")
class CommandLineTest(unittest.TestCase):
    def test_the_command_writes_the_pictures_and_the_answer(self):
        img = blank()
        word(img, "MADE UP", 300, 400)
        path = save(img)
        out = tempfile.mkdtemp()
        try:
            done = subprocess.run([sys.executable, PIECES_PY, path, str(WIDTH_MM), out], capture_output=True, timeout=120)
            self.assertEqual(done.returncode, 0)
            with open(os.path.join(out, "pieces.json"), encoding="utf-8") as fh:
                r = json.load(fh)
            self.assertTrue(r["ok"])
            self.assertEqual(len(r["pieces"]), 1)
            self.assertTrue(os.path.exists(os.path.join(out, "0.png")))
        finally:
            os.unlink(path)
            for name in os.listdir(out):
                os.unlink(os.path.join(out, name))
            os.rmdir(out)

    def test_a_refusal_is_an_answer_with_exit_0(self):
        path = save(blank())
        out = tempfile.mkdtemp()
        try:
            done = subprocess.run([sys.executable, PIECES_PY, path, str(WIDTH_MM), out], capture_output=True, timeout=120)
            self.assertEqual(done.returncode, 0)
            with open(os.path.join(out, "pieces.json"), encoding="utf-8") as fh:
                self.assertEqual(json.load(fh), {"ok": False, "code": "empty"})
        finally:
            os.unlink(path)
            for name in os.listdir(out):
                os.unlink(os.path.join(out, name))
            os.rmdir(out)


if __name__ == "__main__":
    unittest.main()
