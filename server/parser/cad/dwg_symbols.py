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
              its viewBox maps to, in block units (`x0`, `y0`, `width`,
              `height`, the base point at 0,0), `hidden` (the drawing shows none of
              it: its layers are off or frozen, so it is drawn with its
              layers on), `tags` (its ATTDEF tags) and `placements` (how
              many INSERTs use it here).
  placements  one row per INSERT in model space (an array INSERT, one per
              copy): `key`, `x`, `y`, `rotation` (degrees), `xscale`,
              `yscale`, `layer`, `handle` and `tags` (its ATTRIB values by
              tag).

Names cannot be trusted: one file names two shapes alike and another names
one shape twice, so a key comes from geometry alone. The exact key hashes
each entity as ezdxf writes it to DXF (every group code, sub-entities such
as a polyline's vertices and an INSERT's ATTRIBs included), in block order,
with handles and owners left out, numbers rounded to 4 decimals, and a
nested INSERT's block name replaced by that block's own key; and the base
point. It errs on the side of two keys for one shape, never one key for two
shapes: an entity it cannot write keys by its handle. The turn-free key
centres the block's points on their mean, scales by the farthest one, and
hashes the sorted distances, the sorted segment lengths and the entity
kinds.

The SVG: one temporary layout per block with one reference at 0,0 on a
layer of its own (on, colour 7), drawn by ezdxf's SVG backend on a clear
ground with the drawing's layer state, so a part on an off layer stays out
as on the picture. A block that draws nothing that way is drawn again with
every layer on and marked `hidden`: a symbol is kept even where this drawing
hides it. The box is what was drawn, its short side padded to at least 1%
of its long side (a lone line has a height), and the page is 100 mm on its
long side. The viewBox (0 0 W H) maps to the box: its top left is (`x0`,
`y0 + height`), y up in the block and down in the SVG.

