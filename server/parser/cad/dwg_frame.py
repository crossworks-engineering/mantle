"""The sheet in a model space: what a drawing's picture frames.

Model space has no paper. A note parked far to the right of the sheet, or one
stray point at the origin of a sheet drawn a kilometre away, counts in the
extents like the sheet itself, and the picture then holds the sheet in a
corner. This finds the sheet from the entities' boxes alone (pure: no ezdxf
but in `layout_frame`, so it is tested on its own).

First the border: the largest closed polyline whose box holds at least
BORDER_HOLDS of the drawing's geometry (text does not count, so notes beside
the sheet cannot move it). Everything outside it is off the sheet.

A closed box is not always the sheet, and a wrong one cuts real content, so it
loses to any of these: an entity whose box holds it (the real border is a
block, and this is a battery limit inside it), an entity outside it that spans
it from edge to edge, or thin strokes on one line outside it that do so
together (the real border is loose lines, maybe in segments), a second closed box of
about its size outside it (sheets tiled in one model space), or more than
STRAY_SHARE of all the entities outside it, text included (a title block and a
legend are mostly text). When in doubt the stray rule decides, which keeps more.

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

BORDER_HOLDS = 0.90
# A closed box this share of the border's area, outside it: a second sheet.
SECOND_SHEET_AREA = 0.5
# Closed boxes tried, largest first: the border is among the largest, and each
# failed try is a pass over the geometry.
MAX_BORDER_TRIES = 32
STRAY_SHARE = 0.10
STRAY_SPAN = 0.25
STRAY_GAP = 0.25
# Entities closer than this share of the whole span are one group, so the
# white space inside a sheet does not break it into pieces.
GROUP_GAP = 0.08
# Floating-point noise on a border's edge, as a share of its long side: a line
# this close outside the edge counts as on it.
EDGE_TOLERANCE = 1e-6
# A line no thicker than this share of the border's long side is a stroke of
# an edge, for the pieces that together run past both of its edges.
STROKE_SHARE = 0.002
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


def _holds(box, point, pad: float = 0.0) -> bool:
    return (
        box[0] - pad <= point[0] <= box[2] + pad and box[1] - pad <= point[1] <= box[3] + pad
    )


def _area(box) -> float:
    return (box[2] - box[0]) * (box[3] - box[1])


def _contains(outer, box) -> bool:
    return (
        outer != box
        and outer[0] <= box[0]
        and outer[1] <= box[1]
        and outer[2] >= box[2]
        and outer[3] >= box[3]
    )


def _long_side(box) -> float:
    return max(box[2] - box[0], box[3] - box[1])


def _on(box, b) -> bool:
    """The centre of `b` is on `box` (inside it, or out by floating-point noise
    only): every border test reads a box this way."""
    return _holds(box, _centre(b), _long_side(box) * EDGE_TOLERANCE)


def _spans(outer, box) -> bool:
    """`outer`, outside `box`, runs past both of its edges on one axis. A line
    inside a sheet can touch both edges of its border; a line outside cannot
    be longer than the sheet it is off. A line on the edge itself, out by
    floating-point noise only, is not outside."""
    if _on(box, outer):
        return False
    across = outer[0] <= box[0] and outer[2] >= box[2]
    along = outer[1] <= box[1] and outer[3] >= box[3]
    return across or along


def _covers(pieces: list, lo: float, hi: float, gap: float) -> bool:
    """The intervals `pieces` together cover lo..hi, with breaks of at most
    `gap` (a border drawn in segments meets end to end)."""
    reach = lo
    for a, b in sorted(pieces):
        if a > reach + gap:
            return False
        reach = max(reach, b)
        if reach >= hi:
            return True
    return reach >= hi


def _spans_together(entities, box) -> bool:
    """Thin strokes outside `box`, on one line, that together run past both of
    its edges: a border drawn in segments, each shorter than the box. The
    strokes are bucketed by where they sit across their own axis. A stroke
    must lie along an axis (borders are drawn square); a tilted one is not
    thin, and is left to the other rules."""
    thin = _long_side(box) * STROKE_SHARE
    rows: dict = {}
    cols: dict = {}
    for k, b in entities:
        if k == TEXT or _on(box, b):
            continue
        if b[3] - b[1] <= thin:
            at = b[1] / thin
            if math.isfinite(at):
                rows.setdefault(round(at), []).append((b[0], b[2]))
        elif b[2] - b[0] <= thin:
            at = b[0] / thin
            if math.isfinite(at):
                cols.setdefault(round(at), []).append((b[1], b[3]))
    return any(_covers(p, box[0], box[2], thin) for p in rows.values()) or any(
        _covers(p, box[1], box[3], thin) for p in cols.values()
    )


def sheet_border(entities) -> tuple | None:
    """The sheet's border among `entities` ((kind, box); kind is TEXT, CLOSED
    or OTHER), or None when no closed box is one (the header says when)."""
    geometry = [_centre(b) for k, b in entities if k != TEXT]
    closed = sorted((b for k, b in entities if k == CLOSED), key=_area, reverse=True)
    for box in closed[:MAX_BORDER_TRIES]:
        if _area(box) <= 0:
            return None
        pad = _long_side(box) * EDGE_TOLERANCE
        if sum(1 for c in geometry if _holds(box, c, pad)) < BORDER_HOLDS * len(geometry):
            continue
        if any(k != TEXT and (_contains(b, box) or _spans(b, box)) for k, b in entities):
            return None
        if _spans_together(entities, box):
            return None
        for other in closed:
            if _area(other) < _area(box) * SECOND_SHEET_AREA:
                break
            if not _on(box, other):
                return None
        outside = sum(1 for _k, b in entities if not _on(box, b))
        return None if outside > STRAY_SHARE * len(entities) else box
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
    off = [b for b in boxes if not _on(border, b)]
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
