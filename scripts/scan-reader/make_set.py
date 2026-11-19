"""Scan reader bench, the page sets (docs/ai-workers.md, "The Scan reader").
Made-up pages only. Runs in the parser image (its Python has Pillow, numpy,
OpenCV, pypdfium2 and the book reader `pdf_pages`), never on the Mac:

  docker run --rm --cpus 2 -v $PWD:/w --entrypoint /opt/cad/bin/python3 <parser image> \
    /w/make_set.py /w/scans.pdf /w/scans.truth.jsonl /w/out

scans.pdf and its truth come from the large-PDF generator (`gen_test_pdfs.py
scans OUT.pdf 140`). Four sets of 12 pages: clean (as generated), fair, poor
and bad copies (fewer dots, blur, specks, skew, a faded gray copy, harsh
JPEG). Each set is written as a scanned PDF and read by the book reader's own
page marking (pdf_pages.read_pages: Tesseract, its confidence, the method);
out/set.jsonl keeps per page the truth, Tesseract's text and words with
their confidences, the page's text lines by Tesseract and by ink bands, and
a 150 dpi gray PNG (the size of a book page picture). Then cut one-page PDFs
for a PDF parser engine: `qpdf --split-pages out/<set>.pdf out/pages/<set>-%d.pdf`.
"""
import io
import json
import os
import random
import sys

import numpy as np
import pypdfium2 as pdfium
from PIL import Image, ImageFilter

sys.path.insert(0, "/app/server/parser/cad")
import pdf_pages  # noqa: E402

SRC, TRUTH, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(OUT, exist_ok=True)
truth = {}
for line in open(TRUTH):
    r = json.loads(line)
    truth[r["page"]] = r["text"]

SETS = {
    "clean": (range(1, 13), None),
    "fair": (range(37, 49), dict(dpi=150, blur=0.7, specks=6000, q=50, rot=0.8, noise=0, fade=0)),
    "poor": (range(13, 25), dict(dpi=110, blur=0.9, specks=15000, q=35, rot=1.0, noise=0, fade=0)),
    "bad": (range(25, 37), dict(dpi=90, blur=1.3, specks=30000, q=20, rot=2.0, noise=28, fade=70)),
}


def page_image(pdf, n):
    page = pdf[n - 1]
    im = page.render(scale=200 / 72, grayscale=True).to_pil().convert("L")
    page.close()
    return im


def degrade(im, rng, p):
    if p is None:
        return im, 200
    k = p["dpi"] / 200
    im = im.rotate(rng.uniform(-p["rot"], p["rot"]), resample=Image.BICUBIC, fillcolor=255)
    im = im.resize((round(im.width * k), round(im.height * k)), Image.BILINEAR)
    im = im.filter(ImageFilter.GaussianBlur(p["blur"]))
    a = np.asarray(im).astype(np.float32)
    if p["fade"]:
        # A faded photocopy: gray paper, gray ink.
        a = p["fade"] + a * (255 - 2 * p["fade"]) / 255 + p["fade"] * 0.6
    if p["noise"]:
        a = a + np.asarray([rng.gauss(0, p["noise"]) for _ in range(a.size)], np.float32).reshape(a.shape)
    a = np.clip(a, 0, 255).astype(np.uint8)
    h, w = a.shape
    for _ in range(p["specks"]):
        a[rng.randrange(h), rng.randrange(w)] = rng.randrange(0, 160)
    im = Image.fromarray(a, "L")
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=p["q"])
    return Image.open(io.BytesIO(buf.getvalue())), p["dpi"]