Caps, each counted in `symbol_facts`: placements (and so symbols), the
entities of one block with its nested blocks, SVG bytes each, SVG bytes in
all, and a time budget. A block that fails to draw is counted
(`draw_errors`) and keeps its row with no SVG: it never fails the file.
"""

from __future__ import annotations

import hashlib
import json
import math
import time

# Measured on 1,378 real drawings: at most 650 symbols in one file, 2 to 7 KB
# of SVG each, about 1 s a file. Symbols are no more than the placements
# kept, so every placement has its symbol's row.
MAX_PLACEMENTS = 40_000
# A block past this many entities, its nested blocks counted, is not drawn
# (not_drawn.too_large): it is a drawing held in a block, not a symbol, and
# one draw of it could pass the job's time limit.
MAX_BLOCK_ENTITIES = 5_000
MAX_SVG_BYTES = 256 * 1024
MAX_SVG_TOTAL = 16 * 1024 * 1024
# How deep a nested INSERT is followed for a key.
MAX_DEPTH = 8
# The kinds of a block that only labels: not drawn, kind 'label'.
LABEL_TYPES = frozenset({"ATTDEF", "TEXT", "MTEXT"})
TAG_TEXT_MAX = 512
# A key's digits: 64 bits, unique enough inside one file.
KEY_HEX = 16
# The temporary layouts the SVGs are drawn in, and the layer of their INSERT.
LAYOUT_PREFIX = "MANTLE_SYMBOL_"
LAYER = "MANTLE_SYMBOL_LAYER"
# The page's long side, mm, and the least short side, as a share of it.
PAGE_MM = 100.0
MIN_ASPECT = 0.01
# Group codes the key leaves out: handle, owner, reactors and their markers.
SKIP_CODES = frozenset({5, 102, 330, 360})


def _num(v: float, digits: int = 4) -> float:
    """A coordinate as the key reads it: rounded, -0.0 made 0.0."""
    return round(float(v), digits) + 0.0


def _val(v) -> str:
    """One value as the exact key reads it."""
    if isinstance(v, float):
        return repr(_num(v))
    if hasattr(v, "x") and hasattr(v, "y"):
        return ",".join(repr(_num(c)) for c in tuple(v))
    return str(v)


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", "surrogatepass")).hexdigest()[:KEY_HEX]


def _dxf_tags(e, version: str) -> list:
    """An entity as ezdxf writes it to DXF: its group codes and values."""
    from ezdxf.lldxf.tagwriter import TagCollector  # noqa: PLC0415 - child-only

    out = TagCollector(dxfversion=version)
    e.export_dxf(out)
    return out.tags


class Keys:
    """The exact and the turn-free key of each block of one document, each
    worked out once."""

    def __init__(self, doc) -> None:
        self.doc = doc
        self._exact: dict = {}
        self._shape: dict = {}
        self._size: dict = {}

    def size(self, name: str, depth: int = 0) -> int:
        """The entities of a block, its nested blocks' counted in (an array
        INSERT once per copy); past MAX_DEPTH, more than the cap. A count, so
        no block is walked twice and no geometry is read."""
        if depth > MAX_DEPTH:
            return MAX_BLOCK_ENTITIES + 1
        # By depth too: the count of a block met deep in a chain is not its
        # count at the top. A block that holds itself goes past the depth.
        if (name, depth) in self._size:
            return self._size[name, depth]
        block = self.doc.blocks.get(name)
        if block is None:
            return 0
        n = 0
        for e in block:
            n += 1
            if e.dxftype() == "INSERT":
                n += _copies(e) * self.size(str(e.dxf.get("name", "")), depth + 1)
            if n > MAX_BLOCK_ENTITIES:
                break  # past the cap the count is not needed
        self._size[name, depth] = n
        return n

    def too_large(self, name: str) -> bool:
        """A drawing held in a block, not a symbol: keyed by its name, its
        geometry never walked, never drawn."""
        return self.size(name) > MAX_BLOCK_ENTITIES

    def _part(self, e, depth: int) -> str:
        """One entity as the exact key reads it."""
        try:
            tags = _dxf_tags(e, self.doc.dxfversion)
        except Exception:
            # Never a key shared with another shape: this entity alone.
            return f"unwritten:{e.dxftype()}:{e.dxf.get('handle', id(e))}"
        out = []
        section = ""
        for tag in tags:
            code, value = tag.code, tag.value
            if code in SKIP_CODES:
                continue
            if code == 0:
                section = value
            elif code == 2 and section == "INSERT":
                # The nested block by its own key; a missing, looping or too
                # deep one by its name, so it never matches another.
                nested = self.exact(str(value), depth + 1)
                value = f"key:{nested}" if nested else f"name:{value}"
            out.append(f"{code}={_val(value)}")
        return "\x1f".join(out)

    def exact(self, name: str, depth: int = 0) -> str | None:
        """The exact key, or None for a missing, empty or too deep block."""
        if name in self._exact:
            return self._exact[name]
        block = self.doc.blocks.get(name)
        if block is None or depth > MAX_DEPTH:
            return None
        if self.too_large(name):
            # A block's name is unique in its file: never one key for two.
            self._exact[name] = _hash(f"name:{name}")
            return self._exact[name]
        self._exact[name] = None  # a block that holds itself reads as None
        h = hashlib.sha256()
        h.update(f"base={_val(block.block.dxf.get('base_point', (0, 0, 0)))}".encode())
        empty = True
        for e in block:
            empty = False
            h.update(b"\x1e" + self._part(e, depth).encode("utf-8", "surrogatepass"))
        if empty:
            return None
        self._exact[name] = h.hexdigest()[:KEY_HEX]
        return self._exact[name]

    def shape(self, name: str, depth: int = 0) -> str | None:
        """The turn-free key, or None for a missing, empty or too deep block.
        Text counts by kind alone; a nested INSERT by its own shape."""
        if name in self._shape:
            return self._shape[name]
        block = self.doc.blocks.get(name)
        if block is None or depth > MAX_DEPTH or self.too_large(name):
            return None
        self._shape[name] = None
        pts: list = []
        segs: list = []
        kinds: list = []
        reach: list = []  # a circle reaches its radius past its centre

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
                    reach.append(float(e.dxf.radius))
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
            far = max(math.hypot(p[0] - cx, p[1] - cy) for p in pts)
            # A lone bubble: its size drops out by its radius.
            far = max([far, *reach]) or 1.0
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


def _copies(e) -> int:
    """How many INSERTs an INSERT is: an array's rows by its columns."""
    try:
        return max(1, int(e.mcount))
    except Exception:
        return 1


def draw_svg(doc, ctx, name: str, n: int):
    """One block drawn once: (svg, (x0, y0, width, height)), or None when it
    draws nothing. Raises what the drawing raises. The INSERT sits on LAYER,
    which symbols_index makes before the render contexts read the layers."""
    from ezdxf.addons.drawing import Frontend, layout, svg  # noqa: PLC0415
    from ezdxf.addons.drawing.properties import LayoutProperties  # noqa: PLC0415
    from ezdxf.math import BoundingBox2d  # noqa: PLC0415

    lname = f"{LAYOUT_PREFIX}{n}"
    while lname in doc.layouts:
        lname += "_"
    lay = doc.layouts.new(lname)
    try:
        # Its own layer, on: a part on layer 0 takes the INSERT's layer, and
        # layer 0 may be off in the drawing while the INSERT's layer is on.
        lay.add_blockref(name, (0, 0), dxfattribs={"layer": LAYER})
        props = LayoutProperties.from_layout(lay)
        # A clear ground, white for colour 7: it resolves to black, as on
        # model.png, and a rebuild can lay the SVG over its own page.
        props.set_colors("#FFFFFF00")
        backend = svg.SVGBackend()
        Frontend(ctx, backend).draw_layout(lay, layout_properties=props)
        box = backend.player().bbox()
        if not box.has_data:
            return None
        # A lone line has no height and a point no size: pad the short side
        # to MIN_ASPECT of the long one (of 1 unit for a point), centred.
        w, h = box.size.x, box.size.y
        least = (max(w, h) or 1.0) * MIN_ASPECT
        w, h = max(w, least), max(h, least)
        cx, cy = box.center.x, box.center.y
        x0, y0 = cx - w / 2, cy - h / 2
        box = BoundingBox2d([(x0, y0), (x0 + w, y0 + h)])
        long_mm = PAGE_MM / max(w, h)
        page = layout.Page(w * long_mm, h * long_mm, layout.Units.mm, margins=layout.Margins.all(0))
        text = backend.get_string(page, render_box=box)
        return text, (x0, y0, w, h)
    finally:
        doc.layouts.delete(lname)


