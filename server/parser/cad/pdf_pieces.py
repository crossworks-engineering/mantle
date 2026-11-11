"""The text of a scan page, cut into numbered pieces and packed into a few
pictures, with no model: OpenCV classic functions only (./pdf_eye.py finds
where the text is).

A vision model reads small text badly on a whole-page picture: the page is
scaled down to the model's size and a 1 mm letter is a few pixels. So the
PDF sketch read (docs/file-ingestion.md, 3b) sends only the places where
text is, at the page picture's own resolution: each text area with a margin
is a piece, the pieces are packed side by side into at most MAX_PICTURES
pictures, and each piece carries its number, so one call reads many pieces
and answers `number: text`. The caller puts each text back on the page with
the piece's box.

Every box is in the page frame the brain uses: origin top left, x right, y
down, fractions of the picture's width and height.

Nothing is left out in silence: a piece that does not fit (more pieces than
MAX_PIECES, or no room left at the smallest scale) is listed in `not_sent`
with its box.
"""

from __future__ import annotations

import json
import math
import os
import sys

import cv2
import numpy as np

import pdf_eye

# Pictures one page is packed into, at most (the owner's decision P5).
MAX_PICTURES = 4
# The side of a packed picture, pixels. A vision model scales a larger
# picture down, and the letters with it.
PICTURE_SIDE = 1568
# Pieces of one page, at most; the rest are stated as not sent.
MAX_PIECES = 400
# Paper kept around a text area, millimetres: letters at the edge stay
# whole, and text areas this near are one piece.
MARGIN_MM = 1.0
# A piece shorter than this on its longer side is a speck.
MIN_PIECE_MM = 1.5
# Pieces are never packed smaller than this share of their own size.
MIN_SCALE = 0.5
GAP_PX = 8
LABEL_SCALE = 0.55
LABEL_THICKNESS = 1


