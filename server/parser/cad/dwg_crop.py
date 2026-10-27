"""Close-up crops of a drawing for the image check (DWG bones phase 5).

The app asks narrow questions about what the trace guessed (is this one pipe
or two, does this pipe end at that vessel) and shows a vision model a crop
of the drawing for each. This module plans and renders those crops, one
sheet per call, for the `--dwg-crop` child of app.py.

Planning is pure (no ezdxf, no matplotlib) so it is tested on its own:

  - Zoom from the drawing: the scale at which the smallest relevant TEXT in
    the window renders at about TEXT_PX pixels, never past MAX_EDGE pixels on
    the long edge. A window too small at that scale grows to MIN_EDGE so the
    model sees some context.
  - A point item is one crop centred on its spot, padded by the app (the
    whole symbol plus a stub of each pipe).
  - A path item is overlapping square crops along the path, centres half a
    window apart, so every point of the path (every joint) lies in the
    middle half of some crop and none sits only on an edge. Past
    MAX_PATH_TILES the crops zoom out instead of multiplying.
  - One small overview of the sheet, with every crop's window drawn on it.

Rendering draws the model space once with ezdxf, adds the trace overlay in
fixed, solid colours (main red, branch blue, deadleg orange: the words the
prompt uses) UNDER the drawing's own linework, and green rings on the asked
spots, and saves each window at its own size. Bounded: at most MAX_CROPS
images per call and a wall-clock deadline; what is cut is said in
`capped`, never dropped silently.
"""

from __future__ import annotations

import math
import time

TEXT_PX = 14.0
MAX_EDGE = 2000
MIN_EDGE = 480
OVERVIEW_EDGE = 1000
MAX_CROPS = 48
MAX_ITEMS = 40
MAX_PATH_TILES = 6
MAX_PATH_POINTS = 400
MAX_OVERLAY_SEGS = 20000
# Fixed overlay colours; the app names them in its questions ("red is the
# main line, blue a branch, orange a deadleg": check.ts COLOR_NOTE), so they
# are drawn SOLID: a translucent red over the white page read as pink
# (phase 5's first live run), and a model then sees a colour no prompt names.
COLORS = {"main": "#E00000", "branch": "#0050FF", "deadleg": "#FF8C00"}
OVERLAY_ALPHA = 1.0
# The overlay is drawn UNDER the drawing (ezdxf's matplotlib backend gives
# each entity a zorder from 0 up): a solid band on top would paint over the
# valve, reducer and break symbols on the traced pipe, the very symbols a
# question asks the model to read. Below, the band shows as solid colour
# on both sides of the black linework, and every symbol stays black on it.
OVERLAY_ZORDER = -1
MARK_COLOR = "#00A000"
# Pixels: overlay stroke and spot ring.
OVERLAY_PX = 5.0
RING_PX = 44.0


class SpecError(ValueError):
    """A crop spec the app sent that cannot be planned (bad shape)."""


def _num(v, what: str) -> float:
    try:
        f = float(v)
    except Exception:
        raise SpecError(f"{what} must be a number")
    if not math.isfinite(f):
        raise SpecError(f"{what} must be finite")
    return f


def _pt(v, what: str) -> tuple:
    if not isinstance(v, (list, tuple)) or len(v) != 2:
        raise SpecError(f"{what} must be [x, y]")
    return (_num(v[0], what), _num(v[1], what))


