"""pdf_pages: the built-in Reader `pdf-pages` (docs/pipelines.md, "The book reader").
Model-free: it asks no model and spends nothing.

It reads a PDF the router named a `book` (a long run of office pages, mostly
scans or typed text), one window of pages a job, page by page:

  text    the page's text layer (pdfplumber) holds TEXT_MIN_CHARS or more
          characters that are not spaces, or fewer on a page with no picture
          over half of it and no vector figure (a section divider, a title
          page): its text is the page's text. A typed page never goes to
          vision.
  ocr     else the page is drawn (pypdfium2) and read by Tesseract
          (--psm 3, never 6: rows cross the ruled lines), TSV out: words,
          boxes and confidence.
  vision  the OCR's mean confidence is under OCR_MIN_CONFIDENCE, or it gave
          under TEXT_MIN_CHARS characters on a page with ink besides its words
          (a figure; FIGURE_INK_SHARE): the Agent `pdf-page-read` reads
          the page with vision. The Agent draws the page itself and saves
          its picture with the text it read (G1): this Reader writes no
          page picture.
  blank   a page with no text layer and almost no ink: nothing to read, and
          no paid ask for a white page.

The tables of a page go into the file's database (the brief, section 4):
pdfplumber's `find_tables` on a text page; on a scanned page the ruled lines
(OpenCV) give the grid and each Tesseract word goes in the cell that holds the
centre of its box. A page with no ruled lines: columns from the left edges of
words over the rows (a whitespace table). A table that runs on over the next
page (the same header, or no header and the same column edges) is ONE tab,
named by its nearest heading and its pages ("SPEC X1 REV 0 p12-14"); every row
keeps its page (the column Page). The tab Tables indexes them with an honest
quality: ok, partial (with a note) or text only.

It writes the tabs Pages, Tables, File and one tab a table, and the text of
the window with a `## Page N` line before each page.

Windows: the core may hand the step a part of the file (request.pageFrom, its
first page in the file). A table open at the end of a window goes on in the
next one through the step's `state` ({"open": {...}}): the next window writes
its rows to the same tab, and the window that closes it writes its row of
Tables.

The parser starts this file with the job's folder as its one argument
(pythonStep, server/parser/src/pipeline-job.ts): request.json and in.bin in,
result.json out. Libraries (MIT, Apache-2.0 or BSD only): pdfplumber and
pdfminer.six (MIT), pypdfium2 (Apache-2.0 or BSD-3), OpenCV and numpy (the CAD
venv), Pillow, and the image's tesseract-ocr (Apache-2.0). Never PyMuPDF,
Camelot (Ghostscript) or Tabula.
"""

from __future__ import annotations

import difflib
import json
import math
import os
import re
import subprocess
import sys
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image

# ── options (the manifest's defaults; packages/files/src/pipelines/builtin.ts) ──

TEXT_MIN_CHARS = 40
OCR_MIN_CONFIDENCE = 70
OCR_DPI = 300
# A page past the OCR time budget is drawn at this, only to see it is not
# white: it goes to vision.
LATE_DPI = 150
# A scan is drawn for OCR at its own dots from here up to the option ocr_dpi.
NATIVE_DPI_MIN = 200

# ── fixed bounds ────────────────────────────────────────────────────────────

# The page render cap of the brain (MAX_RENDER_PIXELS, packages/files/src/
# rasterize.ts; pdf_eye.py's MAX_PIXELS): a larger sheet is drawn at fewer dots.
MAX_PIXELS = 4096 * 4096
# Ink: a pixel darker than this, and the share of the page under which a page
# with no text layer is faint: OCR still reads it, and when it finds under
# the text floor the page is blank (no paid ask for a speck). A page with no
# ink at all is blank with no OCR.
INK_LEVEL = 128
BLANK_INK_SHARE = 0.001
# A scanned page whose OCR gave under TEXT_MIN_CHARS characters at a good
# confidence is `ocr`, not `vision`, when the ink outside the words OCR read
# is under this share of the page (a section divider, a cover: only those
# words are on it); more ink there is a figure or a drawing, for vision. A
# clean scan's specks are about 0.1%.
FIGURE_INK_SHARE = 0.005
# A page with a short text layer (1 to TEXT_MIN_CHARS characters) and no
# picture over half of it is a typed page, read from its text layer (a
# section divider, a title page), unless it draws this many lines, boxes
# and curves or more (a vector figure with a few labels: vision reads it).
FIGURE_MIN_OBJECTS = 10
# One Tesseract run, at most (seconds). A page past it goes to vision.
OCR_TIMEOUT_S = 180
# Tesseract runs at once: the parser's CPU share (docker-compose: cpus 2).
OCR_WORKERS = 2
# Pages drawn and waiting for their OCR, at most: each is up to 16 MP.
OCR_IN_FLIGHT = 3

OCR_FAILED = "Tesseract could not read some pages; they are marked for vision."
TEXT_LAYER_FAILED = "pdfminer could not read the text layer of this window; its pages are drawn and read by OCR."
RENDER_FAILED = "Some pages could not be drawn; they are marked for vision."
TABLES_FAILED = "The tables of some text pages could not be found; their text is read."
# The time a window's job may take in all (seconds): a Tesseract run still
# going then is stopped, and its page goes to vision. Under the job's end.
JOB_BUDGET_S = 225
# The time a window spends drawing pages for OCR, at most (seconds): the
# job's end is 240 s (PARSER_JOB_TIMEOUT_MS.pipelineRun), and a job that
# ends loses its whole window. A page after it goes to vision.
OCR_BUDGET_S = 180
OCR_LATE = "The OCR time of this window ran out; its last pages are marked for vision."