def band_lines(gray):
    """The text lines of a page picture with no OCR: bands of ink in ten
    vertical strips (a skew of a degree or two keeps its rows), the most of
    any strip. Specks go first (a 3 px median)."""
    h, w = gray.shape
    # Specks: a median filter drops lone dots, the letters stay.
    g = np.asarray(Image.fromarray(gray).filter(ImageFilter.MedianFilter(3)))
    ink = g < 150
    best = 0
    for k in range(0, 10):
        x0 = int(w * k / 10)
        strip = ink[:, x0 : x0 + max(8, w // 10)]
        prof = strip.mean(axis=1)
        on = prof > max(0.02, 0.15 * prof.max() if prof.max() > 0 else 1)
        n, run, gap = 0, 0, 0
        for v in on:
            if v:
                run += 1
                gap = 0
            else:
                if run >= 4:
                    n += 1
                run = 0
        best = max(best, n)
    return best


def rule_lines(gray):
    """Long horizontal ruled lines of a page picture (as ruled_grids finds
    them: a morphology open with a long kernel), counted."""
    import cv2

    h, w = gray.shape
    ink = (gray < 160).astype(np.uint8) * 255
    horiz = cv2.morphologyEx(ink, cv2.MORPH_OPEN,
                             cv2.getStructuringElement(cv2.MORPH_RECT, (max(30, w // 25), 1)))
    n, _l, stats, _c = cv2.connectedComponentsWithStats(horiz, connectivity=8)
    return int(sum(1 for k in range(1, n) if stats[k][2] >= 0.05 * w))


def write_pdf(path, jpgs):
    """One A4 page a JPEG, as the generator writes them."""
    fh = open(path, "wb")
    at = {}
    fh.write(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")

    def obj(n, body):
        at[n] = fh.tell()
        fh.write(f"{n} 0 obj\n".encode() + body + b"\nendobj\n")

    kids = " ".join(f"{3 + 3 * i} 0 R" for i in range(len(jpgs)))
    obj(1, b"<< /Type /Catalog /Pages 2 0 R >>")
    obj(2, f"<< /Type /Pages /Count {len(jpgs)} /Kids [{kids}] >>".encode())
    for i, (data, w, h) in enumerate(jpgs):
        p, img, cnt = 3 + 3 * i, 4 + 3 * i, 5 + 3 * i
        obj(p, (f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
                f"/Resources << /XObject << /Im0 {img} 0 R >> >> /Contents {cnt} 0 R >>").encode())
        obj(img, f"<< /Type /XObject /Subtype /Image /Width {w} /Height {h} /ColorSpace /DeviceGray "
                 f"/BitsPerComponent 8 /Filter /DCTDecode /Length {len(data)} >>\nstream\n".encode()
            + data + b"\nendstream")
        c = b"q 595 0 0 842 0 0 cm /Im0 Do Q"
        obj(cnt, f"<< /Length {len(c)} >>\nstream\n".encode() + c + b"\nendstream")
    xref = fh.tell()
    count = 3 + 3 * len(jpgs)
    fh.write(f"xref\n0 {count}\n0000000000 65535 f \n".encode())
    for k in range(1, count):
        fh.write(f"{at[k]:010d} 00000 n \n".encode())
    fh.write(f"trailer\n<< /Size {count} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    fh.close()


WORDS = {}
_orig = pdf_pages.tesseract


def _keep(png, dpi, end=None):
    got = _orig(png, dpi, end)
    if got is not None:
        n = int(os.path.basename(png)[4:9])
        WORDS[n] = got[0]
    return got


pdf_pages.tesseract = _keep
src = pdfium.PdfDocument(SRC)
rows = []
for name, (pages, params) in SETS.items():
    rng = random.Random(f"scan-reader-{name}")
    jpgs = []
    for n in pages:
        im, dpi = degrade(page_image(src, n), rng, params)
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=params["q"] if params else 85)
        jpgs.append((buf.getvalue(), im.width, im.height))
    path = os.path.join(OUT, f"{name}.pdf")
    write_pdf(path, jpgs)
    WORDS.clear()
    job = os.path.join(OUT, f"job-{name}")
    os.makedirs(job, exist_ok=True)
    read = pdf_pages.read_pages(path, job, {"page_pictures": False}, {})
    doc = pdfium.PdfDocument(path)
    for i, n in enumerate(pages):
        got = read["pages"][i + 1]
        page = doc[i]
        pic = page.render(scale=150 / 72, grayscale=True).to_pil().convert("L")
        page.close()
        png = f"{name}-{n:03d}.png"
        pic.save(os.path.join(OUT, png), optimize=True)
        bands_n = band_lines(np.asarray(pic))
        rows.append({"set": name, "page": n, "png": png, "method": got["method"],
                     "conf": got["conf"], "tesseract": got["text"],
                     "words": [[w["text"], round(w["conf"], 1)] for w in WORDS.get(i + 1, [])
                               if w["conf"] is not None],
                     # The free shape of the page: Tesseract's text lines (its
                     # words with a letter or digit, in rows) and the long
                     # ruled row lines of the picture.
                     "ocr_lines": len(pdf_pages.lines_of(
                         [w for w in WORDS.get(i + 1, []) if any(c.isalnum() for c in w["text"])])),
                     "rule_lines": rule_lines(pdf_pages.render(doc, i, 200)[0]),
                     "band_lines": bands_n,
                     "truth": truth[n]})
    doc.close()
with open(os.path.join(OUT, "set.jsonl"), "w") as fh:
    for r in rows:
        fh.write(json.dumps(r) + "\n")
for r in rows:
    print(r["set"], r["page"], r["method"], r["conf"])
