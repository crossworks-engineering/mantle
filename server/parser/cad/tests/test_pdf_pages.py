"""Tests for the built-in Reader pdf-pages (pdf_pages.py): the text layer,
the scanned pages marked with no OCR (the Scan reader's, or
blank), the tables of typed pages (ruled, on several pages, with no ruled
lines), the Tables index, no page picture (G1: the Agent pdf-page-read
draws and saves the picture of a page it reads) and the windows. Every PDF
here is made up by this test (book_pdfs.py; the repo is public).

Run (stdlib unittest; skipped when pdfplumber, pypdfium2 or OpenCV is
missing, unless PARSER_TESTS_REQUIRE_CAD is set):
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

    def test_a_header_with_no_rows_is_no_table(self):
        e = [0.1, 0.4, 0.7, 0.9]
        t = pdf_pages.Tables(None)
        t.page(1, [self._t([["A", "B", "C"]], e, to_bottom=False)], 70)
        t.page(2, [self._t([["A", "B", "C"], ["1", "2", "3"]], e)], 70)
        t.end(True)
        self.assertEqual([r["tab"] for r in t.done], ["Table p2"])

    def test_a_first_row_of_data_is_no_header(self):
        """A run on that does not join (here: the table above ended before
        the bottom) keeps its first row as data, under Column N."""
        self.assertTrue(pdf_pages.header_like(["ITEM", "SIZE", "RATING"]))
        self.assertFalse(pdf_pages.header_like(["PIPE", "1/2-24", "SCH 40", "123-45"]))
        self.assertFalse(pdf_pages.header_like(["", ""]))
        e = [0.1, 0.4, 0.7, 0.9]
        t = pdf_pages.Tables(None)
        t.page(1, [self._t([["A", "B", "C"], ["1", "2", "3"]], e, to_bottom=False)], 70)
        t.page(2, [self._t([["10", "20", "30"], ["40", "50", "60"]], e)], 70)
        t.end(True)
        self.assertEqual(t.done[1]["columns"], ["Column 1", "Column 2", "Column 3"])
        self.assertEqual(t.done[1]["data"], [[2, "10", "20", "30"], [2, "40", "50", "60"]])

    def test_quality(self):
        rec = {"odd": 0, "rows": 10, "header": ["a", "b"], "cells": 20, "empty": 0, "low": 0}
        self.assertEqual(pdf_pages.quality_of(rec), ("ok", ""))
        q, note = pdf_pages.quality_of(dict(rec, empty=5, odd=2))
        self.assertEqual(q, "partial")
        self.assertIn("2 of 10 rows", note)
        self.assertIn("5 of 20 cells are empty", note)


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
        self.assertNotIn("pictures", self.input)
        self.assertEqual(self.result["counts"]["vision"], 0)
        self.assertEqual(self.result["counts"]["scan"], 0)

    def test_a_short_typed_page_is_text_a_vector_figure_is_not(self):
        # M4 of the large-PDF audit, round 3: a section divider or a title
        # page of a typed book is read from its text layer, never by vision;
        # a typed page that draws a figure with a few labels still goes to
        # vision.
        pdf = os.path.join(self.dir, "divider.pdf")
        book_pdfs.write_pdf(
            pdf,
            [[("text", 300, 1000, 60, True, "SECTION 16")], [("text", 300, 1000, 60, True, "ELECTRICAL")], self.pages[7]],
            scan=set(),
        )
        r, _ = run(pdf)
        rows = tabs_of(r)[0]["Pages"]["rows"]
        self.assertEqual([row[2] for row in rows][:2], ["text", "text"])
        self.assertEqual(rows[0][6], "SECTION 16")
        self.assertNotEqual(rows[2][2], "text")

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
        r1, _ = run(a, {"pageFrom": 1, "pageTo": 3, "pagesTotal": 7})
        self.assertIn("state", r1)
        self.assertLess(len(json.dumps(r1["state"])), 256 * 1024)
        r2, _ = run(b, {"pageFrom": 4, "pageTo": 7, "pagesTotal": 7, "state": r1["state"]})
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
        # A lost window 1: the first window read writes the kind.
        r3, _ = run(b, {"pageFrom": 4, "pageTo": 7, "pagesTotal": 7})
        self.assertEqual(tabs_of(r3)[0]["File"]["rows"][0][:2], ["book", "book"])
        self.assertEqual([r[0] for r in t2["Pages"]["rows"]], [4, 5, 6, 7])
        # The last window says the whole book: its description stands.
        self.assertTrue(tabs_of(r2)[1]["description"].startswith("A book of 7 pages: 7 text, 0 scanned"))
        self.assertEqual(r1["state"]["totals"]["text"], 3)

    def test_a_lost_window_ends_the_open_table(self):
        """The core goes on from the state before a window it lost: the next
        window does not join a table over the missing pages."""
        a = os.path.join(self.dir, "g1.pdf")
        b = os.path.join(self.dir, "g2.pdf")
        book_pdfs.write_pdf(a, self.pages[0:3], scan=set())
        book_pdfs.write_pdf(b, self.pages[4:7], scan=set())
        r1, _ = run(a, {"pageFrom": 1, "pageTo": 3, "pagesTotal": 7})
        r2, _ = run(b, {"pageFrom": 5, "pageTo": 7, "pagesTotal": 7, "state": r1["state"]})
        t2, _ = tabs_of(r2)
        names = [r[0] for r in t2["Tables"]["rows"]]
        self.assertIn("PIPING MATERIAL SPECIFICATION A2C3 REV 1 p2 on", names)
        self.assertIn("VALVE DATA SHEET B1 REV 2 p5-6", names)

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


@unittest.skipUnless(HAVE, "pdfplumber, pypdfium2 or OpenCV is missing")
class PageBands(unittest.TestCase):
    """The text lines of a scanned page, counted with no OCR."""

    def page(self, lines, dpi=150, skew=0):
        import numpy as np

        h, w = int(11.69 * dpi), int(8.27 * dpi)
        arr = np.full((h, w), 255, np.uint8)
        step = int(0.22 * dpi)
        for i in range(lines):
            y = int(1.2 * dpi) + i * step
            for x in range(int(0.6 * dpi), w - int(0.6 * dpi), 7):
                dy = int(skew * x / w)
                arr[y + dy : y + dy + int(0.07 * dpi), x : x + 5] = 0
        return arr

    def test_band_lines_counts_the_lines_of_a_picture(self):
        self.assertEqual(pdf_pages.band_lines(self.page(44), 150), 44)
        # Drawn at 300 dots: counted at 150, the same lines.
        self.assertEqual(pdf_pages.band_lines(self.page(30, dpi=300), 300), 30)
        # A skew of a few pixels across the page keeps its rows.
        self.assertEqual(pdf_pages.band_lines(self.page(40, skew=12), 150), 40)

    def test_a_white_page_has_no_line(self):
        self.assertEqual(pdf_pages.band_lines(self.page(0), 150), 0)


@unittest.skipUnless(HAVE, "pdfplumber, pypdfium2 or OpenCV is missing")
class Scans(unittest.TestCase):
    """The scanned book, with no OCR: every page with ink is the Scan reader's
    (Why `scan`, with its lines; its engine finds a figure, and the core sends
    that page on to vision), the blank page is blank. Nothing is read here:
    the Agent reads the marked pages."""

    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp(prefix="pdf-pages-scan-")
        cls.pages, cls.truth, cls.methods = book_pdfs.book()
        cls.pdf = os.path.join(cls.dir, "scan.pdf")
        book_pdfs.write_pdf(cls.pdf, cls.pages, scan=set(range(1, 10)))
        cls.result, cls.job = run(cls.pdf)
        cls.tabs, cls.input = tabs_of(cls.result)

    def rows(self):
        cols = [c["name"] for c in self.tabs["Pages"]["columns"]]
        return [dict(zip(cols, r)) for r in self.tabs["Pages"]["rows"]]

    def test_the_pages_columns(self):
        cols = [c["name"] for c in self.tabs["Pages"]["columns"]]
        self.assertEqual(cols, ["Page", "Paper", "Method", "Why", "Chars", "Lines", "Text"])

    def test_methods_and_why(self):
        got = {r["Page"]: (r["Method"], r["Why"]) for r in self.rows()}
        want = {}
        for n, m in self.methods.items():
            # The book's OCR pages and its figure are the Scan reader's now;
            # the blank page is blank.
            want[n] = ("vision", "scan") if m in ("ocr", "vision") else (m, None)
        self.assertEqual(got, want)

    def test_a_scanned_page_of_text_has_its_lines_and_no_text_of_its_own(self):
        for r in self.rows():
            if r["Why"] == "scan" and r["Page"] != 8:
                self.assertGreaterEqual(r["Lines"], 10, r["Page"])
            if r["Why"] == "scan":
                self.assertEqual((r["Text"], r["Chars"]), ("", 0), r["Page"])

    def test_no_tables_and_no_picture_from_a_scan(self):
        names = [n for n in self.tabs if n not in ("Pages", "File")]
        self.assertEqual(names, [])
        self.assertNotIn("pictures", self.input)
        self.assertFalse(any(f.endswith((".png", ".jpg")) for f in os.listdir(self.job)))

    def test_a_faint_line_is_a_page_to_read_a_speck_is_blank(self):
        pdf = os.path.join(self.dir, "faint.pdf")
        book_pdfs.write_pdf(
            pdf,
            [[("line", 800, 1100, 812, 1100, 3)], [("text", 90, 1100, 24, False, "SIGNED AND DATED BY THE MADE-UP INSPECTOR OF RECORD")]],
            scan={1, 2},
            noise=False,
        )
        r, _ = run(pdf)
        rows = tabs_of(r)[0]["Pages"]["rows"]
        self.assertEqual(rows[0][2], "blank")
        self.assertEqual((rows[1][2], rows[1][3]), ("vision", "scan"))

    def test_a_scanned_divider_and_a_figure_are_the_scan_readers(self):
        pdf = os.path.join(self.dir, "divider-scan.pdf")
        pages, _, _ = book_pdfs.book()
        book_pdfs.write_pdf(pdf, [[("text", 300, 1000, 60, True, "SECTION 16")], pages[7]], scan={1, 2})
        r, _ = run(pdf)
        rows = tabs_of(r)[0]["Pages"]["rows"]
        self.assertEqual([(row[2], row[3]) for row in rows], [("vision", "scan"), ("vision", "scan")])

    def test_counts_and_description(self):
        c = self.result["counts"]
        self.assertEqual((c["text"], c["scan"], c["vision"], c["blank"], c["tables"]), (0, 8, 8, 1, 0))
        self.assertIn("8 scanned (the Scan reader), 0 for vision", self.input["description"])

    def test_no_tesseract_is_run(self):
        # The book reader runs no local OCR (owner decision 2026-11-19).
        src = open(pdf_pages.__file__).read()
        self.assertNotIn("tesseract", src.lower())
        self.assertNotIn("subprocess", src)


if __name__ == "__main__":
    unittest.main()
