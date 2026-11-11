"""What a picture of a drawing page shows, with no model: OpenCV classic
functions only (no cv2.dnn, no model file). The PDF drawing job renders a
page (or a tile of one) to a PNG and this module reads the picture:

  eye       the axes the long lines run on (horizontal, vertical, the two
            isometric axes at 30 and 150 degrees, other), the skew, the ink
            share and a count of text areas. It tells an isometric sketch
            from a scanned letter with no text layer to go on.
  areas     the boxes where text is (not what it says), for reading a scan
            part by part at full resolution.
  segments  the straight lines of the picture: the bones of a scan.

Every result is in the page frame the brain uses: origin top left, x right,
y down, fractions of the picture's width and height. The caller places a
tile's result on its page with the tile's own box.

Limits (the private measure, docs/parser.md): a picture over MAX_PIXELS is
refused, never scaled down in silence (OpenCV's own limit is 2^30 pixels,
far over it, so this module's count is the one that refuses); lines come from the LSD detector,
never Hough; the thread count is the job's CPU share.

Constants shared with packages/files/src/pdf-kind.ts (AXIS_MIN_MM,
AXIS_TOLERANCE_DEG): a vector page and a raster page are judged by one rule.
"""

from __future__ import annotations

import json
import math
import struct
import sys

import cv2
import numpy as np

# The page render cap of the brain (packages/files/src/rasterize.ts,
# MAX_RENDER_PIXELS): no picture step runs on more.
MAX_PIXELS = 4096 * 4096
AXIS_MIN_MM = 5.0
AXIS_TOLERANCE_DEG = 3.0
# A scan is seldom tilted more than this; a larger estimate is a drawing
# with few long lines, not a tilt.
MAX_SKEW_DEG = 5.0
# Lines this long or longer vote for the skew.
SKEW_MIN_MM = 20.0