def symbols_index(doc, coord, deadline: float | None = None) -> dict:
    """`symbols`, `placements`, `placements_capped` and `symbol_facts` of a
    document. Keys no INSERT and draws no SVG after `deadline` (a
    time.time() value): an INSERT past it or past MAX_PLACEMENTS is counted,
    not keyed, so every symbol keeps a placement."""
    from ezdxf.addons.drawing import RenderContext  # noqa: PLC0415

    keys = Keys(doc)
    facts = {
        "inserts": 0,
        "unkeyed": 0,
        "symbols": 0,
        "drawn": 0,
        "labels": 0,
        "hidden": 0,
        "draw_errors": 0,
        "not_drawn": {"too_large": 0, "total_cap": 0, "time": 0},
    }
    placements: list = []
    found: dict = {}  # key -> {"name", "count"}, in first-seen order
    for e in doc.modelspace():
        if e.dxftype() != "INSERT":
            continue
        copies = _copies(e)
        if len(placements) >= MAX_PLACEMENTS or (deadline is not None and time.time() > deadline):
            facts["inserts"] += copies
            continue
        handle = str(e.dxf.get("handle", "") or "")
        name = str(e.dxf.get("name", "") or "")
        key = keys.exact(name)
        if key is None:
            facts["inserts"] += copies
            facts["unkeyed"] += copies
            continue
        # An array's copies each a placement, under the array's handle.
        for i, one in enumerate(e.multi_insert() if copies > 1 else [e]):
            if len(placements) >= MAX_PLACEMENTS:
                facts["inserts"] += copies - i
                break
            facts["inserts"] += 1
            seen = found.setdefault(key, {"name": name, "count": 0})
            seen["count"] += 1
            # A named block over an anonymous one (*U12) for the label.
            if seen["name"].startswith("*") and not name.startswith("*"):
                seen["name"] = name
            placements.append(_placement(one, key, coord, handle))
    facts["symbols"] = len(found)
    ranked = sorted(found.items(), key=lambda kv: -kv[1]["count"])

    own = doc.layers.get(LAYER) if LAYER in doc.layers else doc.layers.add(LAYER)
    own.on()
    own.thaw()
    own.color = 7
    own.dxf.discard("true_color")
    ctx = RenderContext(doc)
    # draw_svg passes its layout properties, so ezdxf keeps these layers.
    every_layer = RenderContext(doc)
    for layer in every_layer.layers.values():
        layer.is_visible = True
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
            "hidden": False,
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
        if keys.too_large(seen["name"]):
            facts["not_drawn"]["too_large"] += 1
            continue
        try:
            drawn = draw_svg(doc, ctx, seen["name"], n)
            hidden = drawn is None
            if hidden:
                drawn = draw_svg(doc, every_layer, seen["name"], n)
            # A page with nothing on it is no symbol either.
            if drawn is None or "<path" not in drawn[0]:
                raise ValueError("the block draws nothing")
        except Exception:
            facts["draw_errors"] += 1
            continue
        text, (x0, y0, w, h) = drawn
        size = len(text.encode("utf-8"))
        if size > MAX_SVG_BYTES:
            facts["not_drawn"]["too_large"] += 1
            continue
        if total + size > MAX_SVG_TOTAL:
            facts["not_drawn"]["total_cap"] += 1
            continue
        total += size
        facts["drawn"] += 1
        facts["hidden"] += hidden
        row["hidden"] = hidden
        row.update(svg=text, x0=coord(x0, 6), y0=coord(y0, 6), width=coord(w, 6), height=coord(h, 6))
    facts["svg_bytes"] = total
    out = {
        "symbols": symbols,
        "placements": placements,
        "placements_capped": facts["inserts"] - facts["unkeyed"] > len(placements),
        "symbol_facts": facts,
    }
    # A NaN would make index.json unparseable app side: say so, never ship it.
    json.dumps(out, allow_nan=False)
    return out