def parse_spec(spec) -> dict:
    """Validate the app's spec: items (point or path), the overlay, and the
    overview switch. Raises SpecError naming the field."""
    if not isinstance(spec, dict):
        raise SpecError("the spec must be an object")
    raw_items = spec.get("items")
    if not isinstance(raw_items, list) or not raw_items:
        raise SpecError("items must be a non-empty list")
    if len(raw_items) > MAX_ITEMS:
        raise SpecError(f"at most {MAX_ITEMS} items per call (got {len(raw_items)})")
    items = []
    for i, it in enumerate(raw_items):
        where = f"items[{i}]"
        if not isinstance(it, dict):
            raise SpecError(f"{where} must be an object")
        iid = it.get("id")
        if not isinstance(iid, str) or not iid or len(iid) > 80:
            raise SpecError(f"{where}.id must be a short string")
        kind = it.get("kind")
        pad = _num(it.get("pad"), f"{where}.pad")
        if pad <= 0:
            raise SpecError(f"{where}.pad must be above 0")
        marks = [_pt(m, f"{where}.marks") for m in (it.get("marks") or [])][:8]
        if kind == "point":
            items.append({"id": iid, "kind": "point", "at": _pt(it.get("at"), f"{where}.at"),
                          "pad": pad, "marks": marks})
        elif kind == "path":
            pts = it.get("points")
            if not isinstance(pts, list) or len(pts) < 1:
                raise SpecError(f"{where}.points must be a list of [x, y]")
            if len(pts) > MAX_PATH_POINTS:
                raise SpecError(f"{where}.points: at most {MAX_PATH_POINTS}")
            items.append({"id": iid, "kind": "path",
                          "points": [_pt(p, f"{where}.points") for p in pts],
                          "pad": pad, "marks": marks})
        else:
            raise SpecError(f"{where}.kind must be 'point' or 'path'")
    overlay = []
    total = 0
    for j, group in enumerate(spec.get("overlay") or []):
        if not isinstance(group, dict) or group.get("color") not in COLORS:
            raise SpecError(f"overlay[{j}].color must be one of {sorted(COLORS)}")
        segs = []
        for s in group.get("segs") or []:
            if total >= MAX_OVERLAY_SEGS:
                break
            if not isinstance(s, (list, tuple)) or len(s) != 4:
                raise SpecError(f"overlay[{j}].segs must hold [x1, y1, x2, y2]")
            segs.append(tuple(_num(v, f"overlay[{j}].segs") for v in s))
            total += 1
        overlay.append({"color": group["color"], "segs": segs})
    return {"items": items, "overlay": overlay, "overview": spec.get("overview", True) is not False}


def text_scale(texts, x0, y0, x1, y1, sheet_heights) -> float | None:
    """Pixels per drawing unit at which the smallest relevant text inside the
    window renders at TEXT_PX. `texts` are (x, y, height). Heights below a
    quarter of the sheet's median are noise (dimension ticks, hidden
    tags) and do not count. None when the sheet has no text at all."""
    if not sheet_heights:
        return None
    srt = sorted(sheet_heights)
    median = srt[len(srt) // 2]
    floor = median * 0.25
    inside = [h for (x, y, h) in texts if x0 <= x <= x1 and y0 <= y <= y1 and h >= floor]
    h = min(inside) if inside else median
    return TEXT_PX / h if h > 0 else None


def _window(cx, cy, half_w, half_h):
    return (cx - half_w, cy - half_h, cx + half_w, cy + half_h)


def _fit(scale, x0, y0, x1, y1, fallback_px=1200.0):
    """The scale for a window: the text scale, held to MAX_EDGE; a window
    with no text scale fits fallback_px on its long edge."""
    long_units = max(x1 - x0, y1 - y0, 1e-9)
    if scale is None:
        scale = fallback_px / long_units
    if long_units * scale > MAX_EDGE:
        scale = MAX_EDGE / long_units
    return scale


def _path_length(pts):
    return sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:]))


def _point_along(pts, d):
    """The point at arc length d along the polyline (clamped)."""
    if len(pts) == 1:
        return pts[0]
    for a, b in zip(pts, pts[1:]):
        seg = math.hypot(b[0] - a[0], b[1] - a[1])
        if d <= seg:
            t = 0.0 if seg == 0 else d / seg
            return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
        d -= seg
    return pts[-1]


