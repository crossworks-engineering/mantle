"""One page of a PDF, drawn again as a smaller one-page PDF that one Scan
reader call may send (server/parser/src/pdf-split.ts `fitPage`).

A large scanned drawing (an A0 sheet scanned at 300 dpi: one picture of
about 114 M pixels, 14 to 48 MB) cut as a one-page PDF is past the 10 MB
one call may send. Not read, it was a page `too_large`, and a file of such
pages was skipped as a whole. Here the page is drawn in grey by pypdfium2
(it draws a picture of any size, as the Reader `pdf-pages` does) at the
highest dpi that fits two checks, and written as a one-page PDF of one JPEG:

  - at most MAX_PIXELS pixels (PDF_MAX_IMAGE_PIXELS in
    packages/files/src/pdf-open.ts), so every reader of ours, pdfjs too,
    can draw the page it gives;
  - at most `max_bytes` bytes: from TOP_DPI down by STEP, never below
    MIN_DPI.

The page keeps its size on paper (the JPEG's dpi says it). Its colour is
lost: the Scan reader reads text, and grey is what the Reader's marks see.

Usage: pdf_fit.py <in.pdf> <out.pdf> <max_bytes>. Prints one JSON line:
{"dpi": d, "bytes": n, "width_px": w, "height_px": h}, or {"dpi": null}
when the page does not fit even at MIN_DPI (out.pdf is then not written).
"""

from __future__ import annotations

import io
import json
import math
import sys

import pypdfium2 as pdfium
from PIL import Image

# PDF_MAX_IMAGE_PIXELS (packages/files/src/pdf-open.ts).
MAX_PIXELS = 75_000_000
# A scanner's usual setting: a page is never drawn finer than this.
TOP_DPI = 300
MIN_DPI = 72
STEP = 0.8
QUALITY = 80


def fit(src: str, out: str, max_bytes: int) -> dict:
    pdf = pdfium.PdfDocument(src)
    try:
        page = pdf[0]
        w_pt, h_pt = page.get_size()
        area = max(1.0, w_pt * h_pt)
        scale = min(TOP_DPI / 72.0, math.sqrt(MAX_PIXELS / area))
        drawn = page.render(scale=scale, grayscale=True).to_pil().convert("L")
        page.close()
    finally:
        # The page's own pictures go before the tries: only `drawn` is held.
        pdf.close()
    dpi = scale * 72.0
    while True:
        k = dpi / (scale * 72.0)
        pic = drawn if k >= 1 else drawn.resize(
            (max(1, round(drawn.width * k)), max(1, round(drawn.height * k))), Image.BOX
        )
        buf = io.BytesIO()
        pic.save(buf, "PDF", resolution=dpi, quality=QUALITY)
        if buf.tell() <= max_bytes:
            with open(out, "wb") as f:
                f.write(buf.getvalue())
            return {
                "dpi": round(dpi, 1),
                "bytes": buf.tell(),
                "width_px": pic.width,
                "height_px": pic.height,
            }
        if dpi * STEP < MIN_DPI:
            return {"dpi": None}
        dpi *= STEP


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print("usage: pdf_fit.py <in.pdf> <out.pdf> <max_bytes>", file=sys.stderr)
        return 2
    print(json.dumps(fit(argv[1], argv[2], int(argv[3]))))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