# Tables.
EDGE_TOLERANCE = 0.02  # column edges of a continued table, share of the page width
EMPTY_CELLS_OK = 0.10  # under this share of empty cells a table is ok
FOOTER_SHARE = 0.92  # words below this share of the page height are its footer
COLUMN_TOLERANCE = 0.015  # left edges of one whitespace column, share of the width
# A title: a line above a table in type this much taller than the table's
# own. A new title on the next page starts a new table, though its header is
# the same (a spec book: one spec a page, each with the same columns); a
# running head in the body's type does not.
TITLE_SCALE = 1.15
TAB_HEADING_MAX = 48  # characters of the heading in a tab's name
COLUMN_NAME_MAX = 60
CELL_STATE_MAX = 120  # characters of a header cell carried in the state
TABLES_TAB = "Tables"
PAGES_TAB = "Pages"
FILE_TAB = "File"
RESERVED_TABS = {TABLES_TAB.lower(), PAGES_TAB.lower(), FILE_TAB.lower(), "page text"}
# The kind rules this Reader's File tab names (PDF_KIND_RULES_VERSION,
# packages/files/src/pdf-drawing-sheets.ts; a test holds them equal).
PDF_KIND_RULES_VERSION = 4

PAPERS = [  # name, short side mm, long side mm
    ("A5", 148, 210),
    ("A4", 210, 297),
    ("Letter", 215.9, 279.4),
    ("Legal", 215.9, 355.6),
    ("A3", 297, 420),
    ("Tabloid", 279.4, 431.8),
    ("A2", 420, 594),
    ("A1", 594, 841),
    ("A0", 841, 1189),
]


def paper_of(w_mm, h_mm):
    """The paper a page is, within 3%, else its size in millimetres."""
    short, long_ = sorted((w_mm, h_mm))
    for name, s, l in PAPERS:
        if abs(short - s) <= 0.03 * s and abs(long_ - l) <= 0.03 * l:
            return name
    return "%.0f x %.0f mm" % (w_mm, h_mm)


def option(opts, name, default, lo, hi):
    v = opts.get(name)
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        return default
    return min(hi, max(lo, v))


def nonspace(s):
    return sum(1 for ch in s if not ch.isspace())


# ── words, lines and headings (one frame: page units, y down) ───────────────


def word(text, x0, top, x1, bottom, conf=None):
    return {"text": text, "x0": x0, "top": top, "x1": x1, "bottom": bottom, "conf": conf}


def cy(w):
    return (w["top"] + w["bottom"]) / 2


def cx(w):
    return (w["x0"] + w["x1"]) / 2


