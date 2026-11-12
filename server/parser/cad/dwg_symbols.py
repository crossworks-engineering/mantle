"""A drawing's symbols: every block an INSERT in model space uses, keyed by
its shape and drawn once as SVG, and every such INSERT as a placement that
points at its block's key. Phase 1 of the P&ID symbol work: a rebuild tool
can later draw the drawing again from the placements and the SVGs, in the
customer's own symbols.

  symbols     one row per EXACT key: `key` (a hash of the block's own
              geometry), `shape` (the turn-free key: the same symbol at
              another turn, size or mirror has the same shape; for grouping
              only), `name` (the block's name in the file: a label, never an
              identity), `kind` ('symbol', or 'label' for a block that holds
              only ATTDEF, TEXT and MTEXT, which is not drawn), `svg`, the box
              the SVG shows in block units (`x0`, `y0`, `width`, `height`,
              the base point at 0,0), `tags` (its ATTDEF tags) and
              `placements` (how many INSERTs use it here).
  placements  one row per INSERT in model space (an array INSERT, one per
              copy): `key`, `x`, `y`, `rotation` (degrees), `xscale`,
              `yscale`, `layer`, `handle` and `tags` (its ATTRIB values by
              tag).

Names cannot be trusted: one file names two shapes alike and another names
one shape twice, so a key comes from geometry alone. The exact key hashes
every entity's DXF attributes and its path's control points (rounded), the
base point, and a nested INSERT by its own block's key; the order of the
entities does not count. The turn-free key centres the block's points on
their mean, scales by the farthest one, and hashes the sorted distances,
the sorted segment lengths and the entity kinds.

The SVG: one temporary layout per block with one reference at 0,0, drawn by
ezdxf's SVG backend on a clear ground. Its viewBox is exactly the box
(`x0`, `y0`, `width`, `height`), y up in the block and down in the SVG.

Caps, each counted in `symbol_facts`: symbols, placements, SVG bytes each,
SVG bytes in all, and a time budget. A block that fails to draw is counted
(`draw_errors`) and keeps its row with no SVG: it never fails the file.
"""

from __future__ import annotations

import hashlib
import json
import math
import time

# Measured on 1,378 real drawings: at most 650 symbols in one file, 2 to 7 KB
# of SVG each, about 1 s a file.
MAX_SYMBOLS = 2_000
MAX_PLACEMENTS = 40_000
MAX_SVG_BYTES = 256 * 1024
MAX_SVG_TOTAL = 16 * 1024 * 1024
# How deep a nested INSERT is followed for a key.
MAX_DEPTH = 8
# The kinds of a block that only labels: not drawn, kind 'label'.
LABEL_TYPES = frozenset({"ATTDEF", "TEXT", "MTEXT"})
TAG_TEXT_MAX = 512
# A key's digits: 64 bits, unique enough inside one file.
KEY_HEX = 16
# The temporary layouts the SVGs are drawn in.
LAYOUT_PREFIX = "MANTLE_SYMBOL_"


def _num(v: float, digits: int = 4) -> float:
    """A coordinate as the key reads it: rounded, -0.0 made 0.0."""
    return round(float(v), digits) + 0.0


def _val(v) -> str:
    """One DXF attribute's value as the exact key reads it."""
    if isinstance(v, float):
        return repr(_num(v))
    if hasattr(v, "x") and hasattr(v, "y"):
        return ",".join(repr(_num(c)) for c in tuple(v))
    return str(v)


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", "surrogatepass")).hexdigest()[:KEY_HEX]


def _control_points(e) -> list:
    """The control points of an entity's path (a polyline's bulges, a
    spline's poles, a hatch's boundaries), or [] for one with no path."""
    from ezdxf import path  # noqa: PLC0415 - child-only import

    try:
        if e.dxftype() in ("HATCH", "MPOLYGON"):
            paths = list(path.from_hatch(e))
        else:
            paths = [path.make_path(e)]
        return [p for one in paths for p in one.control_vertices()]
    except Exception:
        return []


