"""Tests for the built-in Reader pdf-pages (pdf_pages.py): the text layer,
Tesseract on scanned pages, the tables (ruled, on several pages, with no ruled
lines), the Tables index, the page pictures of vision pages (G1) and the
windows. Every PDF here is made up by this test (book_pdfs.py; the repo is
public).

Run (stdlib unittest; skipped when pdfplumber, pypdfium2 or OpenCV is
missing, unless PARSER_TESTS_REQUIRE_CAD is set; the OCR cases skip when
the `tesseract` program is missing, unless PARSER_TESTS_REQUIRE_OCR is set):
    /opt/cad/bin/python -m unittest discover -s server/parser/cad/tests -v
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

try:
    import cv2  # noqa: F401
    import pdfplumber  # noqa: F401
    import pypdfium2  # noqa: F401
    from PIL import Image

    import book_pdfs
    import pdf_pages

    HAVE = True
except ImportError:  # pragma: no cover - depends on the environment
    if os.environ.get("PARSER_TESTS_REQUIRE_CAD"):
        raise
    HAVE = False

HAVE_OCR = shutil.which("tesseract") is not None
if not HAVE_OCR and os.environ.get("PARSER_TESTS_REQUIRE_OCR"):  # pragma: no cover
    raise RuntimeError("PARSER_TESTS_REQUIRE_OCR is set and tesseract is missing")

STEP_PY = os.path.join(os.path.dirname(HERE), "pdf_pages.py")


def run(pdf, request=None, job=None):
    job = job or tempfile.mkdtemp(prefix="pdf-pages-")
    req = {"api": 1, "step": 1, "file": {"name": "book.pdf", "ext": "pdf", "size": 0, "sha256": "0" * 64},
           "options": {}, "kind": "book"}
    req.update(request or {})
    return pdf_pages.step(req, pdf, job), job


def tabs_of(result):
    call = result["calls"][0]
    assert call["tool"] == "file_tabs_write"
    return {t["name"]: t for t in call["input"]["tabs"]}, call["input"]


def norm(s):
    return re.sub(r"\s+", " ", str(s)).strip().upper()


def score(tab, truth):
    """Cells right of the truth rows, by position, and the rows whose Page is right."""
    good = total = pages_ok = 0
    for i, want in enumerate(truth["rows"]):
        got = tab["rows"][i] if i < len(tab["rows"]) else [None] * len(want)
        pages_ok += got[0] == want[0]
        for a, b in zip(got[1:], want[1:]):
            total += 1
            good += norm(a) == norm(b)
    return good / max(1, total), pages_ok


@unittest.skipUnless(HAVE, "pdfplumber, pypdfium2 or OpenCV is missing")
class PureParts(unittest.TestCase):
    def test_paper(self):
        self.assertEqual(pdf_pages.paper_of(210, 297), "A4")
        self.assertEqual(pdf_pages.paper_of(297, 210), "A4")
        self.assertEqual(pdf_pages.paper_of(215.9, 279.4), "Letter")
        self.assertEqual(pdf_pages.paper_of(420, 297), "A3")
        self.assertEqual(pdf_pages.paper_of(500, 300), "500 x 300 mm")

    def test_header_key(self):
        self.assertEqual(pdf_pages.norm_header(["Item", " Size.", None]), pdf_pages.norm_header(["ITEM", "size", ""]))
        self.assertNotEqual(pdf_pages.norm_header(["ITEM", "SIZE"]), pdf_pages.norm_header(["ITEM", "RATING"]))

    def test_column_names(self):
        self.assertEqual(pdf_pages.column_names(["Page", "", "A", "a"]), ["Page (2)", "Column 2", "A", "a (2)"])

    def test_rules_version_matches_the_core(self):
        src = open(os.path.join(HERE, "..", "..", "..", "..", "packages", "files", "src", "pdf-drawing-sheets.ts")).read()
        m = re.search(r"export const PDF_KIND_RULES_VERSION = (\d+);", src)
        self.assertEqual(int(m.group(1)), pdf_pages.PDF_KIND_RULES_VERSION)

    def _t(self, rows, edges, to_bottom=True, title=None, heading=None):
        return {"rows": rows, "confs": [[None] * len(rows[0]) for _ in rows], "edges": edges, "top": 0,
                "bottom": 1, "page": 0, "to_bottom": to_bottom, "method": "text", "heading": heading,
                "title": title, "odd": 0}

    def test_join_by_header_by_edges_and_a_new_title(self):
        e = [0.1, 0.4, 0.7, 0.9]
        t = pdf_pages.Tables(None)
        t.page(1, [self._t([["A", "B", "C"], ["1", "2", "3"]], e, title="SPEC X", heading="SPEC X")], 70)
        t.page(2, [self._t([["A", "B", "C"], ["4", "5", "6"]], e, title="SPEC X")], 70)  # same header
        t.page(3, [self._t([["7", "8", "9"], ["10", "11", "12"]], [x + 0.01 for x in e])], 70)  # edges
        t.page(4, [self._t([["A", "B", "C"], ["13", "14", "15"]], e, title="SPEC Y", heading="SPEC Y")], 70)
        t.end(True)
        self.assertEqual([r["tab"] for r in t.done], ["SPEC X p1-3", "SPEC Y p4"])
        self.assertEqual(t.done[0]["data"], [[1, "1", "2", "3"], [2, "4", "5", "6"], [3, "7", "8", "9"], [3, "10", "11", "12"]])

    def test_no_join_when_the_table_ended_above_the_bottom(self):
        e = [0.1, 0.4, 0.7, 0.9]
        t = pdf_pages.Tables(None)
        t.page(1, [self._t([["A", "B", "C"], ["1", "2", "3"]], e, to_bottom=False)], 70)
        t.page(2, [self._t([["A", "B", "C"], ["4", "5", "6"]], e)], 70)
        t.end(True)
        self.assertEqual([r["tab"] for r in t.done], ["Table p1", "Table p2"])

    def test_a_table_goes_on_over_a_window_edge(self):
        e = [0.1, 0.4, 0.7, 0.9]
        t = pdf_pages.Tables(None)
        t.page(1, [self._t([["A", "B", "C"], ["1", "2", "3"]], e, heading="H")], 70)
        state = t.end(False)
        self.assertEqual(t.done, [])
        self.assertEqual(t.parts[0]["tab"], "H p1 on")
        self.assertLess(len(json.dumps(state)), 256 * 1024)
        t2 = pdf_pages.Tables(json.loads(json.dumps(state)))
        t2.page(2, [self._t([["A", "B", "C"], ["4", "5", "6"]], e)], 70)
        t2.end(True)
        self.assertEqual(t2.done[0]["tab"], "H p1 on")
        self.assertEqual((t2.done[0]["first"], t2.done[0]["last"], t2.done[0]["rows"]), (1, 2, 2))
        self.assertEqual(t2.done[0]["data"], [[2, "4", "5", "6"]])

    def test_quality(self):
        rec = {"odd": 0, "rows": 10, "header": ["a", "b"], "cells": 20, "empty": 0, "low": 0}
        self.assertEqual(pdf_pages.quality_of(rec), ("ok", ""))
        q, note = pdf_pages.quality_of(dict(rec, empty=5, odd=2))
        self.assertEqual(q, "partial")
        self.assertIn("2 of 10 rows", note)
        self.assertIn("5 of 20 cells are empty", note)

    def test_tsv(self):
        tsv = ("level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n"
               "5\t1\t1\t1\t1\t1\t10\t10\t40\t20\t95.5\tHELLO\n"
               "5\t1\t1\t1\t1\t2\t60\t10\t40\t20\t85.5\tWORLD\n"
               "5\t1\t2\t1\t1\t1\t10\t60\t40\t20\t60\tNEXT\n")
        words, text, mean = pdf_pages.parse_tsv(tsv)
        self.assertEqual(text, "HELLO WORLD\n\nNEXT")
        self.assertEqual(len(words), 3)
        self.assertAlmostEqual(mean, (95.5 + 85.5 + 60) / 3)


@unittest.skipUnless(HAVE, "pdfplumber, pypdfium2 or OpenCV is missing")
class TextLayer(unittest.TestCase):
    """The text twin: every page has a text layer, so nothing is drawn or asked."""

    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp(prefix="pdf-pages-text-")
        cls.pages, cls.truth, _ = book_pdfs.book()
        cls.pdf = os.path.join(cls.dir, "text.pdf")
        book_pdfs.write_pdf(cls.pdf, cls.pages[:7], scan=set())
        cls.result, cls.job = run(cls.pdf)
        cls.tabs, cls.input = tabs_of(cls.result)

    def test_every_page_is_text_and_nothing_is_asked(self):
        self.assertEqual(self.result["status"], "ok")
        self.assertEqual([r[2] for r in self.tabs["Pages"]["rows"]], ["text"] * 7)
        self.assertEqual(self.input["pictures"], [])
        self.assertEqual(self.result["counts"]["vision"], 0)
        self.assertEqual(self.result["counts"]["ocr"], 0)

    def test_text_has_a_page_line_before_each_page(self):
        text = self.input["text"]
        for n in range(1, 8):
            self.assertIn("## Page %d\n" % n, text)
        self.assertIn("GENERAL NOTES", text)

    def test_tables_are_one_tab_each_with_their_pages(self):
        names = [n for n in self.tabs if n not in ("Pages", "Tables", "File")]
        self.assertEqual(
            names,
            ["PIPING MATERIAL SPECIFICATION A2C3 REV 1 p2-4", "VALVE DATA SHEET B1 REV 2 p5-6", "INSTRUMENT INDEX p7"],
        )
        for name, truth in zip(names, self.truth):
            tab = self.tabs[name]
            self.assertEqual(tab["columns"][0], {"name": "Page", "type": "number"})
            self.assertEqual([c["name"] for c in tab["columns"][1:]], truth["header"])
            right, pages_ok = score(tab, truth)
            self.assertEqual(len(tab["rows"]), len(truth["rows"]), name)
            self.assertEqual(pages_ok, len(truth["rows"]), name)
            self.assertGreaterEqual(right, 0.99, name)

    def test_the_tables_index(self):
        idx = self.tabs["Tables"]
        cols = [c["name"] for c in idx["columns"]]
        self.assertEqual(cols, ["Tab", "Title", "Pages", "Rows", "Columns", "Method", "Quality", "Note"])
        rows = {r[0]: r for r in idx["rows"]}
        a = rows["PIPING MATERIAL SPECIFICATION A2C3 REV 1 p2-4"]
        self.assertEqual((a[2], a[3], a[4], a[5], a[6]), ("2-4", 120, 6, "text", "ok"))
        self.assertEqual(rows["VALVE DATA SHEET B1 REV 2 p5-6"][2], "5-6")

    def test_the_file_tab_names_the_kind(self):
        f = self.tabs["File"]
        self.assertEqual([c["name"] for c in f["columns"]][:2], ["Kind", "Rules kind"])
        self.assertEqual(f["rows"][0][:2], ["book", "book"])
        self.assertEqual(f["rows"][0][3], 7)

    def test_windows_join_a_table_over_the_edge(self):
        """Pages 1 to 3 and 4 to 7 as two parts, the state carried: the
        three-page table is one tab, and its row of Tables is written once."""
        a = os.path.join(self.dir, "w1.pdf")
        b = os.path.join(self.dir, "w2.pdf")
        book_pdfs.write_pdf(a, self.pages[0:3], scan=set())
        book_pdfs.write_pdf(b, self.pages[3:7], scan=set())
        r1, _ = run(a, {"pageFrom": 1, "pageCount": 7})
        self.assertIn("state", r1)
        self.assertLess(len(json.dumps(r1["state"])), 256 * 1024)
        r2, _ = run(b, {"pageFrom": 4, "pageCount": 7, "state": r1["state"]})
        self.assertNotIn("state", r2)
        t1, _ = tabs_of(r1)
        t2, _ = tabs_of(r2)
        name = "PIPING MATERIAL SPECIFICATION A2C3 REV 1 p2 on"
        self.assertEqual(sorted({r[0] for r in t1[name]["rows"]}), [2, 3])
        self.assertEqual(sorted({r[0] for r in t2[name]["rows"]}), [4])
        self.assertNotIn("Tables", t1)  # nothing closed in window 1
        idx = [r for r in t2["Tables"]["rows"] if r[0] == name]
        self.assertEqual(len(idx), 1)
        self.assertEqual((idx[0][2], idx[0][3]), ("2-4", 120))
        self.assertIn("File", t1)
        self.assertNotIn("File", t2)
        self.assertEqual([r[0] for r in t2["Pages"]["rows"]], [4, 5, 6, 7])

    def test_not_a_pdf_and_bad_bytes(self):
        r, _ = run(self.pdf, {"file": {"name": "x.tif", "ext": "tif", "size": 0, "sha256": "0" * 64}})
        self.assertEqual(r["status"], "not_mine")
        r, _ = run(self.pdf, {"state": {"facts": True}})
        self.assertEqual(r["status"], "not_mine")
        bad = os.path.join(self.dir, "bad.pdf")
        with open(bad, "wb") as f:
            f.write(b"not a pdf at all")
        r, _ = run(bad)
        self.assertEqual(r["status"], "failed")

    def test_the_entry_runs_as_the_parser_starts_it(self):
        job = tempfile.mkdtemp(prefix="pdf-pages-cli-")
        shutil.copy(self.pdf, os.path.join(job, "in.bin"))
        with open(os.path.join(job, "request.json"), "w") as f:
            json.dump({"api": 1, "step": 1, "file": {"name": "b.pdf", "ext": "pdf", "size": 1, "sha256": "0" * 64}, "options": {}}, f)
        subprocess.run([sys.executable, STEP_PY, job], check=True, cwd=job)
        with open(os.path.join(job, "result.json")) as f:
            res = json.load(f)
        self.assertEqual(res["status"], "ok")
        self.assertEqual(res["counts"]["text"], 7)


@unittest.skipUnless(HAVE and HAVE_OCR, "pdfplumber, pypdfium2, OpenCV or tesseract is missing")
class Scans(unittest.TestCase):
    """The scanned book: Tesseract reads it, the figure goes to vision with
    its picture, the blank page is blank."""

    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp(prefix="pdf-pages-scan-")
        cls.pages, cls.truth, cls.methods = book_pdfs.book()
        cls.pdf = os.path.join(cls.dir, "scan.pdf")
        book_pdfs.write_pdf(cls.pdf, cls.pages, scan=set(range(1, 10)))
        cls.result, cls.job = run(cls.pdf)
        cls.tabs, cls.input = tabs_of(cls.result)

    def test_methods(self):
        got = {r[0]: r[2] for r in self.tabs["Pages"]["rows"]}
        self.assertEqual(got, self.methods)
        conf = {r[0]: r[3] for r in self.tabs["Pages"]["rows"]}
        for n, m in self.methods.items():
            if m == "ocr":
                self.assertGreaterEqual(conf[n], 70, n)

    def test_tables_from_the_scan(self):
        names = [n for n in self.tabs if n not in ("Pages", "Tables", "File")]
        self.assertEqual(
            names,
            ["PIPING MATERIAL SPECIFICATION A2C3 REV 1 p2-4", "VALVE DATA SHEET B1 REV 2 p5-6", "INSTRUMENT INDEX p7"],
        )
        cells = good = 0
        for name, truth in zip(names, self.truth):
            tab = self.tabs[name]
            self.assertEqual(len(tab["rows"]), len(truth["rows"]), name)
            right, pages_ok = score(tab, truth)
            self.assertEqual(pages_ok, len(truth["rows"]), name)
            n = len(truth["rows"]) * len(truth["header"])
            cells += n
            good += right * n
        self.assertGreaterEqual(good / cells, 0.95)
        idx = {r[0]: r for r in self.tabs["Tables"]["rows"]}
        self.assertEqual(idx[names[0]][2], "2-4")
        self.assertEqual(idx[names[0]][5], "ocr")
        self.assertIn(idx[names[0]][6], ("ok", "partial"))

    def test_g1_a_gray_picture_of_the_vision_page(self):
        pics = self.input["pictures"]
        self.assertEqual([p["file"] for p in pics], ["page-00008.png"])
        self.assertTrue(pics[0]["caption"].startswith("Page 8"))
        im = Image.open(os.path.join(self.job, "page-00008.png"))
        self.assertEqual(im.mode, "L")
        self.assertAlmostEqual(im.width, 1240, delta=3)  # A4 at 150 dpi
        self.assertFalse(any(f.startswith("ocr-") for f in os.listdir(self.job)))

    def test_counts_and_description(self):
        c = self.result["counts"]
        self.assertEqual((c["ocr"], c["vision"], c["blank"], c["tables"], c["pictures"]), (7, 1, 1, 3, 1))
        self.assertIn("1 for vision", self.input["description"])


if __name__ == "__main__":
    unittest.main()
