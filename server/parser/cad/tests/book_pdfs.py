"""Made-up books for the Reader pdf-pages (pdf_pages.py): no client data.

Each page is a list of marks drawn on an A4 sheet at 200 dpi (the build
brief's generator, section 7, extended for section 4.5): a text line, or a
ruled line. One page list gives two PDFs: a SCAN (each page one gray JPEG,
with a little skew, blur and speckle) and a TEXT twin (the same words as PDF
text, the same rules as PDF lines). The truth of every table cell is kept
beside the pages.

The book:
  1      prose (GENERAL NOTES), no table
  2-4    one table over three pages, its header on each page, a title on each
  5-6    one table over two pages, its header on page 5 only
  7      a table with no ruled lines, prose under it
  8      a figure: lines and a short caption (vision)
  9      a blank page
"""

from __future__ import annotations

import io
import random

from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 1654, 2339  # A4 at 200 dpi
PT = 72 / 200  # one pixel in points
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
BODY, TITLE = 24, 34

ITEMS = ["PIPE", "ELBOW 90 LR", "ELBOW 45 LR", "TEE EQUAL", "TEE RED", "REDUCER CONC", "CAP",
         "FLANGE WN", "FLANGE BLIND", "GASKET SPW", "STUD BOLT", "GATE VALVE", "GLOBE VALVE",
         "CHECK VALVE", "BALL VALVE", "NIPPLE", "COUPLING"]
MATS = ["ASTM A106 GR B", "ASTM A234 WPB", "ASTM A105", "ASTM A193 B7", "ASTM A194 2H",
        "ASTM A312 TP316L", "ASTM A182 F316L", "API 600", "API 602"]
ENDS = ["BE", "SW", "THD", "RF", "RTJ", "PE"]
SCHS = ["SCH 40", "SCH 80", "SCH 160", "STD", "XS", "XXS", "CL150", "CL300", "CL600"]
COLS = [90, 400, 560, 720, 1130, 1260, 1560]
HEADER = ["ITEM", "SIZE", "RATING", "MATERIAL", "ENDS", "CODE"]
WORDS = ("the piping shall be supplied to this specification and tested at the shop before "
         "it is sent to site where every joint is checked by the inspector named in the order").split()


def spec_rows(rng, n):
    rows = []
    for _ in range(n):
        lo = rng.choice(["1/2", "3/4", "1", "2", "3", "4", "6", "8"])
        hi = rng.choice(["2", "4", "8", "12", "16", "24"])
        rows.append([rng.choice(ITEMS), "%s-%s" % (lo, hi), rng.choice(SCHS), rng.choice(MATS),
                     rng.choice(ENDS), "%d-%d" % (rng.randint(100, 999), rng.randint(10, 99))])
    return rows


def head(marks, page):
    marks.append(("text", 90, 90, BODY, False, "SP-00-00 MADE-UP SPEC BOOK"))
    marks.append(("text", 90, 2250, BODY, False, "PAGE %d" % page))


def ruled_table(marks, rows, header, y=290):
    """A ruled table from `y` down; returns its rows with the header first
    when there is one."""
    out = []
    if header:
        marks.append(("line", COLS[0], y - 10, COLS[-1], y - 10, 2))
        for c, t in zip(COLS, header):
            marks.append(("text", c + 8, y, BODY, False, t))
        y += 44
        out.append(list(header))
    marks.append(("line", COLS[0], y - 6, COLS[-1], y - 6, 2))
    top = y - 6 if not header else y - 54
    for r in rows:
        for c, t in zip(COLS, r):
            marks.append(("text", c + 8, y, BODY, False, t))
        y += 44
        marks.append(("line", COLS[0], y - 6, COLS[-1], y - 6, 1))
        out.append(list(r))
    for c in COLS:
        marks.append(("line", c, top, c, y - 6, 1))
    return out


def prose(marks, rng, y, lines, width=80):
    for _ in range(lines):
        text, n = "", 0
        while True:
            w = rng.choice(WORDS)
            if len(text) + len(w) + 1 > width:
                break
            text = (text + " " + w).strip()
            n += 1
        marks.append(("text", 90, y, BODY, False, text.upper()))
        y += 40
    return y