class EyeError(Exception):
    """A picture this module will not read. `code` is a fixed label."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def png_size(path: str) -> tuple[int, int] | None:
    """Width and height a PNG file declares, read from its header with no
    decode; None when the file is not a PNG."""
    try:
        with open(path, "rb") as fh:
            head = fh.read(24)
    except OSError:
        return None
    if len(head) < 24 or head[:8] != b"\x89PNG\r\n\x1a\n" or head[12:16] != b"IHDR":
        return None
    width, height = struct.unpack(">II", head[16:24])
    return width, height


def load_grey(path: str) -> np.ndarray:
    """The picture as 8-bit grey, or EyeError: unreadable, or too large.
    A PNG over the limit is refused from its header, before any pixel is
    decoded; the count after the decode holds for every other format."""
    declared = png_size(path)
    if declared and declared[0] * declared[1] > MAX_PIXELS:
        raise EyeError("too_large")
    img = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
    if img is None or img.size == 0:
        raise EyeError("unreadable")
    if img.shape[0] * img.shape[1] > MAX_PIXELS:
        raise EyeError("too_large")
    return img


def lsd_lines(grey: np.ndarray) -> np.ndarray:
    """Straight segments, one row each: x0, y0, x1, y1 in pixels."""
    found = cv2.createLineSegmentDetector(cv2.LSD_REFINE_STD).detect(grey)[0]
    if found is None:
        return np.zeros((0, 4), np.float32)
    return found.reshape(-1, 4)


def _lengths_angles(lines: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    dx = lines[:, 2] - lines[:, 0]
    dy = lines[:, 3] - lines[:, 1]
    # y grows down the picture: the angle is counterclockwise as seen.
    return np.hypot(dx, dy), np.degrees(np.arctan2(-dy, dx)) % 180.0


def skew_of(lines: np.ndarray, px_per_mm: float) -> float:
    """The tilt of the page in degrees, counterclockwise, from the long
    lines: the length-weighted median of their angles folded onto (-45, 45].
    0 when fewer than 3 lines are long enough or the estimate is past
    MAX_SKEW_DEG."""
    if len(lines) == 0:
        return 0.0
    length, angle = _lengths_angles(lines)
    keep = length >= SKEW_MIN_MM * px_per_mm
    if int(keep.sum()) < 3:
        return 0.0
    folded = (angle[keep] + 45.0) % 90.0 - 45.0
    weight = length[keep]
    order = np.argsort(folded)
    cum = np.cumsum(weight[order])
    med = float(folded[order][np.searchsorted(cum, cum[-1] / 2.0)])
    return med if abs(med) <= MAX_SKEW_DEG else 0.0


def axis_shares(lines: np.ndarray, px_per_mm: float, skew_deg: float = 0.0) -> dict:
    """Share of line length on each axis family, of the lines AXIS_MIN_MM
    long or longer, with the skew taken off. The same rule as axisShares in
    pdf-kind.ts."""
    out = {"h": 0.0, "v": 0.0, "iso": 0.0, "other": 0.0, "longMm": 0}
    if len(lines) == 0:
        return out
    length, angle = _lengths_angles(lines)
    keep = length >= AXIS_MIN_MM * px_per_mm
    length = length[keep]
    angle = (angle[keep] - skew_deg) % 180.0
    total = float(length.sum())
    if total <= 0:
        return out

    def near(x: float) -> np.ndarray:
        return np.abs(angle - x) <= AXIS_TOLERANCE_DEG

    h = near(0.0) | near(180.0)
    v = near(90.0)
    iso = near(30.0) | near(150.0)
    sums = {
        "h": float(length[h].sum()),
        "v": float(length[v].sum()),
        "iso": float(length[iso].sum()),
    }
    sums["other"] = total - sums["h"] - sums["v"] - sums["iso"]
    for key, value in sums.items():
        out[key] = round(max(0.0, value) / total, 3)
    out["longMm"] = int(round(total / px_per_mm))
    return out


def binarize(grey: np.ndarray) -> np.ndarray:
    """Ink as 255, paper as 0 (Otsu)."""
    return cv2.threshold(grey, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1]


def text_areas(ink: np.ndarray, px_per_mm: float) -> list[tuple[int, int, int, int]]:
    """Boxes (x, y, w, h in pixels) where text is: the long horizontal and
    vertical lines are taken out, the character-sized pieces that are left
    are smeared into words and lines. The measured rule (docs/parser.md):
    on grey input the boxes hold 97 to 99% of the words."""
    long_px = max(3, int(8.0 * px_per_mm))
    horizontal = cv2.morphologyEx(
        ink, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (long_px, 1))
    )
    vertical = cv2.morphologyEx(
        ink, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, long_px))
    )
    lines = cv2.dilate(horizontal | vertical, np.ones((3, 3), np.uint8))
    rest = cv2.bitwise_and(ink, cv2.bitwise_not(lines))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(rest, connectivity=8)
    if count <= 1:
        return []
    w_mm = stats[:, cv2.CC_STAT_WIDTH] / px_per_mm
    h_mm = stats[:, cv2.CC_STAT_HEIGHT] / px_per_mm
    area = stats[:, cv2.CC_STAT_AREA]
    longer = np.maximum(w_mm, h_mm)
    keep = (longer >= 0.35) & (longer <= 10.0) & (np.minimum(w_mm, h_mm) <= 6.0) & (area >= 6)
    keep[0] = False
    chars = keep[labels].astype(np.uint8) * 255
    kernel = cv2.getStructuringElement(
        cv2.MORPH_RECT, (max(3, int(1.0 * px_per_mm)), max(1, int(0.25 * px_per_mm)))
    )
    smear = cv2.morphologyEx(cv2.dilate(chars, kernel), cv2.MORPH_CLOSE, kernel)
    count2, _, stats2, _ = cv2.connectedComponentsWithStats(smear, connectivity=8)
    return [tuple(int(v) for v in stats2[j, :4]) for j in range(1, count2)]


def read_picture(
    path: str,
    width_mm: float,
    want_areas: bool = False,
    want_segments: bool = False,
) -> dict:
    """Read one picture. `width_mm` is the width on paper of what the
    picture shows (the page, or the tile). Raises EyeError."""
    if not (width_mm > 0 and math.isfinite(width_mm)):
        raise EyeError("bad_size")
    grey = load_grey(path)
    height, width = grey.shape
    px_per_mm = width / width_mm
    ink = binarize(grey)
    # A picture with not one dark pixel says nothing: it is a page that is
    # truly white, or a page whose image did not draw (the renderer goes on
    # with a white page when an image cannot be decoded). The two cannot be
    # told apart here, so it is refused and the caller names nothing from it.
    if not np.count_nonzero(ink):
        raise EyeError("empty")
    lines = lsd_lines(grey)
    skew = skew_of(lines, px_per_mm)
    areas = text_areas(ink, px_per_mm)
    out: dict = {
        "ok": True,
        "width_px": int(width),
        "height_px": int(height),
        "dpi": round(px_per_mm * 25.4, 1),
        "skew_deg": round(skew, 2),
        "axes": axis_shares(lines, px_per_mm, skew),
        "ink": round(float(np.count_nonzero(ink)) / ink.size, 4),
        "text_areas": len(areas),
    }
    if want_areas:
        out["areas"] = [
            [round(x / width, 5), round(y / height, 5), round((x + w) / width, 5), round((y + h) / height, 5)]
            for x, y, w, h in areas
        ]
    if want_segments:
        length, _ = _lengths_angles(lines) if len(lines) else (np.zeros(0), np.zeros(0))
        keep = lines[length >= 1.0 * px_per_mm] if len(lines) else lines
        out["segments"] = [
            [round(float(a) / width, 5), round(float(b) / height, 5), round(float(c) / width, 5), round(float(d) / height, 5)]
            for a, b, c, d in keep
        ]
    return out


def main(argv: list[str]) -> int:
    """pdf_eye.py <picture> <width mm> [--areas] [--segments] [--threads N]
    [--out FILE] gives one JSON object, on stdout or in FILE. A refusal is
    `{"ok": false, "code": ...}` with exit 0: it is an answer about the
    picture, not a crash."""
    if len(argv) < 2:
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
        result = read_picture(
            argv[0],
            float(argv[1]),
            want_areas="--areas" in argv,
            want_segments="--segments" in argv,
        )
    except EyeError as err:
        result = {"ok": False, "code": err.code}
    except ValueError:
        result = {"ok": False, "code": "bad_request"}
    if "--out" in argv and argv.index("--out") + 1 < len(argv):
        with open(argv[argv.index("--out") + 1], "w", encoding="utf-8") as fh:
            json.dump(result, fh)
    else:
        print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
