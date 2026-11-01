"""The sheet in a model space: what a drawing's picture frames.

Model space has no paper. A note parked far to the right of the sheet, or one
stray point at the origin of a sheet drawn a kilometre away, counts in the
extents like the sheet itself, and the picture then holds the sheet in a
corner. This finds the sheet from the entities' boxes alone (pure: no ezdxf
but in `layout_frame`, so it is tested on its own).

First the border: the largest closed polyline whose box holds at least
BORDER_HOLDS of the drawing's geometry (text does not count, so notes beside
the sheet cannot move it). Everything outside it is off the sheet. On 32 real
drawings 31 had one, and it framed tighter than the stray rule below on 22.
A second closed box of about the same size outside it means sheets tiled in
one model space, so there is no one border.

With no border, the stray rule (`sheet_frame`). A group of entities is stray
only when all three hold, along one axis:

  - it is few: at most STRAY_SHARE of the entities still in the frame;
  - it is small: at most STRAY_SPAN of the main group's span;
  - it is far: at least STRAY_GAP of the main group's span from what stays.

Three because each alone cuts something real: a sheet tiled beside the others
can be sparse (few, but not small), a title block is small but close, and a
drawing of two equal parts has a wide gap with neither part few. A long line
from the sheet out to the note joins them, and nothing is cut: the frame is
then the whole extents, the picture a drawing always had. When in doubt, this
keeps the entity.

What is left out is reported, never dropped silently: `off_sheet` gives each
group's window and count, so a caller can go and look at it.
"""

from __future__ import annotations

import math

BORDER_HOLDS = 0.60
# A closed box this share of the border's area, outside it: a second sheet.
SECOND_SHEET_AREA = 0.5
STRAY_SHARE = 0.10
STRAY_SPAN = 0.25
STRAY_GAP = 0.25
# Entities closer than this share of the whole span are one group, so the
# white space inside a sheet does not break it into pieces.
GROUP_GAP = 0.08
# The white edge kept around a framed sheet, as a share of its long side.
FRAME_MARGIN = 0.015
# Axis passes. Cutting a stray along x can show one along y.
MAX_PASSES = 4
# Far from any real drawing's count; the reply stays small.
MAX_OFF_SHEET = 12

TEXT = "text"
CLOSED = "closed"
OTHER = "other"
TEXT_TYPES = {"TEXT", "MTEXT", "ATTDEF", "DIMENSION", "LEADER", "MULTILEADER"}


def _group(boxes: list, axis: int, tolerance: float) -> list:
    """`boxes` split into runs along an axis: a run ends where the next box
    starts past the run's far edge by more than `tolerance`."""
    lo, hi = axis, axis + 2
    ordered = sorted(boxes, key=lambda b: b[lo])
    groups = []
    current = []
    edge = -math.inf
    for b in ordered:
        if current and b[lo] > edge + tolerance:
            groups.append(current)
            current = []
            edge = -math.inf
        current.append(b)
        edge = max(edge, b[hi])
    if current:
        groups.append(current)
    return groups


def _span(group: list, axis: int) -> tuple:
    return (min(b[axis] for b in group), max(b[axis + 2] for b in group))


def _strays(groups: list, axis: int, total: int) -> list:
    """The groups to cut, walking out from the main group on each side. A
    group that stays moves the edge the next one is measured from."""
    main_at = max(range(len(groups)), key=lambda i: len(groups[i]))
    main_lo, main_hi = _span(groups[main_at], axis)
    main_span = main_hi - main_lo
    if main_span <= 0:
        return []
    strays = []
    for walk in (range(main_at + 1, len(groups)), range(main_at - 1, -1, -1)):
        edge_lo, edge_hi = main_lo, main_hi
        for i in walk:
            lo, hi = _span(groups[i], axis)
            gap = max(lo - edge_hi, edge_lo - hi)
            few = len(groups[i]) <= total * STRAY_SHARE
            small = hi - lo <= main_span * STRAY_SPAN
            if few and small and gap >= main_span * STRAY_GAP:
                strays.append(groups[i])
            else:
                edge_lo, edge_hi = min(edge_lo, lo), max(edge_hi, hi)
    return strays


def _window(group: list) -> list:
    x0, x1 = _span(group, 0)
    y0, y1 = _span(group, 1)
    return [x0, y0, x1, y1]


def _finite(box) -> bool:
    return len(box) == 4 and all(math.isfinite(v) for v in box)


def _centre(box) -> tuple:
    return ((box[0] + box[2]) / 2, (box[1] + box[3]) / 2)


def _holds(box, point) -> bool:
    return box[0] <= point[0] <= box[2] and box[1] <= point[1] <= box[3]


def _area(box) -> float:
    return (box[2] - box[0]) * (box[3] - box[1])


def sheet_border(entities) -> tuple | None:
    """The sheet's border among `entities` ((kind, box); kind is TEXT, CLOSED
    or OTHER), or None when no closed box holds the drawing, or when a second
    one of about its size sits outside it (tiled sheets)."""
    geometry = [_centre(b) for k, b in entities if k != TEXT]
    closed = sorted((b for k, b in entities if k == CLOSED), key=_area, reverse=True)
    for box in closed:
        if _area(box) <= 0:
            return None
        if sum(1 for c in geometry if _holds(box, c)) < BORDER_HOLDS * len(geometry):
            continue
        for other in closed:
            if _area(other) < _area(box) * SECOND_SHEET_AREA:
                break
            if not _holds(box, _centre(other)):
                return None
        return box
    return None