def book(seed="book-1", rows_a=40, rows_b=40):
    """The pages (each a list of marks) and the truth: the tables, each with
    its title, pages and rows ([page, cells...]), and the method each page
    should get."""
    rng = random.Random(seed)
    pages, tables = [], []

    m = []
    head(m, 1)
    m.append(("text", 90, 140, TITLE, True, "GENERAL NOTES"))
    prose(m, rng, 220, 30)
    pages.append(m)

    title_a = "PIPING MATERIAL SPECIFICATION A2C3 REV 1"
    ta = {"title": title_a, "pages": [2, 3, 4], "header": HEADER, "rows": []}
    for p in (2, 3, 4):
        m = []
        head(m, p)
        m.append(("text", 90, 140, TITLE, True, title_a))
        rows = spec_rows(rng, rows_a)
        ruled_table(m, rows, HEADER)
        ta["rows"] += [[p] + r for r in rows]
        pages.append(m)
    tables.append(ta)

    title_b = "VALVE DATA SHEET B1 REV 2"
    tb = {"title": title_b, "pages": [5, 6], "header": HEADER, "rows": []}
    m = []
    head(m, 5)
    m.append(("text", 90, 140, TITLE, True, title_b))
    rows = spec_rows(rng, rows_b)
    ruled_table(m, rows, HEADER)
    tb["rows"] += [[5] + r for r in rows]
    pages.append(m)
    m = []
    head(m, 6)
    rows = spec_rows(rng, rows_b)
    ruled_table(m, rows, None)
    tb["rows"] += [[6] + r for r in rows]
    pages.append(m)
    tables.append(tb)

    title_c = "INSTRUMENT INDEX"
    hdr_c = ["TAG", "SERVICE", "LINE", "RANGE"]
    xs = [90, 400, 900, 1300]
    tc = {"title": title_c, "pages": [7], "header": hdr_c, "rows": []}
    m = []
    head(m, 7)
    m.append(("text", 90, 140, TITLE, True, title_c))
    y = 260
    for x, t in zip(xs, hdr_c):
        m.append(("text", x, y, BODY, False, t))
    y += 50
    for _ in range(12):
        n = rng.randint(1000, 9999)
        r = ["%s-%d" % (rng.choice(["FT", "PT", "TT", "LT"]), n),
             rng.choice(["COOLING WATER", "STEAM", "FUEL GAS", "INSTRUMENT AIR"]),
             "%d-%s-%d" % (rng.choice([2, 4, 6, 8]), rng.choice(["CW", "ST", "FG", "IA"]), n),
             "0-%d %s" % (rng.choice([10, 100, 250]), rng.choice(["BARG", "DEGC", "M3/H"]))]
        for x, t in zip(xs, r):
            m.append(("text", x, y, BODY, False, t))
        tc["rows"].append([7] + r)
        y += 46
    prose(m, rng, y + 80, 6)
    pages.append(m)
    tables.append(tc)

    m = []
    head(m, 8)
    m.append(("text", 90, 140, BODY, False, "FIG 1"))
    for k in range(12):
        m.append(("line", 200 + k * 90, 400, 1400 - k * 60, 1900, 3))
        m.append(("line", 200, 400 + k * 120, 1450, 600 + k * 110, 2))
    pages.append(m)

    pages.append([])  # blank
    methods = {1: "ocr", 2: "ocr", 3: "ocr", 4: "ocr", 5: "ocr", 6: "ocr", 7: "ocr", 8: "vision", 9: "blank"}
    return pages, tables, methods


def font(size, bold):
    try:
        return ImageFont.truetype(BOLD if bold else FONT, size)
    except OSError:
        return ImageFont.load_default(size)


def scan_page(marks, rng, noise=True):
    im = Image.new("L", (W, H), 255)
    d = ImageDraw.Draw(im)
    for mk in marks:
        if mk[0] == "text":
            _, x, y, size, bold, text = mk
            d.text((x, y), text, font=font(size, bold), fill=0)
        else:
            _, x0, y0, x1, y1, wd = mk
            d.line((x0, y0, x1, y1), fill=0, width=wd)
    if noise and marks:
        im = im.rotate(rng.uniform(-0.6, 0.6), resample=Image.BICUBIC, fillcolor=255)
        im = im.filter(ImageFilter.GaussianBlur(0.6))
        px = im.load()
        for _ in range(2000):
            px[rng.randrange(W), rng.randrange(H)] = rng.randrange(0, 160)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=85)
    return buf.getvalue()


def esc(s):
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def text_content(marks):
    out = []
    for mk in marks:
        if mk[0] == "text":
            _, x, y, size, bold, text = mk
            pt = size * PT
            out.append("BT /%s %.2f Tf %.2f %.2f Td (%s) Tj ET" % ("F2" if bold else "F1", pt, x * PT, 842 - (y + 0.8 * size) * PT, esc(text)))
        else:
            _, x0, y0, x1, y1, wd = mk
            out.append("%.2f w %.2f %.2f m %.2f %.2f l S" % (wd * PT, x0 * PT, 842 - y0 * PT, x1 * PT, 842 - y1 * PT))
    return "\n".join(out).encode("latin-1")


def write_pdf(path, pages, scan, seed="book-1", noise=True):
    """`scan`: a set of page numbers (1 based) drawn as pictures; the rest
    get a text layer."""
    rng = random.Random("noise-" + seed)
    objs = {}
    n_pages = len(pages)
    kids = []
    nxt = 5
    for i, marks in enumerate(pages):
        p, c = nxt, nxt + 1
        nxt += 2
        kids.append(p)
        if (i + 1) in scan:
            jpg = scan_page(marks, rng, noise)
            img = nxt
            nxt += 1
            objs[img] = ("<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceGray "
                         "/BitsPerComponent 8 /Filter /DCTDecode /Length %d >>\nstream\n" % (W, H, len(jpg))).encode() + jpg + b"\nendstream"
            body = b"q 595 0 0 842 0 0 cm /Im0 Do Q"
            res = "/XObject << /Im0 %d 0 R >>" % img
        else:
            body = text_content(marks)
            res = "/Font << /F1 3 0 R /F2 4 0 R >>"
        objs[p] = ("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << %s >> /Contents %d 0 R >>" % (res, c)).encode()
        objs[c] = ("<< /Length %d >>\nstream\n" % len(body)).encode() + body + b"\nendstream"
    objs[1] = b"<< /Type /Catalog /Pages 2 0 R >>"
    objs[2] = ("<< /Type /Pages /Count %d /Kids [%s] >>" % (n_pages, " ".join("%d 0 R" % k for k in kids))).encode()
    objs[3] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
    objs[4] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    at = {}
    for k in sorted(objs):
        at[k] = out.tell()
        out.write(b"%d 0 obj\n" % k + objs[k] + b"\nendobj\n")
    xref = out.tell()
    size = max(objs) + 1
    out.write(b"xref\n0 %d\n0000000000 65535 f \n" % size)
    for k in range(1, size):
        out.write(b"%010d 00000 n \n" % at[k])
    out.write(b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (size, xref))
    with open(path, "wb") as f:
        f.write(out.getvalue())