def lines_of(words):
    """Words in rows: a word whose centre is within half a line height of a
    row's centre joins it. Rows top to bottom, words left to right."""
    rows = []
    for w in sorted(words, key=lambda w: (cy(w), w["x0"])):
        h = max(1e-6, w["bottom"] - w["top"])
        if rows and abs(cy(w) - rows[-1]["cy"]) <= 0.5 * max(h, rows[-1]["h"]):
            r = rows[-1]
            r["words"].append(w)
            n = len(r["words"])
            r["cy"] += (cy(w) - r["cy"]) / n
            r["h"] = max(r["h"], h)
        else:
            rows.append({"words": [w], "cy": cy(w), "h": h})
    for r in rows:
        r["words"].sort(key=lambda w: w["x0"])
        r["top"] = min(w["top"] for w in r["words"])
        r["bottom"] = max(w["bottom"] for w in r["words"])
        r["text"] = " ".join(w["text"] for w in r["words"])
        heights = sorted(w["bottom"] - w["top"] for w in r["words"])
        # The lower quartile: a speck Tesseract joined to a word makes its box
        # taller, never shorter.
        r["size"] = heights[len(heights) // 4]
    return rows


def clean_heading(s):
    s = re.sub(r"[^A-Za-z0-9 .,&()/_+#-]+", " ", s)
    return re.sub(r"\s+", " ", s).strip(" .,-")


def heading_above(lines, top, floor, body=None):
    """The nearest heading above a table: of the lines between `floor` (the
    table above, or the page top) and the table's `top`, the one in the
    largest type; the nearest of those on a tie. None when no line is there.
    With `body` (the table's own type height), only a line in larger type
    than the table's (TITLE_SCALE) counts: a title, not a running head."""
    above = [r for r in lines if r["bottom"] <= top + 1e-6 and r["top"] >= floor - 1e-6]
    above = [r for r in above if clean_heading(r["text"])]
    if body is not None:
        above = [r for r in above if r["size"] >= TITLE_SCALE * body]
    if not above:
        return None
    biggest = max(r["size"] for r in above)
    tall = [r for r in above if r["size"] >= 0.9 * biggest]
    return clean_heading(tall[-1]["text"])


# ── tables: shared parts ────────────────────────────────────────────────────


def norm_header(row):
    """A header as a key: lower case, letters and digits, one space between."""
    return " | ".join(re.sub(r"[^a-z0-9]+", " ", (c or "").lower()).strip() for c in row)


HEADER_SAME = 0.8  # a header read twice by OCR: this alike, or more (difflib)


def same_header(a, b):
    """Two headers (or titles) are one when their keys are this alike: OCR
    reads the same header a letter apart on two pages."""
    x, y = norm_header(a), norm_header(b)
    if x == y:
        return True
    return bool(x) and bool(y) and difflib.SequenceMatcher(None, x, y).ratio() >= HEADER_SAME


def ran_to_bottom(table_bottom, words, page_h):
    """No word of the page sits under the table but in the footer."""
    return not any(cy(w) > table_bottom and cy(w) < FOOTER_SHARE * page_h for w in words)


def edges_match(a, b):
    return len(a) == len(b) and all(abs(x - y) <= EDGE_TOLERANCE for x, y in zip(a, b))


# What Tesseract reads at the edge of a cell from a ruled line it saw.
CELL_EDGE_NOISE = re.compile(r"^[\s|\[\]{}\u2014\u2013_~\u2018\u2019\u201c\u201d\u00b0]+|[\s|\[\]{}\u2014\u2013_~\u2018\u2019\u201c\u201d\u00b0]+$")
CELL_EDGE_BAR = re.compile(r"^[-\s]*\|+|\|+[-\s]*$")


def clean_cell(c):
    return CELL_EDGE_NOISE.sub("", CELL_EDGE_BAR.sub("", c or ""))


def make_table(rows, confs, edges, top, bottom, page, page_h, words, method, heading, odd=0):
    """A table found on one page: its rows (cells as text), the least word
    confidence of each cell (None: a text layer), the column edges as shares
    of the page width, and where it sits."""
    tidy = clean_cell if method == "ocr" else (lambda c: (c or "").strip())
    rows = [[tidy(c) for c in r] for r in rows]
    keep = [i for i, r in enumerate(rows) if any(r)]
    rows = [rows[i] for i in keep]
    confs = [confs[i] for i in keep]
    if not rows or len(rows[0]) < 2:
        return None
    return {
        "rows": rows,
        "confs": confs,
        "edges": [round(e, 4) for e in edges],
        "top": top,
        "bottom": bottom,
        "page": page,
        "to_bottom": ran_to_bottom(bottom, words, page_h),
        "method": method,
        "heading": heading,
        "odd": odd,
    }


def cells_from_grid(words, hlines, vlines):
    """Each word in the cell that holds the centre of its box. A line is
    (a, b): y = a + b * x for a row line, x = a + b * y for a column line,
    so a skewed scan keeps its rows. Rows of words top to bottom in a cell."""
    nr, nc = len(hlines) - 1, len(vlines) - 1
    cells = [[[] for _ in range(nc)] for _ in range(nr)]
    for w in words:
        x, y = cx(w), cy(w)
        r = sum(1 for a, b in hlines if a + b * x < y) - 1
        c = sum(1 for a, b in vlines if a + b * y < x) - 1
        if 0 <= r < nr and 0 <= c < nc:
            cells[r][c].append(w)
    rows, confs = [], []
    for r in range(nr):
        row, crow = [], []
        for c in range(nc):
            ws = cells[r][c]
            text = " ".join(" ".join(w["text"] for w in ln["words"]) for ln in lines_of(ws)) if ws else ""
            row.append(text)
            cs = [w["conf"] for w in ws if w["conf"] is not None]
            crow.append(min(cs) if cs else None)
        rows.append(row)
        confs.append(crow)
    return rows, confs


def whitespace_tables(words, page_w, page_h, page, method, lines, used):
    """Tables with no ruled lines: a run of 3 or more rows of 3 or more word
    groups (a gap wider than the row's height splits a group) whose left
    edges fall in the same columns. `used`: boxes of tables found already;
    their words are left out."""
    free = [w for w in words if not any(b[0] <= cx(w) <= b[2] and b[1] <= cy(w) <= b[3] for b in used)]
    rows = lines_of(free)
    segs = []
    for r in rows:
        groups = []
        for w in r["words"]:
            if groups and w["x0"] - groups[-1][-1]["x1"] <= 1.2 * r["size"]:
                groups[-1].append(w)
            else:
                groups.append([w])
        segs.append(groups)
    tables = []
    i = 0
    while i < len(rows):
        if len(segs[i]) < 3:
            i += 1
            continue
        j = i
        while j < len(rows):
            if len(segs[j]) >= 3:
                j += 1
            elif len(segs[j]) == 2 and j + 1 < len(rows) and len(segs[j + 1]) >= 3:
                # One row with an empty cell (two groups) inside a table.
                j += 1
            else:
                break
        if j - i >= 3:
            t = whitespace_block(rows[i:j], segs[i:j], page_w, page_h, page, method, words)
            if t:
                tables.append(t)
        i = j
    return tables


def whitespace_block(rows, segs, page_w, page_h, page, method, words):
    tol = COLUMN_TOLERANCE * page_w
    xs = sorted(g[0]["x0"] for groups in segs for g in groups)
    clusters = []
    for x in xs:
        if clusters and x - clusters[-1][-1] <= tol:
            clusters[-1].append(x)
        else:
            clusters.append([x])
    starts = [min(c) for c in clusters if len(c) >= 0.5 * len(rows)]
    if len(starts) < 3:
        return None
    out, confs, odd = [], [], 0
    for groups in segs:
        cells = [[] for _ in starts]
        merged = False
        for g in groups:
            x = g[0]["x0"]
            k = min(range(len(starts)), key=lambda s: abs(starts[s] - x))
            if abs(starts[k] - x) > 2 * tol:
                k = max([s for s in range(len(starts)) if starts[s] <= x + tol] or [0])
            if cells[k]:
                merged = True
            cells[k].extend(g)
        if merged or sum(1 for c in cells if c) != len(starts):
            odd += 1
        out.append([" ".join(w["text"] for w in c) for c in cells])
        confs.append([min([w["conf"] for w in c if w["conf"] is not None], default=None) for c in cells])
    right = max(w["x1"] for groups in segs for g in groups for w in g)
    edges = [s / page_w for s in starts] + [right / page_w]
    top = min(r["top"] for r in rows)
    bottom = max(r["bottom"] for r in rows)
    # The header row is no odd row: a header may name fewer columns.
    odd = max(0, odd - (1 if sum(1 for c in out[0] if c) != len(starts) else 0))
    return make_table(out, confs, edges, top, bottom, page, page_h, words, method, None, odd)


# ── tables on a text page (pdfplumber) ──────────────────────────────────────


def text_page_tables(pl_page, words, lines, page, page_w, page_h):
    tables, used = [], []
    try:
        found = pl_page.find_tables()
    except Exception:  # noqa: BLE001 - a page pdfplumber cannot cut keeps its text
        found = []
    for t in found:
        try:
            rows = t.extract()
        except Exception:  # noqa: BLE001
            continue
        if not rows:
            continue
        best = max(t.rows, key=lambda r: sum(1 for c in r.cells if c is not None))
        cells = [c for c in best.cells if c is not None]
        if not cells:
            continue
        edges = [c[0] / page_w for c in cells] + [cells[-1][2] / page_w]
        x0, top, x1, bottom = t.bbox
        used.append((x0, top, x1, bottom))
        width = len(rows[0])
        rows = [list(r) + [None] * (width - len(r)) for r in rows]
        tt = make_table(rows, [[None] * width for _ in rows], edges, top, bottom, page, page_h, words, "text", None)
        if tt:
            tables.append(tt)
    tables += whitespace_tables(words, page_w, page_h, page, "text", lines, used)
    return name_headings(sorted(tables, key=lambda t: t["top"]), lines)


def name_headings(tables, lines):
    """Each table's heading (its tab's name) and its title (a heading in
    larger type than its rows, which decides a join: TITLE_SCALE)."""
    floor = 0
    for t in tables:
        t["heading"] = heading_above(lines, t["top"], floor)
        body = [r["size"] for r in lines if r["top"] >= t["top"] - 1e-6 and r["bottom"] <= t["bottom"] + 1e-6]
        size = sorted(body)[len(body) // 2] if body else None
        t["title"] = heading_above(lines, t["top"], floor, size) if size else t["heading"]
        floor = t["bottom"]
    return tables


# ── tables on a scanned page (OpenCV ruled lines + Tesseract words) ─────────


def ruled_grids(gray):
    """The ruled tables of a page picture: for each, its row lines and its
    column lines, each fitted as a straight line (a skewed scan keeps its
    rows), and its box. Morphology open with long kernels keeps the long
    lines only. Also the mask of every long line, which the OCR picture
    leaves out: Tesseract reads a ruled line as a letter (a bar or a dash)."""
    import cv2

    h, w = gray.shape
    ink = (gray < 160).astype(np.uint8) * 255
    horiz = cv2.morphologyEx(ink, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (max(30, w // 25), 1)))
    vert = cv2.morphologyEx(ink, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(30, h // 40))))

    def fitted(mask, along_x):
        n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
        out = []
        for k in range(1, n):
            x, y, bw, bh, _area = stats[k]
            if (bw if along_x else bh) < (0.05 * w if along_x else 0.03 * h):
                continue
            ys, xs = np.nonzero(labels[y : y + bh, x : x + bw] == k)
            ys = ys + y
            xs = xs + x
            if along_x:
                b, a = np.polyfit(xs, ys, 1) if np.ptp(xs) > 0 else (0.0, float(ys.mean()))
            else:
                b, a = np.polyfit(ys, xs, 1) if np.ptp(ys) > 0 else (0.0, float(xs.mean()))
            out.append({"a": float(a), "b": float(b), "box": (int(x), int(y), int(x + bw), int(y + bh))})
        return out

    hs = fitted(horiz, True)
    vs = fitted(vert, False)
    grid = cv2.dilate(cv2.bitwise_or(horiz, vert), np.ones((5, 5), np.uint8))
    n, _labels, stats, _ = cv2.connectedComponentsWithStats(grid, connectivity=8)
    grids = []
    for k in range(1, n):
        x, y, bw, bh, _area = stats[k]
        if bw < 0.2 * w or bh < 0.03 * h:
            continue
        box = (x - 3, y - 3, x + bw + 3, y + bh + 3)

        def inside(ln):
            b = ln["box"]
            return b[0] >= box[0] and b[1] >= box[1] and b[2] <= box[2] and b[3] <= box[3]

        rows = dedupe_lines(sorted((ln for ln in hs if inside(ln)), key=lambda ln: ln["a"] + ln["b"] * (x + bw / 2)), x + bw / 2)
        cols = dedupe_lines(sorted((ln for ln in vs if inside(ln)), key=lambda ln: ln["a"] + ln["b"] * (y + bh / 2)), y + bh / 2)
        if len(rows) >= 2 and len(cols) >= 3:
            grids.append({"rows": rows, "cols": cols, "box": box})
    # The row lines only: with the column lines gone too, Tesseract loses
    # whole narrow columns (bench, 2026-11-18: 90% of the cells right, 96%
    # with the row lines gone only).
    lines = cv2.dilate(horiz, np.ones((3, 3), np.uint8))
    return grids, lines


def dedupe_lines(lines, at):
    out = []
    for ln in lines:
        if out and abs((ln["a"] + ln["b"] * at) - (out[-1]["a"] + out[-1]["b"] * at)) < 8:
            continue
        out.append(ln)
    return out


def scan_page_tables(shape, grids, words, lines, page, method):
    """`shape`: the page picture's (height, width); `grids`: its ruled
    tables (ruled_grids); `words`: Tesseract's, in its pixels."""
    page_h, page_w = shape
    tables, used = [], []
    for g in grids:
        hl = [(ln["a"], ln["b"]) for ln in g["rows"]]
        vl = [(ln["a"], ln["b"]) for ln in g["cols"]]
        rows, confs = cells_from_grid(words, hl, vl)
        mid_y = (g["box"][1] + g["box"][3]) / 2
        edges = [(a + b * mid_y) / page_w for a, b in vl]
        used.append(g["box"])
        t = make_table(rows, confs, edges, g["box"][1], g["box"][3], page, page_h, words, method, None)
        if t:
            tables.append(t)
    tables += whitespace_tables(words, page_w, page_h, page, method, lines, used)
    return name_headings(sorted(tables, key=lambda t: t["top"]), lines)


# ── OCR ─────────────────────────────────────────────────────────────────────


def tesseract(png, dpi, end=None):
    """Tesseract's TSV of a page picture: (words, text, mean confidence), or
    None when it could not run, or ran past OCR_TIMEOUT_S or `end` (a
    time.monotonic() the window's job must be done by)."""
    env = dict(os.environ, OMP_THREAD_LIMIT="1")
    timeout = OCR_TIMEOUT_S if end is None else min(OCR_TIMEOUT_S, max(1.0, end - time.monotonic()))
    try:
        p = subprocess.run(
            ["tesseract", png, "stdout", "--psm", "3", "--dpi", str(int(dpi)), "-l", "eng", "tsv"],
            capture_output=True,
            timeout=timeout,
            env=env,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if p.returncode != 0:
        return None
    return parse_tsv(p.stdout.decode("utf-8", "replace"))


def parse_tsv(tsv):
    words = []
    lines = {}
    order = []
    for raw in tsv.splitlines()[1:]:
        f = raw.split("\t")
        if len(f) < 12 or f[0] != "5":
            continue
        text = f[11].strip()
        if not text:
            continue
        try:
            left, top, wd, ht = int(f[6]), int(f[7]), int(f[8]), int(f[9])
            conf = float(f[10])
        except ValueError:
            continue
        w = word(text, left, top, left + wd, top + ht, conf if conf >= 0 else None)
        words.append(w)
        key = (f[2], f[3], f[4])
        if key not in lines:
            lines[key] = []
            order.append(key)
        lines[key].append(text)
    paras = []
    last = None
    for key in order:
        if last is not None and key[:2] != last[:2]:
            paras.append("")
        paras.append(" ".join(lines[key]))
        last = key
    confs = [w["conf"] for w in words if w["conf"] is not None]
    mean = sum(confs) / len(confs) if confs else 0.0
    return words, "\n".join(paras).strip(), mean


# ── one page ────────────────────────────────────────────────────────────────


def native_dpi(pl):
    """The dots an inch of the picture that covers a scanned page (the
    largest image on it, over half the page), or None."""
    try:
        area = float(pl.width) * float(pl.height)
        best = None
        for im in pl.images:
            w = float(im["x1"]) - float(im["x0"])
            h = float(im["bottom"]) - float(im["top"])
            src = im.get("srcsize") or (0, 0)
            if w <= 0 or h <= 0 or w * h < 0.5 * area or not src[0]:
                continue
            if best is None or w * h > best[0]:
                best = (w * h, float(src[0]) / (w / 72.0))
        return best[1] if best else None
    except Exception:  # noqa: BLE001 - no image facts: the option's dots
        return None


def typed_short(pl):
    """Whether a page with a short text layer is a typed page: no picture
    covers half of it or more, and it draws fewer than FIGURE_MIN_OBJECTS
    lines, boxes and curves. A page whose facts cannot be read is not."""
    try:
        area = float(pl.width) * float(pl.height)
        for im in pl.images:
            w = float(im["x1"]) - float(im["x0"])
            h = float(im["bottom"]) - float(im["top"])
            if w * h >= 0.5 * area:
                return False
        return len(pl.lines) + len(pl.rects) + len(pl.curves) < FIGURE_MIN_OBJECTS
    except Exception:  # noqa: BLE001 - not known to be typed: drawn and read
        return False


def ink_outside(arr, words):
    """The share of a page's picture that is ink outside the boxes of the
    words OCR read (each box a little larger, for the edges of its letters)."""
    ink = arr < INK_LEVEL
    if not ink.any():
        return 0.0
    ink = ink.copy()
    h, w = ink.shape
    for wd in words:
        pad = max(2, int(0.25 * (wd["bottom"] - wd["top"])))
        x0, x1 = max(0, int(wd["x0"]) - pad), min(w, int(wd["x1"]) + pad)
        y0, y1 = max(0, int(wd["top"]) - pad), min(h, int(wd["bottom"]) + pad)
        if x1 > x0 and y1 > y0:
            ink[y0:y1, x0:x1] = False
    return float(ink.mean())


def ocr_dpi_of(native, dpi):
    """The dots a scan is drawn at for Tesseract: its own, from NATIVE_DPI_MIN
    up to the option `ocr_dpi` (bench, 2026-11-18: a 200 dpi scan drawn at
    300 read 90% of the table cells right, drawn at 200 96%); the option's
    for a scan of fewer dots, or a page with no one picture."""
    if native is not None and NATIVE_DPI_MIN <= native:
        return min(native, dpi)
    return dpi


def render(pdf, index, dpi):
    """A gray picture of a page at `dpi`, fewer dots for a sheet past
    MAX_PIXELS. Returns (array, the dots an inch it was drawn at)."""
    page = pdf[index]
    w_pt, h_pt = page.get_size()
    scale = min(dpi / 72.0, math.sqrt(MAX_PIXELS / max(1.0, w_pt * h_pt)))
    bitmap = page.render(scale=scale, grayscale=True)
    im = bitmap.to_pil().convert("L")
    arr = np.asarray(im)
    page.close()
    return arr, scale * 72.0


# ── the joining of tables over pages ────────────────────────────────────────


class Tables:
    """The tables of a run in reading order, with the one rule that joins a
    table to the one on the page before (the brief, section 4.2)."""

    def __init__(self, open_state, names_used=()):
        self.done = []  # closed tables (index rows written here)
        self.parts = []  # every table written in this window: (record, rows)
        self.open = None
        self.used = set(n.lower() for n in names_used)
        if isinstance(open_state, dict) and isinstance(open_state.get("tab"), str):
            self.open = {
                "tab": open_state["tab"],
                "heading": str(open_state.get("heading") or ""),
                "title": str(open_state.get("title") or ""),
                "header": [str(c) for c in (open_state.get("header") or [])],
                "columns": [str(c) for c in (open_state.get("columns") or [])],
                "edges": [float(e) for e in (open_state.get("edges") or [])],
                "first": int(open_state.get("first") or 0),
                "last": int(open_state.get("last") or 0),
                "rows": int(open_state.get("rows") or 0),
                "cells": int(open_state.get("cells") or 0),
                "empty": int(open_state.get("empty") or 0),
                "odd": int(open_state.get("odd") or 0),
                "low": int(open_state.get("low") or 0),
                "methods": [str(m) for m in (open_state.get("methods") or [])],
                "to_bottom": bool(open_state.get("to_bottom", True)),
                "carried": True,
                "data": [],
            }
            self.used.add(self.open["tab"].lower())

    def page(self, page, tables, min_conf):
        """The tables of one page, top to bottom. A page with no table ends
        an open one."""
        if not tables:
            self.close()
            return
        for i, t in enumerate(tables):
            if i == 0 and self.joins(t, page):
                rows, confs = t["rows"], t["confs"]
                if same_header(rows[0], self.open["header"]):
                    rows, confs = rows[1:], confs[1:]
                self.add(self.open, page, rows, confs, t, min_conf)
                self.open["odd"] += t["odd"]
                self.open["last"] = page
                self.open["to_bottom"] = t["to_bottom"]
                self.open["edges"] = t["edges"]
                continue
            self.close()
            # The first row is the header when it reads as one; else the
            # columns are `Column N` and every row is data, so a run on of a
            # table that did not join loses no row to its column names.
            has_header = header_like(t["rows"][0])
            if has_header and len(t["rows"]) < 2:
                # A header with no rows under it that goes on no table: its
                # text stays in the page's text.
                continue
            width = len(t["rows"][0])
            header = t["rows"][0] if has_header else [""] * width
            body, body_confs = (t["rows"][1:], t["confs"][1:]) if has_header else (t["rows"], t["confs"])
            rec = {
                "tab": None,
                "heading": t["heading"] or "",
                "title": t.get("title") or "",
                "header": header,
                "columns": column_names(header),
                "edges": t["edges"],
                "first": page,
                "last": page,
                "rows": 0,
                "cells": 0,
                "empty": 0,
                "odd": t["odd"],
                "low": 0,
                "methods": [],
                "to_bottom": t["to_bottom"],
                "carried": False,
                "data": [],
            }
            self.add(rec, page, body, body_confs, t, min_conf)
            self.open = rec
        if self.open is not None and not self.open["to_bottom"]:
            self.close()

    def joins(self, t, page):
        """The brief's rule (section 4.2): the open table ran to the bottom of
        its page, and this page's first table has its header, or no header
        and its column edges. One more: a new title over it starts a new
        table (TITLE_SCALE)."""
        o = self.open
        # The page right after its last: a window lost in between (the core
        # goes on from the state before it) ends the table.
        if o is None or not o["to_bottom"] or o["last"] != page - 1:
            return False
        if len(t["rows"][0]) != len(o["header"]):
            return False
        # A title is compared whole: "A1 REV 2" and "A2 REV 2" are two specs.
        if t.get("title") and norm_header([t["title"]]) != norm_header([o.get("title") or ""]):
            return False
        if same_header(t["rows"][0], o["header"]):
            return True
        return edges_match(t["edges"], o["edges"])

    def add(self, rec, page, rows, confs, t, min_conf):
        width = len(rec["header"])
        if t["method"] not in rec["methods"]:
            rec["methods"].append(t["method"])
        for r, cr in zip(rows, confs):
            r = (list(r) + [""] * width)[:width]
            rec["data"].append([page] + r)
            rec["rows"] += 1
            rec["cells"] += width
            rec["empty"] += sum(1 for c in r if not c)
            rec["low"] += sum(1 for c in cr if c is not None and c < min_conf)

    def close(self):
        if self.open is None:
            return
        rec = self.open
        self.open = None
        if rec["tab"] is None:
            rec["tab"] = self.name(rec, final=True)
        self.parts.append(rec)
        self.done.append(rec)

    def end(self, last_window):
        """The end of the window. The open table is closed on the last
        window; else its rows are written and it goes on in the next one."""
        if self.open is None:
            return None
        if last_window:
            self.close()
            return None
        rec = self.open
        if rec["tab"] is None:
            rec["tab"] = self.name(rec, final=False)
        self.parts.append(rec)
        self.open = None
        return {
            "tab": rec["tab"],
            "heading": rec["heading"],
            "title": rec["title"],
            "header": [c[:CELL_STATE_MAX] for c in rec["header"]],
            "columns": rec["columns"],
            "edges": rec["edges"],
            "first": rec["first"],
            "last": rec["last"],
            "rows": rec["rows"],
            "cells": rec["cells"],
            "empty": rec["empty"],
            "odd": rec["odd"],
            "low": rec["low"],
            "methods": rec["methods"],
            "to_bottom": rec["to_bottom"],
        }

    def name(self, rec, final):
        """`heading pN-M` (or `pN` for one page; `pN on` for a table that
        goes on past this window), cut, and ` (2)` for a second of a name."""
        head = (rec["heading"] or "Table")[:TAB_HEADING_MAX].strip() or "Table"
        a, b = rec["first"], rec["last"]
        pages = ("p%d" % a if a == b else "p%d-%d" % (a, b)) if final else "p%d on" % a
        base = "%s %s" % (head, pages)
        name, k = base, 2
        while name.lower() in self.used or name.lower() in RESERVED_TABS:
            name = "%s (%d)" % (base, k)
            k += 1
        self.used.add(name.lower())
        return name


HEADER_DIGITS_MAX = 0.15  # a header row is mostly letters: under this share of digits
HEADER_CELL_MAX = 40  # and no cell of it is longer than this


def header_like(row):
    """Whether a table's first row reads as its header: some cell has text,
    under HEADER_DIGITS_MAX of its characters are digits, and no cell is a
    sentence (HEADER_CELL_MAX). A row of data (sizes, codes, numbers) is not."""
    cells = [c or "" for c in row]
    chars = "".join(cells).replace(" ", "")
    if not chars or any(len(c) > HEADER_CELL_MAX for c in cells):
        return False
    return sum(ch.isdigit() for ch in chars) < HEADER_DIGITS_MAX * len(chars)


def column_names(header):
    """The tab's columns: Page, then the header's cells; an empty cell is
    `Column N`, a second of a name gets ` (2)`."""
    out, seen = [], {"page"}
    for i, c in enumerate(header):
        base = re.sub(r"\s+", " ", (c or "")).strip()[:COLUMN_NAME_MAX] or "Column %d" % (i + 1)
        name, k = base, 2
        while name.lower() in seen:
            name = "%s (%d)" % (base, k)
            k += 1
        seen.add(name.lower())
        out.append(name)
    return out


def quality_of(rec):
    """ok, or partial with a note that says why (the brief, section 4.4)."""
    notes = []
    if rec["odd"]:
        notes.append("%d of %d rows do not fill the header's %d columns" % (rec["odd"], rec["rows"], len(rec["header"])))
    if rec["cells"] and rec["empty"] / rec["cells"] >= EMPTY_CELLS_OK:
        notes.append("%d of %d cells are empty" % (rec["empty"], rec["cells"]))
    if rec["low"]:
        notes.append("%d cells read below the OCR confidence floor" % rec["low"])
    return ("partial" if notes else "ok"), "; ".join(notes)


# ── the step ────────────────────────────────────────────────────────────────


def window_of(request, pages_here):
    """Where this part sits in the file: its first page (1 for a whole
    file), the file's page count, and whether it is the last part. In a
    windowed run (`needs.window`) the core says `pageFrom`, `pageTo` and
    `pagesTotal` (PipelineStepRequest); with none, the part is the whole
    file."""

    def whole(v):
        return v if isinstance(v, int) and not isinstance(v, bool) and v >= 1 else None

    first = whole(request.get("pageFrom")) or 1
    total = whole(request.get("pagesTotal"))
    if total is not None:
        return first, total, first + pages_here - 1 >= total
    return first, first + pages_here - 1, True


def read_pages(path, job, opts, request):
    import pdfplumber
    import pypdfium2 as pdfium

    text_min = int(option(opts, "text_min_chars", TEXT_MIN_CHARS, 1, 10_000))
    min_conf = option(opts, "ocr_min_confidence", OCR_MIN_CONFIDENCE, 0, 100)
    dpi = option(opts, "ocr_dpi", OCR_DPI, 100, 600)
    want_tables = opts.get("tables", True) is not False

    pages = {}
    warnings = []
    tables_by_page = {}
    grids_by_page = {}

    pdf = pdfium.PdfDocument(path)
    try:
        count = len(pdf)
        first, total, last_window = window_of(request, count)
        started = time.monotonic()
        deadline = started + OCR_BUDGET_S
        job_end = started + JOB_BUDGET_S
        pool = ThreadPoolExecutor(max_workers=OCR_WORKERS)
        waiting = deque()

        def note(word_):
            if word_ not in warnings:
                warnings.append(word_)

        def finish(item):
            n, arr, drawn, png, paper, grids, faint, fut = item
            got = fut.result()
            try:
                os.remove(png)
            except OSError:
                pass
            if got is None:
                pages[n] = {"paper": paper, "method": "vision", "conf": None, "text": ""}
                note(OCR_FAILED)
            else:
                words, text, mean = got
                if faint and nonspace(text) < text_min:
                    # Almost no ink, and OCR found next to nothing: a blank
                    # page with a speck or a stamp. What OCR read is kept.
                    method = "blank"
                elif mean < min_conf:
                    method = "vision"
                elif nonspace(text) < text_min:
                    # Few words, read well: a divider or a cover is `ocr`; a
                    # figure (ink outside the words) is for vision.
                    method = "ocr" if ink_outside(arr, words) < FIGURE_INK_SHARE else "vision"
                else:
                    method = "ocr"
                pages[n] = {"paper": paper, "method": method, "conf": round(mean, 1), "text": text}
                # The layout reads words with a letter or a digit: a speck read
                # as `~` or `|` would break a row of a table.
                words = [w for w in words if any(ch.isalnum() for ch in w["text"])]
                lines = lines_of(words)
                grids_by_page[n] = len(grids)
                if want_tables and method == "ocr":
                    try:
                        tables_by_page[n] = scan_page_tables(arr.shape, grids, words, lines, n, "ocr")
                    except Exception:  # noqa: BLE001 - its text stands; its tables are not found
                        note(TABLES_FAILED)

        try:
            doc = pdfplumber.open(path)
        except Exception:  # noqa: BLE001 - pdfminer cannot parse it: every page is drawn and read
            doc = None
            note(TEXT_LAYER_FAILED)
        try:
            for i in range(count):
                n = first + i
                pl, raw, text, paper = None, [], "", "unknown"
                try:
                    if doc is not None:
                        pl = doc.pages[i]
                        w_pt, h_pt = float(pl.width), float(pl.height)
                        paper = paper_of(w_pt * 25.4 / 72, h_pt * 25.4 / 72)
                        raw = pl.extract_words(extra_attrs=["size"])
                        text = pl.extract_text() or ""
                except Exception:  # noqa: BLE001 - a page pdfminer cannot read is drawn and read
                    pl, raw, text = None, [], ""
                # A typed page: its text layer holds text_min characters, or
                # fewer on a page that is no scan and no vector figure (a
                # section divider, a title page). A typed page never goes to
                # vision.
                if pl is not None and (
                    nonspace(text) >= text_min or (nonspace(text) > 0 and typed_short(pl))
                ):
                    words = [word(w["text"], w["x0"], w["top"], w["x1"], w["bottom"]) for w in raw]
                    pages[n] = {"paper": paper, "method": "text", "conf": None, "text": text.strip()}
                    if want_tables:
                        try:
                            tables_by_page[n] = text_page_tables(pl, words, lines_of(words), n, w_pt, h_pt)
                        except Exception:  # noqa: BLE001 - its text stands; its tables are not found
                            note(TABLES_FAILED)
                    pl.close()
                    continue
                native = native_dpi(pl) if pl is not None else None
                if pl is not None:
                    pl.close()
                late = time.monotonic() > deadline
                try:
                    arr, drawn = render(pdf, i, LATE_DPI if late else ocr_dpi_of(native, dpi))
                except Exception:  # noqa: BLE001 - pdfium cannot draw the page: vision tries
                    pages[n] = {"paper": paper, "method": "vision", "conf": None, "text": ""}
                    note(RENDER_FAILED)
                    continue
                ink = float((arr < INK_LEVEL).mean())
                if ink == 0.0:
                    pages[n] = {"paper": paper, "method": "blank", "conf": None, "text": ""}
                    continue
                if late:
                    # Past the OCR budget of a window: the page goes to vision
                    # (the job's end would lose the whole window).
                    pages[n] = {"paper": paper, "method": "vision", "conf": None, "text": ""}
                    note(OCR_LATE)
                    continue
                # The ruled lines first: their grid places the words, and the
                # picture Tesseract reads leaves out the row lines.
                grids, ocr_arr = [], arr
                if want_tables:
                    try:
                        grids, ruled = ruled_grids(arr)
                        ocr_arr = np.where(ruled > 0, np.uint8(255), arr)
                    except Exception:  # noqa: BLE001 - no grid: the page is read as text
                        grids, ocr_arr = [], arr
                png = os.path.join(job, "ocr-%05d.png" % n)
                Image.fromarray(ocr_arr, "L").save(png)
                del ocr_arr
                faint = ink < BLANK_INK_SHARE
                fut = pool.submit(tesseract, png, drawn, job_end)
                waiting.append((n, arr, drawn, png, paper, grids, faint, fut))
                while len(waiting) >= OCR_IN_FLIGHT:
                    finish(waiting.popleft())
            while waiting:
                finish(waiting.popleft())
        finally:
            if doc is not None:
                doc.close()
        pool.shutdown()
    finally:
        pdf.close()
    return {
        "first": first,
        "count": count,
        "total": total,
        "last_window": last_window,
        "pages": pages,
        "tables": tables_by_page,
        "grids": grids_by_page,
        "warnings": warnings,
        "min_conf": min_conf,
    }


def heading_of_text(text):
    for ln in text.splitlines():
        h = clean_heading(ln)
        if len(h) >= 4:
            return h[:120]
    return ""


def text_col(name):
    return {"name": name, "type": "text"}


def num_col(name):
    return {"name": name, "type": "number"}


def build(read, state):
    first, count = read["first"], read["count"]
    pages = read["pages"]
    open_state = state.get("open") if isinstance(state, dict) else None
    joined = Tables(open_state)
    text_only = []
    for n in range(first, first + count):
        joined.page(n, read["tables"].get(n, []), read["min_conf"])
        if pages[n]["method"] == "vision" and read["grids"].get(n):
            text_only.append(n)
    carry = joined.end(read["last_window"])

    tabs = []
    page_rows = [
        [n, p["paper"], p["method"], p["conf"], nonspace(p["text"]), p["text"]]
        for n, p in sorted(pages.items())
    ]
    tabs.append(
        {
            "name": PAGES_TAB,
            "columns": [num_col("Page"), text_col("Paper"), text_col("Method"), num_col("Confidence"), num_col("Chars"), text_col("Text")],
            "rows": page_rows,
        }
    )
    index = []
    partial = 0
    for rec in joined.done:
        q, note = quality_of(rec)
        partial += q == "partial"
        pages_txt = "%d" % rec["first"] if rec["first"] == rec["last"] else "%d-%d" % (rec["first"], rec["last"])
        index.append([rec["tab"], rec["heading"], pages_txt, rec["rows"], len(rec["header"]), ", ".join(rec["methods"]), q, note])
    for n in text_only:
        index.append(["", heading_of_text(pages[n]["text"]), str(n), 0, 0, "vision", "text only",
                      "page %d has a ruled table that OCR read badly; vision reads the page, and its text is in the passages" % n])
    if index:
        tabs.append(
            {
                "name": TABLES_TAB,
                "columns": [text_col(c) for c in ("Tab", "Title", "Pages")]
                + [num_col("Rows"), num_col("Columns")]
                + [text_col(c) for c in ("Method", "Quality", "Note")],
                "rows": index,
            }
        )
    if not (isinstance(state, dict) and state.get("file") is True):
        # One File row for the file, with its kind: the first window that is
        # read writes it (its state says so after), so a lost window 1 does
        # not lose the kind, and with it the Agent's run.
        tabs.append(
            {
                "name": FILE_TAB,
                "columns": [text_col("Kind"), text_col("Rules kind"), num_col("Rules version"), num_col("Pages")],
                "rows": [["book", "book", PDF_KIND_RULES_VERSION, read["total"]]],
            }
        )
    for rec in joined.parts:
        if not rec["data"]:
            continue
        tabs.append(
            {
                "name": rec["tab"],
                "columns": [num_col("Page")] + [text_col(c) for c in rec["columns"]],
                "rows": rec["data"],
            }
        )

    methods = {m: sum(1 for p in pages.values() if p["method"] == m) for m in ("text", "ocr", "vision", "blank")}
    counts = dict(methods, pages=count, tables=len(joined.done), partial=partial, text_only=len(text_only))
    # The run's totals so far: the windows before this one (the state), and
    # this one. The last window's description stands for the file
    # (mergeWindowWrite), so it says the whole book.
    before = state.get("totals") if isinstance(state, dict) and isinstance(state.get("totals"), dict) else {}
    totals = {k: v + int(before.get(k) or 0) for k, v in counts.items()}
    desc = "A book of %d pages: %d text, %d OCR, %d for vision, %d blank; %d tables" % (
        read["total"], totals["text"], totals["ocr"], totals["vision"], totals["blank"], totals["tables"])
    if totals["partial"] or totals["text_only"]:
        desc += " (%d partial, %d text only; see the tab Tables)" % (totals["partial"], totals["text_only"])
    desc += "."
    if totals["pages"] < read["total"]:
        desc += " %d pages of %d are in this read." % (totals["pages"], read["total"])
    text = "\n\n".join("## Page %d\n\n%s" % (n, pages[n]["text"]) if pages[n]["text"] else "## Page %d" % n for n in sorted(pages))
    next_state = None
    if not read["last_window"]:
        next_state = {"totals": totals, "file": True}
        if carry is not None:
            next_state["open"] = carry
    return tabs, desc[:300], text, counts, next_state


def step(request, path, job):
    opts = request.get("options") or {}
    ext = str((request.get("file") or {}).get("ext", "")).lower()
    if ext != "pdf":
        return {"status": "not_mine"}
    state = request.get("state") if isinstance(request.get("state"), dict) else {}
    if state.get("facts") is True:
        # The body is a router's page facts, not the file: not a book's.
        return {"status": "not_mine"}
    try:
        read = read_pages(path, job, opts, request)
    except ImportError as e:
        return {"status": "failed", "warnings": ["a library of this Reader is missing: %s" % e.name]}
    except Exception as e:  # noqa: BLE001 - pdfium's own errors: the file is not a PDF it opens
        return {"status": "failed", "warnings": ["the PDF could not be opened: %s" % type(e).__name__]}
    tabs, desc, text, counts, next_state = build(read, state)
    result = {
        "status": "ok",
        "warnings": read["warnings"],
        "counts": counts,
        "calls": [
            {
                "call": "tool",
                "tool": "file_tabs_write",
                "input": {"tabs": tabs, "description": desc, "text": text},
            }
        ],
    }
    if next_state is not None:
        result["state"] = next_state
    return result


def main():
    job = sys.argv[1]
    with open(os.path.join(job, "request.json"), encoding="utf-8") as f:
        request = json.load(f)
    started = time.time()
    result = step(request, os.path.join(job, "in.bin"), job)
    result.setdefault("counts", {})["read_ms"] = int((time.time() - started) * 1000)
    with open(os.path.join(job, "result.json"), "w", encoding="utf-8") as f:
        json.dump(result, f)


if __name__ == "__main__":
    main()