def _off_sheet(groups: list, margin: float) -> list:
    """Each group's window, a margin out so even a point has a window to
    look at, biggest first."""
    out = []
    for g in sorted(groups, key=len, reverse=True)[:MAX_OFF_SHEET]:
        x0, y0, x1, y1 = _window(g)
        out.append(
            {
                "window": [x0 - margin, y0 - margin, x1 + margin, y1 + margin],
                "entities": len(g),
            }
        )
    return out


def drawing_frame(entities) -> dict | None:
    """What to frame, from `entities` ((kind, box)): the border when there is
    one, else `sheet_frame`. The same shape as `sheet_frame`'s answer."""
    kept = [(k, tuple(b)) for k, b in entities if _finite(b)]
    if not kept:
        return None
    border = sheet_border(kept)
    boxes = [b for _k, b in kept]
    if border is None:
        return sheet_frame(boxes)
    off = [b for b in boxes if not _holds(border, _centre(b))]
    full = _window(boxes)
    if not off:
        return {"full": full, "sheet": full, "off_sheet": [], "framed": False}
    lo, hi = _span(off, 0)
    groups = _group(off, 0, max(hi - lo, border[2] - border[0]) * GROUP_GAP)
    margin = max(border[2] - border[0], border[3] - border[1]) * FRAME_MARGIN
    x0, y0, x1, y1 = border
    return {
        "full": full,
        "sheet": [x0 - margin, y0 - margin, x1 + margin, y1 + margin],
        "off_sheet": _off_sheet(groups, margin),
        "framed": True,
    }


def sheet_frame(boxes) -> dict | None:
    """What to frame, from `boxes` (x0, y0, x1, y1 of each entity): `full`,
    the whole extents; `sheet`, the window with the strays out and a small
    margin (`full` itself when nothing is stray); `off_sheet`, each stray
    group's window and entity count; `framed`, true when something was cut.
    None when there is no box to read."""
    kept = [tuple(b) for b in boxes if _finite(b)]
    if not kept:
        return None
    full = _window(kept)
    cut: list = []
    for _ in range(MAX_PASSES):
        moved = False
        for axis in (0, 1):
            lo, hi = _span(kept, axis)
            groups = _group(kept, axis, (hi - lo) * GROUP_GAP)
            if len(groups) < 2:
                continue
            strays = _strays(groups, axis, len(kept))
            if strays:
                cut.extend(strays)
                gone = {id(b) for g in strays for b in g}
                kept = [b for b in kept if id(b) not in gone]
                moved = True
        if not moved:
            break
    if not cut:
        return {"full": full, "sheet": full, "off_sheet": [], "framed": False}
    x0, y0, x1, y1 = _window(kept)
    margin = max(x1 - x0, y1 - y0) * FRAME_MARGIN
    return {
        "full": full,
        "sheet": [x0 - margin, y0 - margin, x1 + margin, y1 + margin],
        "off_sheet": _off_sheet(cut, margin),
        "framed": True,
    }


def _kind(entity) -> str:
    dxftype = entity.dxftype()
    if dxftype in TEXT_TYPES:
        return TEXT
    if dxftype == "LWPOLYLINE" and entity.closed:
        return CLOSED
    if dxftype == "POLYLINE" and entity.is_closed:
        return CLOSED
    return OTHER


def _box(entity, fast: bool):
    from ezdxf import bbox  # noqa: PLC0415 (child-only import)

    b = bbox.extents([entity], fast=fast)
    if not b.has_data:
        return None
    return (b.extmin.x, b.extmin.y, b.extmax.x, b.extmax.y)


def model_entities(layout) -> list:
    """(kind, box, entity) of each entity in `layout`, from ezdxf's quick
    boxes. An entity with no box (a block with nothing in it) gives none."""
    out = []
    for e in layout:
        try:
            box = _box(e, fast=True)
            if box is not None:
                out.append((_kind(e), box, e))
        except Exception:
            continue
    return out


def _outside(box, sheet) -> bool:
    return not _holds(sheet, _centre(box))


def layout_frame(layout) -> dict | None:
    """The frame of a layout. None when its boxes cannot be read: the picture
    then frames what it always framed.

    A quick box gives a text only its start point, so the text left out is
    measured properly, once it is known which that is: a window around a
    start point would show the first letters of a note."""
    try:
        entities = model_entities(layout)
        frame = drawing_frame([(k, b) for k, b, _e in entities])
        if frame is None or not frame["framed"]:
            return frame
        measured = []
        for kind, box, entity in entities:
            if kind == TEXT and _outside(box, frame["sheet"]):
                try:
                    box = _box(entity, fast=False) or box
                except Exception:
                    pass  # the quick box stands
            measured.append((kind, box))
        return drawing_frame(measured)
    except Exception:
        return None