def pieces_of(ink: np.ndarray, px_per_mm: float) -> list[tuple[int, int, int, int]]:
    """The pieces of one page (x, y, w, h in pixels), in reading order: the
    text areas, each grown by MARGIN_MM, with those that then touch joined
    into one."""
    areas = pdf_eye.text_areas(ink, px_per_mm)
    height, width = ink.shape
    pad = max(1, int(round(MARGIN_MM * px_per_mm)))
    mask = np.zeros((height, width), np.uint8)
    for x, y, w, h in areas:
        cv2.rectangle(mask, (max(0, x - pad), max(0, y - pad)), (min(width - 1, x + w + pad), min(height - 1, y + h + pad)), 255, -1)
    count, _, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    floor = MIN_PIECE_MM * px_per_mm + 2 * pad
    out = []
    for j in range(1, count):
        x, y, w, h = (int(v) for v in stats[j, :4])
        if max(w, h) >= floor:
            out.append((x, y, w, h))
    # Reading order: by bands of 6 mm down the page, then left to right.
    band = max(1.0, 6.0 * px_per_mm)
    out.sort(key=lambda b: (int((b[1] + b[3] / 2) // band), b[0]))
    return out


def _label_size(n: int) -> tuple[int, int]:
    (w, h), base = cv2.getTextSize(str(n), cv2.FONT_HERSHEY_SIMPLEX, LABEL_SCALE, LABEL_THICKNESS)
    return w + 6, h + base + 4


def _layout(sizes: list[tuple[int, int]], side: int) -> list[tuple[int, int, int]] | None:
    """Where each piece goes: (picture, x, y) of its cell, by shelves, in
    order. A cell is the label, then the piece. None when a cell is wider
    or higher than a picture."""
    places = []
    picture, x, y, shelf = 0, GAP_PX, GAP_PX, 0
    for n, (w, h) in enumerate(sizes, start=1):
        lw, lh = _label_size(n)
        cw, ch = lw + w + GAP_PX, max(lh, h) + GAP_PX
        if cw + GAP_PX > side or ch + GAP_PX > side:
            return None
        if x + cw > side:
            x, y, shelf = GAP_PX, y + shelf, 0
        if y + ch > side:
            picture, x, y, shelf = picture + 1, GAP_PX, GAP_PX, 0
        places.append((picture, x, y))
        x += cw
        shelf = max(shelf, ch)
    return places


def pack(grey: np.ndarray, boxes: list[tuple[int, int, int, int]], side: int = PICTURE_SIDE, max_pictures: int = MAX_PICTURES):
    """Pack the pieces into at most `max_pictures` pictures. Gives the
    pictures, one record a packed piece (its index in `boxes`, its picture
    and its scale), and the indexes left out. The scale is 1 when every
    piece fits at its own size; else all are made smaller together, down to
    MIN_SCALE, and past that the last pieces are left out."""
    keep = list(range(min(len(boxes), MAX_PIECES)))
    left_out = list(range(len(keep), len(boxes)))
    scale = 1.0
    while True:
        sizes = []
        for i in keep:
            _, _, w, h = boxes[i]
            # A piece larger than a picture is made to fit by itself.
            own = min(scale, (side - 80) / max(w, 1), (side - 40) / max(h, 1))
            sizes.append((max(1, int(w * own)), max(1, int(h * own)), own))
        places = _layout([(w, h) for w, h, _ in sizes], side)
        if places is not None and (not places or places[-1][0] < max_pictures):
            break
        if scale > MIN_SCALE:
            scale = max(MIN_SCALE, scale * 0.9)
        elif keep:
            left_out.insert(0, keep.pop())
        else:
            break
    pictures = [np.full((side, side), 255, np.uint8) for _ in range((places[-1][0] + 1) if places else 0)]
    packed = []
    for order, i in enumerate(keep):
        x, y, w, h = boxes[i]
        pw, ph, own = sizes[order]
        picture, cx, cy = places[order]
        crop = grey[y : y + h, x : x + w]
        if (pw, ph) != (w, h):
            crop = cv2.resize(crop, (pw, ph), interpolation=cv2.INTER_AREA)
        lw, lh = _label_size(order + 1)
        canvas = pictures[picture]
        cv2.putText(canvas, str(order + 1), (cx + 2, cy + lh - 4), cv2.FONT_HERSHEY_SIMPLEX, LABEL_SCALE, 0, LABEL_THICKNESS, cv2.LINE_AA)
        canvas[cy : cy + ph, cx + lw : cx + lw + pw] = crop
        cv2.rectangle(canvas, (cx + lw - 1, cy - 1), (cx + lw + pw, cy + ph), 170, 1)
        packed.append({"index": i, "picture": picture, "scale": round(own, 3)})
    return pictures, packed, left_out


def read_page(path: str, width_mm: float, out_dir: str) -> dict:
    """Cut one page picture into pieces and write the packed pictures to
    `out_dir` as `0.png`, `1.png` and so on. Raises pdf_eye.EyeError."""
    if not (width_mm > 0 and math.isfinite(width_mm)):
        raise pdf_eye.EyeError("bad_size")
    grey = pdf_eye.load_grey(path)
    height, width = grey.shape
    px_per_mm = width / width_mm
    ink = pdf_eye.binarize(grey)
    if not np.count_nonzero(ink):
        raise pdf_eye.EyeError("empty")
    boxes = pieces_of(ink, px_per_mm)
    pictures, packed, left_out = pack(grey, boxes)
    for k, picture in enumerate(pictures):
        if not cv2.imwrite(os.path.join(out_dir, f"{k}.png"), picture):
            raise pdf_eye.EyeError("write_failed")

    def box(i: int) -> list[float]:
        x, y, w, h = boxes[i]
        return [round(x / width, 5), round(y / height, 5), round((x + w) / width, 5), round((y + h) / height, 5)]

    return {
        "ok": True,
        "dpi": round(px_per_mm * 25.4, 1),
        "pictures": len(pictures),
        # In order: piece n of the answer is entry n - 1.
        "pieces": [{"box": box(p["index"]), "picture": p["picture"], "scale": p["scale"]} for p in packed],
        "not_sent": [box(i) for i in left_out],
    }


def main(argv: list[str]) -> int:
    """pdf_pieces.py <picture> <width mm> <out dir> [--threads N] writes the
    packed pictures and `pieces.json` to the out dir. A refusal is
    `{"ok": false, "code": ...}` with exit 0: an answer about the picture,
    not a crash."""
    if len(argv) < 3:
        print(json.dumps({"ok": False, "code": "bad_request"}))
        return 2
    threads = 1
    if "--threads" in argv:
        try:
            threads = max(1, int(argv[argv.index("--threads") + 1]))
        except (ValueError, IndexError):
            threads = 1
    cv2.setNumThreads(threads)
    try:
        result = read_page(argv[0], float(argv[1]), argv[2])
    except pdf_eye.EyeError as err:
        result = {"ok": False, "code": err.code}
    except ValueError:
        result = {"ok": False, "code": "bad_request"}
    with open(os.path.join(argv[2], "pieces.json"), "w", encoding="utf-8") as fh:
        json.dump(result, fh)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