def plan(items, texts) -> dict:
    """The windows to render: per item, one or more crops with their window
    in drawing units, the pixel size and the text size reached. `texts` are
    (x, y, height). Cut at MAX_CROPS, said in `capped`."""
    heights = [h for (_x, _y, h) in texts if h > 0]
    crops = []
    capped = []
    for it in items:
        made = []
        if it["kind"] == "point":
            cx, cy = it["at"]
            w = _window(cx, cy, it["pad"], it["pad"])
            scale = _fit(text_scale(texts, *w, heights), *w)
            if 2 * it["pad"] * scale < MIN_EDGE:
                half = MIN_EDGE / (2 * scale)
                w = _window(cx, cy, half, half)
            made.append((w, scale))
        else:
            pts = it["points"]
            pad = it["pad"]
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            box = (min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad)
            scale0 = text_scale(texts, *box, heights)
            scale = _fit(scale0, *box)
            if scale0 is None or scale >= scale0 * 0.999:
                # The whole path fits one crop at the text scale.
                cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
                hw, hh = (box[2] - box[0]) / 2, (box[3] - box[1]) / 2
                if 2 * max(hw, hh) * scale < MIN_EDGE:
                    hw = hh = max(hw, hh, MIN_EDGE / (2 * scale))
                made.append((_window(cx, cy, hw, hh), scale))
            else:
                # Overlapping square tiles along the path, centres half a
                # side apart; zoom out past MAX_PATH_TILES.
                length = _path_length(pts)
                side = MAX_EDGE / scale0
                if length / (side / 2) + 1 > MAX_PATH_TILES:
                    side = 2 * length / (MAX_PATH_TILES - 1)
                side = max(side, 2 * pad)
                step = side / 2
                n = max(2, int(math.ceil(length / step)) + 1)
                n = min(n, MAX_PATH_TILES)
                tile_scale = MAX_EDGE / side
                for k in range(n):
                    d = length * k / (n - 1)
                    cx, cy = _point_along(pts, d)
                    made.append((_window(cx, cy, side / 2, side / 2), tile_scale))
        for part, (w, scale) in enumerate(made):
            if len(crops) >= MAX_CROPS:
                capped.append(it["id"])
                break
            x0, y0, x1, y1 = w
            wpx = max(16, int(round((x1 - x0) * scale)))
            hpx = max(16, int(round((y1 - y0) * scale)))
            # Rounding must never push an edge past the cap.
            wpx, hpx = min(wpx, MAX_EDGE), min(hpx, MAX_EDGE)
            local = text_scale(texts, x0, y0, x1, y1, heights)
            text_px = None if local is None else round(TEXT_PX * scale / local, 1)
            crops.append({
                "id": it["id"], "part": part, "of": len(made),
                "window": [x0, y0, x1, y1], "width": wpx, "height": hpx,
                "text_px": text_px, "marks": it["marks"],
            })
    return {"crops": crops, "capped": sorted(set(capped))}


def doc_texts(doc) -> list:
    """(x, y, height) of every TEXT, MTEXT and block attribute in model space."""
    out = []
    for e in doc.modelspace():
        t = e.dxftype()
        try:
            if t == "TEXT":
                p = e.dxf.insert
                out.append((float(p[0]), float(p[1]), float(e.dxf.height)))
            elif t == "MTEXT":
                p = e.dxf.insert
                out.append((float(p[0]), float(p[1]), float(e.dxf.char_height)))
            elif t == "INSERT":
                for a in getattr(e, "attribs", []) or []:
                    p = a.dxf.insert
                    out.append((float(p[0]), float(p[1]), float(a.dxf.height)))
        except Exception:
            continue
    return [t for t in out if all(math.isfinite(v) for v in t) and t[2] > 0]