class Keys:
    """The exact and the turn-free key of each block of one document, each
    worked out once."""

    def __init__(self, doc) -> None:
        self.doc = doc
        self._exact: dict = {}
        self._shape: dict = {}

    def exact(self, name: str, depth: int = 0) -> str | None:
        """The exact key, or None for a missing, empty or too deep block."""
        if name in self._exact:
            return self._exact[name]
        block = self.doc.blocks.get(name)
        if block is None or depth > MAX_DEPTH:
            return None
        self._exact[name] = None  # a block that holds itself reads as None
        parts = []
        for e in block:
            t = e.dxftype()
            attrs = e.dxfattribs(drop={"handle", "owner"})
            if t == "INSERT":
                attrs["name"] = self.exact(str(attrs.get("name", "")), depth + 1)
            part = [t] + sorted(f"{k}={_val(v)}" for k, v in attrs.items())
            if t == "MTEXT":
                part.append(f"text={getattr(e, 'text', '')}")
            part.extend(_val(p) for p in _control_points(e))
            parts.append("\x1f".join(part))
        if not parts:
            return None
        base = _val(block.block.dxf.get("base_point", (0, 0, 0)))
        key = _hash(f"base={base}\x1e" + "\x1e".join(sorted(parts)))
        self._exact[name] = key
        return key

    def shape(self, name: str, depth: int = 0) -> str | None:
        """The turn-free key, or None for a missing, empty or too deep block.
        Text counts by kind alone; a nested INSERT by its own shape."""
        if name in self._shape:
            return self._shape[name]
        block = self.doc.blocks.get(name)
        if block is None or depth > MAX_DEPTH:
            return None
        self._shape[name] = None
        pts: list = []
        segs: list = []
        kinds: list = []

        def run(t: str, seq) -> None:
            seq = [(float(p[0]), float(p[1])) for p in seq]
            pts.extend(seq)
            for a, b in zip(seq, seq[1:]):
                segs.append((t, math.hypot(b[0] - a[0], b[1] - a[1])))

        for e in block:
            t = e.dxftype()
            if t in LABEL_TYPES:
                kinds.append("T")
                continue
            if t == "INSERT":
                kinds.append(f"I:{self.shape(e.dxf.name, depth + 1)}")
                continue
            try:
                if t == "LINE":
                    run(t, [e.dxf.start, e.dxf.end])
                elif t in ("CIRCLE", "ARC"):
                    c = e.dxf.center
                    pts.append((float(c[0]), float(c[1])))
                    segs.append((t, float(e.dxf.radius)))
                elif t == "LWPOLYLINE":
                    run(t, e.get_points("xy"))
                elif t == "POLYLINE":
                    run(t, list(e.points()))
                elif t in ("SOLID", "TRACE", "3DFACE"):
                    run(t, e.vertices())
                else:
                    kinds.append(t)
            except Exception:
                kinds.append(t)
        if not pts and not kinds:
            return None
        if pts:
            cx = sum(p[0] for p in pts) / len(pts)
            cy = sum(p[1] for p in pts) / len(pts)
            far = max(math.hypot(p[0] - cx, p[1] - cy) for p in pts) or 1.0
        else:
            cx = cy = 0.0
            far = 1.0
        radii = sorted(round(math.hypot(p[0] - cx, p[1] - cy) / far, 2) for p in pts)
        lengths = sorted(f"{t}:{n / far:.2f}" for t, n in segs)
        key = _hash("|".join(sorted(kinds)) + "#" + ",".join(map(str, radii)) + "#" + ",".join(lengths))
        self._shape[name] = key
        return key


def _tag_text(raw) -> str:
    return " ".join(str(raw or "").split())[:TAG_TEXT_MAX]


def _placement(e, key: str, coord, handle: str) -> dict:
    """One INSERT as a rebuild places it: where its base point lands, its
    turn and its scales. An INSERT seen from below (extrusion -Z, a 3D
    mirror) is read from its matrix, so the mirror is in the scales."""
    ext = e.dxf.get("extrusion", (0, 0, 1))
    if abs(float(ext[2]) - 1.0) < 1e-9:
        p = e.dxf.insert
        x, y = p[0], p[1]
        rotation = float(e.dxf.get("rotation", 0.0))
        xscale = float(e.dxf.get("xscale", 1.0))
        yscale = float(e.dxf.get("yscale", 1.0))
    else:
        m = e.matrix44()
        block = e.block()
        base = block.block.dxf.get("base_point", (0, 0, 0)) if block is not None else (0, 0, 0)
        o = m.transform(base)
        ux = m.transform_direction((1, 0, 0))
        uy = m.transform_direction((0, 1, 0))
        x, y = o[0], o[1]
        rotation = math.degrees(math.atan2(ux[1], ux[0]))
        xscale = math.hypot(ux[0], ux[1])
        det = ux[0] * uy[1] - ux[1] * uy[0]
        yscale = math.copysign(math.hypot(uy[0], uy[1]), det)
    tags: dict = {}
    for attrib in getattr(e, "attribs", None) or []:
        tag = str(attrib.dxf.get("tag", "") or "").strip()
        if tag and tag not in tags:
            tags[tag] = _tag_text(attrib.dxf.get("text", ""))
    return {
        "key": key,
        "x": coord(x, 4),
        "y": coord(y, 4),
        "rotation": coord(rotation, 4),
        "xscale": coord(xscale, 6),
        "yscale": coord(yscale, 6),
        "layer": str(e.dxf.get("layer", "") or ""),
        "handle": handle,
        "tags": tags,
    }


def _inserts(msp):
    """Model space's INSERTs with their handles, an array INSERT as one
    INSERT per copy under the array's handle."""
    for e in msp:
        if e.dxftype() != "INSERT":
            continue
        handle = str(e.dxf.get("handle", "") or "")
        try:
            many = int(e.mcount) > 1
        except Exception:
            many = False
        for one in e.multi_insert() if many else [e]:
            yield one, handle