def render(doc, spec: dict, outdir: str, deadline: float) -> dict:
    """Render the planned crops and the overview into `outdir` as PNG files;
    the index says what each file holds. Stops at `deadline` (time.time())
    and says which items were cut."""
    import os  # noqa: PLC0415

    import matplotlib  # noqa: PLC0415

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt  # noqa: PLC0415
    from matplotlib.collections import LineCollection  # noqa: PLC0415
    from matplotlib.patches import Circle, Rectangle  # noqa: PLC0415
    from ezdxf.addons.drawing import Frontend, RenderContext  # noqa: PLC0415
    from ezdxf.addons.drawing.matplotlib import MatplotlibBackend  # noqa: PLC0415
    from ezdxf.addons.drawing.properties import LayoutProperties  # noqa: PLC0415

    texts = doc_texts(doc)
    planned = plan(spec["items"], texts)
    dpi = 100.0
    msp = doc.modelspace()
    fig = plt.figure(figsize=(10, 10))
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_axis_off()
    lp = LayoutProperties.from_layout(msp)
    lp.set_colors("#FFFFFF")  # white page: colour 7 resolves to black
    Frontend(RenderContext(doc), MatplotlibBackend(ax, adjust_figure=False)).draw_layout(
        msp, finalize=True, layout_properties=lp
    )
    full = (ax.get_xlim(), ax.get_ylim())
    ax.set_aspect("auto")
    overlay = []
    for g in spec["overlay"]:
        if not g["segs"]:
            continue
        lc = LineCollection(
            [((s[0], s[1]), (s[2], s[3])) for s in g["segs"]],
            colors=COLORS[g["color"]], alpha=OVERLAY_ALPHA, zorder=OVERLAY_ZORDER,
            capstyle="round",
        )
        ax.add_collection(lc)
        overlay.append(lc)

    def save(path, window, wpx, hpx, extra):
        fig.set_size_inches(wpx / dpi, hpx / dpi)
        ax.set_xlim(window[0], window[2])
        ax.set_ylim(window[1], window[3])
        for lc in overlay:
            lc.set_linewidth(OVERLAY_PX * 72.0 / dpi)
        try:
            fig.savefig(path, dpi=dpi, facecolor="white")
        finally:
            for a in extra:
                a.remove()

    out_crops = []
    cut = list(planned["capped"])
    for n, c in enumerate(planned["crops"]):
        if time.time() > deadline:
            cut.extend(x["id"] for x in planned["crops"][n:])
            break
        units_per_px = (c["window"][2] - c["window"][0]) / c["width"]
        extra = []
        for (mx, my) in c["marks"]:
            ring = Circle((mx, my), RING_PX * units_per_px, fill=False, edgecolor=MARK_COLOR,
                          linewidth=3.0 * 72.0 / dpi, zorder=60)
            ax.add_patch(ring)
            extra.append(ring)
        name = f"crop-{n}.png"
        save(os.path.join(outdir, name), c["window"], c["width"], c["height"], extra)
        out_crops.append({**c, "file": name})
    overview = None
    if spec["overview"] and time.time() <= deadline:
        (fx0, fx1), (fy0, fy1) = full
        long_units = max(fx1 - fx0, fy1 - fy0, 1e-9)
        s = OVERVIEW_EDGE / long_units
        wpx = max(16, int(round((fx1 - fx0) * s)))
        hpx = max(16, int(round((fy1 - fy0) * s)))
        extra = []
        for c in out_crops:
            x0, y0, x1, y1 = c["window"]
            r = Rectangle((x0, y0), x1 - x0, y1 - y0, fill=False, edgecolor=MARK_COLOR,
                          linewidth=2.0 * 72.0 / dpi, zorder=60)
            ax.add_patch(r)
            extra.append(r)
        save(os.path.join(outdir, "overview.png"), (fx0, fy0, fx1, fy1), wpx, hpx, extra)
        overview = {"file": "overview.png", "window": [fx0, fy0, fx1, fy1],
                    "width": wpx, "height": hpx}
    plt.close("all")
    return {"crops": out_crops, "overview": overview, "capped": sorted(set(cut))}