def draw_svg(doc, ctx, name: str, n: int):
    """One block drawn once: (svg, (x0, y0, width, height)), or None when it
    draws nothing (a ValueError, as ezdxf's empty bounding box). Raises what
    the drawing raises."""
    from ezdxf.addons.drawing import Frontend, layout, svg  # noqa: PLC0415
    from ezdxf.addons.drawing.properties import LayoutProperties  # noqa: PLC0415

    lname = f"{LAYOUT_PREFIX}{n}"
    while lname in doc.layouts:
        lname += "_"
    lay = doc.layouts.new(lname)
    try:
        lay.add_blockref(name, (0, 0))
        props = LayoutProperties.from_layout(lay)
        # A clear ground, white for colour 7: it resolves to black, as on
        # model.png, and a rebuild can lay the SVG over its own page.
        props.set_colors("#FFFFFF00")
        backend = svg.SVGBackend()
        Frontend(ctx, backend).draw_layout(lay, layout_properties=props)
        box = backend.player().bbox()
        if not box.has_data:
            raise ValueError("empty bounding box")
        text = backend.get_string(
            layout.Page(0, 0, layout.Units.mm, margins=layout.Margins.all(0)),
            render_box=box,
        )
        x0, y0 = box.extmin.x, box.extmin.y
        return text, (x0, y0, box.size.x, box.size.y)
    finally:
        doc.layouts.delete(lname)


def symbols_index(doc, coord, deadline: float | None = None) -> dict:
    """`symbols`, `placements` and `symbol_facts` of a document, and the
    two cap bits. Draws no SVG after `deadline` (a time.time() value)."""
    from ezdxf.addons.drawing import RenderContext  # noqa: PLC0415

    keys = Keys(doc)
    facts = {
        "inserts": 0,
        "unkeyed": 0,
        "symbols": 0,
        "drawn": 0,
        "labels": 0,
        "draw_errors": 0,
        "not_drawn": {"too_large": 0, "total_cap": 0, "time": 0},
    }
    placements: list = []
    found: dict = {}  # key -> {"name", "count"}, in first-seen order
    for e, handle in _inserts(doc.modelspace()):
        facts["inserts"] += 1
        name = str(e.dxf.get("name", "") or "")
        key = keys.exact(name)
        if key is None:
            facts["unkeyed"] += 1
            continue
        seen = found.setdefault(key, {"name": name, "count": 0})
        seen["count"] += 1
        # A named block over an anonymous one (*U12) for the label.
        if seen["name"].startswith("*") and not name.startswith("*"):
            seen["name"] = name
        if len(placements) < MAX_PLACEMENTS:
            placements.append(_placement(e, key, coord, handle))
    facts["symbols"] = len(found)
    ranked = sorted(found.items(), key=lambda kv: -kv[1]["count"])[:MAX_SYMBOLS]

    ctx = RenderContext(doc)
    total = 0
    symbols = []
    for n, (key, seen) in enumerate(ranked):
        block = doc.blocks.get(seen["name"])
        types = [e.dxftype() for e in block]
        tags = []
        for e in block:
            if e.dxftype() == "ATTDEF":
                tag = str(e.dxf.get("tag", "") or "").strip()
                if tag and tag not in tags:
                    tags.append(tag)
        row = {
            "key": key,
            "shape": keys.shape(seen["name"]),
            "name": seen["name"],
            "kind": "label" if all(t in LABEL_TYPES for t in types) else "symbol",
            "svg": None,
            "x0": None,
            "y0": None,
            "width": None,
            "height": None,
            "tags": tags,
            "placements": seen["count"],
        }
        symbols.append(row)
        if row["kind"] == "label":
            facts["labels"] += 1
            continue
        if deadline is not None and time.time() > deadline:
            facts["not_drawn"]["time"] += 1
            continue
        if total >= MAX_SVG_TOTAL:
            facts["not_drawn"]["total_cap"] += 1
            continue
        try:
            text, (x0, y0, w, h) = draw_svg(doc, ctx, seen["name"], n)
        except Exception:
            facts["draw_errors"] += 1
            continue
        size = len(text.encode("utf-8"))
        if size > MAX_SVG_BYTES:
            facts["not_drawn"]["too_large"] += 1
            continue
        if total + size > MAX_SVG_TOTAL:
            facts["not_drawn"]["total_cap"] += 1
            continue
        total += size
        facts["drawn"] += 1
        row.update(svg=text, x0=coord(x0, 6), y0=coord(y0, 6), width=coord(w, 6), height=coord(h, 6))
    facts["svg_bytes"] = total
    out = {
        "symbols": symbols,
        "placements": placements,
        "symbols_capped": len(found) > MAX_SYMBOLS,
        "placements_capped": facts["inserts"] - facts["unkeyed"] > MAX_PLACEMENTS,
        "symbol_facts": facts,
    }
    # A NaN would make index.json unparseable app side: say so, never ship it.
    json.dumps(out, allow_nan=False)
    return out
