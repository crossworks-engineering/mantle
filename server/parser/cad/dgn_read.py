"""MicroStation DGN into ONE in-memory ezdxf document, so a DGN drawing takes
the same road as a DWG or DXF one: the registry, the bones, the picture and
the crops all read the document this module returns and never know it came
from a DGN. The reader is ezdgn (MIT, Rust core, no ODA): native V8, and V7
2D. A V7 3D file is refused, the same way as a DWG no converter can read.

The mapping, in master units:
  levels                 -> layers, by level name (V7 has numbers only).
                            DXF refuses " * / : ; < = > ? \\ and ` in a
                            layer name: each becomes "_", and the index
                            lists every level so renamed, and every level
                            that shares a layer with another
  LINE                   -> LINE
  LINE_STRING            -> LWPOLYLINE (two points -> LINE)
  SHAPE                  -> closed LWPOLYLINE
  POINT_STRING           -> one POINT a vertex
  CURVE                  -> SPLINE through the points; the first two and
                            the last two points of a DGN curve set the end
                            slopes and are not drawn
  ARC                    -> ARC (circular) or ELLIPSE with parameters
  ELLIPSE                -> CIRCLE or ELLIPSE
                            (a 3D one turns by a quaternion: in the plan it
                            takes the same road; tilted, it is an ELLIPSE
                            with its true axes and normal)
  TEXT, TEXT_NODE texts  -> TEXT at the text origin, height, rotation; a
                            negative size (mirrored text) sets the DXF
                            mirror flags
  COMPLEX_CHAIN / SHAPE  -> their components, each as above
  CELL                   -> a block and an INSERT at the cell origin. DGN
                            keeps cell components in design coordinates and
                            a plain cell is not a shared definition, so the
                            block holds the components less the origin and
                            the insert has no rotation or scale. Placements
                            with one name and one geometry share a block;
                            the same name with other geometry inserts
                            "<name>#2" and so on. The index's `cells` gives
                            each cell name with its true placement count
                            and its blocks. Texts of a cell (and of cells
                            inside it) become ATTRIBs of the top insert, so
                            the registry reads them. ezdgn 0.3.2 leaves a
                            V8 cell's name empty; it is read from the
                            cell's name linkage, the same linkage ezdgn
                            reads a shared cell's name from.
  SHARED_CELL_INSTANCE   -> an INSERT of an empty block with the shared
                            cell's name: ezdgn does not expand shared cells,
                            so their geometry is not drawn (counted in
                            `shared_cells_not_expanded`)

Models: the model with the most converted elements is the drawing, in model
space (a tie goes to the first). Every other model with elements is
converted into a block of its own, kept apart from the drawing; an empty
model is listed and skipped. The registry, the bones and the picture read
model space only, so the index lists every model with its elements and
texts, and the note says how many are not read.

3D: every point is projected to XY (Z is dropped, so a wild Z cannot reach
the extents, the frame or the picture). The index counts the elements that
are not flat in Z and those with a wild Z. ezdgn 0.3.2 does not decode the
turn of a 3D text: it is drawn unturned and counted.

Never a silent loss. Each element record ezdgn gives is marked when it is
converted or counted as not converted. After the walk, a record that was
never reached (under no top-level element, past the depth limit, or under
an element kind that has no components) is counted as not converted by its
kind and raw element type, and as `unreached`. A record referenced a second
time is drawn once and counted as `repeated`. The index compares the total
with ezdgn's record count and states any gap. Also counted: dimensions,
tags, B-spline curves and their poles and knots, raster frames, unknown
types, and a coordinate that is not finite or past WILD. A file with a
raster frame and almost no vector content is a scan in a DGN wrapper, and
the index says so.

ezdgn's own scan limits apply (file size, records, objects, vertices,
hierarchy depth); the job's time and memory limits stay the backstop. No
network, and nothing is written: the document lives in memory.
"""

from __future__ import annotations

import hashlib
import math
import re

# Leading bytes. V8 is a compound file (CFB); ezdgn checks the DGN markers
# inside. V7 starts with its TCB record header: level 8 (0x08, 2D) or the
# 3D flag set (0xC8), type 9, 0x02FE words to follow.
CFB_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
V7_2D = b"\x08\x09\xfe\x02"
V7_3D = b"\xc8\x09\xfe\x02"

# Raw element types that ezdgn does not decode, by name. Others are listed
# by number only.
TYPE_NAMES = {
    26: "bspline_knot",
    28: "bspline_weight",
    33: "dimension",
    37: "tag",
    94: "raster_frame",
}
RASTER_FRAME = 94
# A file with a raster frame and at most this many converted elements is a
# scan in a DGN wrapper (on the private test set: at most 19 for a scan,
# at least 2,100 for a vector drawing).
RASTER_ONLY_MAX = 50
# A coordinate or size beyond this, in master units, is wild: the element
# is not converted and is counted (a 3D model's Z is counted apart, as the
# plan drops Z).
WILD = 1e9
# Components deeper than this are not walked (ezdgn's own V8 limit); they
# are counted as unreached.
MAX_DEPTH = 256
# Rows of the index lists (`cells`, `levels_changed`), and block names in
# one `cells` row. The totals are kept beside them.
MAX_ROWS = 20_000
MAX_ROW_BLOCKS = 100
# V7 control records: design settings (9), digitizer setup (8) and level
# symbology (10). Not drawing content, so not in the element count.
V7_CONTROL_TYPES = (8, 9, 10)
# Master unit label -> DXF $INSUNITS.
UNITS = {"mm": 4, "cm": 5, "m": 6, "km": 7, "in": 1, '"': 1, "ft": 2, "'": 2, "um": 13}
# Exactly the characters ezdxf refuses in a table name (layer, block).
_BAD_NAME = re.compile(r'[<>/\\":;?*=`]')
CIRCLE_REL_TOL = 1e-6
ORIGIN = (0.0, 0.0, 0.0)


class DgnRefused(Exception):
    """The file is a DGN that Mantle does not read. The message is the
    curated reason, fixed text with no path."""


def is_dgn(head: bytes) -> bool:
    """True when the leading bytes are a DGN signature (V7) or a compound
    file (a V8 candidate: ezdgn checks the DGN markers in it)."""
    return head[:8] == CFB_MAGIC or head[:4] in (V7_2D, V7_3D)


# ── one element tree, whatever the DGN version ──────────────────────────


class Node:
    """One DGN element: kind, layer, raw element type, the geometry the
    writer needs (`g`), its components, and its record index in the model
    (`i`; None for a node made by hand)."""

    __slots__ = ("kind", "layer", "etype", "g", "kids", "i")

    def __init__(self, kind: str, layer: str, etype, g=None, kids=None, i=None):
        self.kind = kind
        self.layer = layer
        self.etype = etype
        self.g = g or {}
        self.kids = kids or []
        self.i = i


def _p3(p) -> tuple:
    """A point projected to XY. A 3D model is drawn in the plan, and a wild
    Z (a real file holds one near 9e17) cannot reach the extents, the frame
    or the picture."""
    if p is None:
        return None
    return (float(p[0]), float(p[1]), 0.0)


def quat_axes(q) -> tuple:
    """The local X and Y axes of a 3D element from its quaternion (w, x, y,
    z): the rows of the rotation matrix, the rule ezdgn uses for V7 3D (it
    checked the rule on the ranges of 400 real ellipses). A zero quaternion
    is no turn."""
    w, x, y, z = (float(v) for v in q)
    norm = math.sqrt(w * w + x * x + y * y + z * z)
    if not math.isfinite(norm) or norm <= 1e-12:
        return ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0))
    w, x, y, z = w / norm, x / norm, y / norm, z / norm
    xa = (1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y - z * w), 2.0 * (x * z + y * w))
    ya = (2.0 * (x * y + z * w), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z - x * w))
    return (xa, ya)


def _linkage_name(raw) -> str:
    """The name in an element's name linkage, read with ezdgn's own decoder
    (the one it uses for level and shared cell names), or "". ezdgn 0.3.2
    gives a V8 cell no name of its own."""
    try:
        from ezdgn import v8  # noqa: PLC0415 - child-only import

        return v8._name_linkage(raw.attribute_bytes) or ""
    except Exception:  # noqa: BLE001 - no linkage, no ezdgn: no name
        return ""


def _tree(elements, build, top_of, record_of) -> dict:
    """The element tree of one model's records: each top-level record and
    its components, each record at most once. `build(e, i)` makes the Node
    of record i; `top_of(e)` says whether a record starts the tree;
    `record_of(e)` is its (kind, raw type) for the count, or None when it
    is not drawing content. Returns the top nodes, the records, and how
    many references repeat a record already in the tree."""
    seen: set = set()
    repeated = 0
    count = len(elements)

    def node(i: int, depth: int):
        nonlocal repeated
        if i in seen:
            repeated += 1
            return None
        seen.add(i)
        e = elements[i]
        n = build(e, i)
        if depth < MAX_DEPTH:
            for j in e.child_indices:
                if 0 <= j < count:
                    kid = node(j, depth + 1)
                    if kid is not None:
                        n.kids.append(kid)
        return n

    records = [record_of(e) for e in elements]
    top = [node(i, 0) for i, e in enumerate(elements) if records[i] is not None and top_of(e)]
    return {"top": [n for n in top if n is not None], "records": records, "repeated": repeated}


class _Levels:
    """Level -> layer name, once a level, and the levels whose layer name is
    not their own: renamed (a character DXF refuses), or sharing one layer
    with another level."""

    def __init__(self, names: dict):
        self.names = names
        self.layers: dict = {}
        self.users: dict = {}

    def layer(self, level) -> str:
        lay = self.layers.get(level)
        if lay is None:
            name = self.names.get(level) or str(level)
            lay = self.layers[level] = _layer(name)
            self.users.setdefault(lay, []).append(name)
        return lay

    def changed(self) -> list:
        out = []
        for lay, names in self.users.items():
            for name in names:
                if name != lay or len(names) > 1:
                    out.append({"level": name, "layer": lay})
        return out


def _v8_tree(doc) -> tuple[list, dict]:
    """One entry a model of a V8 document (name, dimension, element tree,
    records, records not flat in Z, records with a wild Z), and the facts
    for the index."""
    models = list(doc.models)
    if not models:
        raise DgnRefused("the DGN holds no model")
    names = {}
    for lv in doc.levels:
        if lv.name and lv.level_id not in names:
            names[lv.level_id] = lv.name
    levels = _Levels(names)

    def tree(model) -> dict:
        elements = model.elements
        md = model.metadata
        # A stored range is rounded out to whole UOR: 2 UOR is still flat.
        flat_tol = 2.0 / md.uor_per_master if md.uor_per_master else 0.0

        def build(e, i) -> Node:
            d = e.data
            kind = e.kind
            n = Node(kind, levels.layer(e.level), e.raw.element_type, i=i)
            if d.vertices:
                n.g["pts"] = [_p3(v.master) for v in d.vertices]
            if d.center is not None:
                n.g["c"] = _p3(d.center.master)
                n.g["a"] = d.primary_axis_master
                n.g["b"] = d.secondary_axis_master
                n.g["start"] = d.start_angle_degrees
                n.g["sweep"] = d.sweep_angle_degrees
            if d.origin is not None:
                n.g["o"] = _p3(d.origin.master)
            if kind == "TEXT":
                n.g["text"] = d.text
                n.g["h"] = d.height_master
                n.g["w"] = d.width_master
            if kind == "CELL":
                n.g["name"] = d.name or _linkage_name(e.raw)
            elif kind == "SHARED_CELL_INSTANCE":
                n.g["name"] = d.name or ""
            rot = d.rotation_degrees
            if rot is not None:
                n.g["rot"] = rot
            elif kind in ("ARC", "ELLIPSE") and len(d.orientation) == 4:
                # A 3D arc or ellipse turns by a quaternion, not an angle.
                n.g["axes"] = quat_axes(d.orientation)
            elif kind in ("ARC", "ELLIPSE", "TEXT"):
                # No turn decoded. An arc or ellipse is not converted; a 3D
                # text (ezdgn 0.3.2 gives six numbers here that are its size,
                # not its turn) is drawn unturned and counted in
                # `text_turn_unknown`.
                n.g["rot"] = None
            else:
                n.g["rot"] = 0.0
            return n

        out = _tree(elements, build, lambda e: e.parent_index is None,
                    lambda e: (e.kind, e.raw.element_type))
        not_flat = wild = 0
        # A 2D model has no Z: its ranges' Z is not read.
        for e in elements if md.dimension == 3 else ():
            try:
                (_lx, _ly, lz), (_hx, _hy, hz) = e.common.range_master
                if not _finite(lz, hz) or max(abs(lz), abs(hz)) > WILD:
                    wild += 1
                elif hz - lz > flat_tol:
                    not_flat += 1
            except (TypeError, ValueError):
                continue
        out.update(name=md.name or "", dimension=int(md.dimension), unit=md.master_unit,
                   not_flat=not_flat, wild_z=wild)
        return out

    trees = [tree(m) for m in models]
    return trees, {"format": "V8", "levels_changed": levels.changed()}


def _v7_tree(drawing) -> tuple[list, dict]:
    """Nodes of a V7 2D drawing, and the facts for the index."""
    elements = drawing.elements
    settings = drawing.design_settings
    master = settings.scale is not None

    def pts(seq_master, seq_uor):
        seq = seq_master if master and seq_master is not None else seq_uor
        return [_p3(p) for p in seq]

    def pick(m, u):
        return m if master and m is not None else u

    def build(e, i) -> Node:
        kind = e.kind
        etype = e.record.element_type
        n = Node(kind, _layer(str(e.level)), etype, i=i)
        g = n.g
        if kind == "LINE":
            g["pts"] = pts(
                (e.start_master, e.end_master) if e.start_master is not None else None,
                (e.start_uor_precise, e.end_uor_precise),
            )
        elif kind in ("LINE_STRING", "SHAPE", "CURVE"):
            g["pts"] = pts(e.vertices_master, e.vertices_uor_precise)
        elif kind in ("ARC", "ELLIPSE"):
            g["c"] = _p3(pick(e.center_master, e.center_uor))
            g["a"] = pick(e.primary_axis_master, e.primary_axis_uor)
            g["b"] = pick(e.secondary_axis_master, e.secondary_axis_uor)
            g["rot"] = e.rotation_degrees
            if kind == "ARC":
                g["start"] = e.start_angle_degrees
                g["sweep"] = e.sweep_angle_degrees
        elif kind == "TEXT":
            g["o"] = _p3(pick(e.origin_master, e.origin_uor))
            g["h"] = pick(e.height_multiplier_master, e.height_multiplier_raw)
            g["w"] = pick(e.length_multiplier_master, e.length_multiplier_raw)
            g["rot"] = e.rotation_degrees
            # V7 names no code page; latin-1 never fails and keeps ASCII.
            # The index says so (`text_encoding`).
            g["text"] = e.decode_text("latin-1")
        elif kind in ("CELL", "SHARED_CELL_INSTANCE", "TEXT_NODE"):
            g["o"] = _p3(pick(e.origin_master, e.origin_uor))
            g["name"] = getattr(e, "name", "") or ""
        return n

    def record_of(e):
        if e.parent_index is None and (e.record.element_type in V7_CONTROL_TYPES or e.kind == "COLOR_TABLE"):
            return None
        return (e.kind, e.record.element_type)

    out = _tree(elements, build, lambda e: e.parent_index is None, record_of)
    out.update(name="", dimension=2, unit=settings.master_unit_name if master else "uor",
               not_flat=0, wild_z=0)
    control = sum(1 for r in out["records"] if r is None)
    return [out], {"format": "V7 2D", "control_records": control, "text_encoding": "latin-1"}


# ── element tree -> drawing operations ──────────────────────────────────


def _finite(*values) -> bool:
    try:
        return all(math.isfinite(float(v)) for v in values)
    except (TypeError, ValueError):
        return False


def _sane(*values) -> bool:
    """Finite, and within WILD: a coordinate or size the drawing can use."""
    try:
        return all(math.isfinite(float(v)) and abs(float(v)) <= WILD for v in values)
    except (TypeError, ValueError):
        return False


def _sub(p, off) -> tuple:
    return (p[0] - off[0], p[1] - off[1], p[2] - off[2])


def _clean_name(name: str) -> str:
    """A DXF table name: the characters ezdxf refuses become "_"; nothing
    else changes (case, spaces and control characters stay, so `Circuit
    <name>` levels keep the shape the bones read circuits from)."""
    return _BAD_NAME.sub("_", str(name or ""))


def _layer(name: str) -> str:
    return _clean_name(name) if str(name or "").strip() else "0"


def _cross(u, v) -> tuple:
    return (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])


def _arc_ops(n: Node, off) -> list | None:
    """ARC, CIRCLE or ELLIPSE as one op, or None when the geometry is not
    usable. The DGN curve is c + a cos(t) X + b sin(t) Y on the element's
    local axes X and Y: turned by `rot` in 2D, from the quaternion in 3D."""
    g = n.g
    c, a, b, rot, axes = g.get("c"), g.get("a"), g.get("b"), g.get("rot"), g.get("axes")
    if c is None or not _sane(*c, a, b) or a <= 0 or b <= 0:
        return None
    if axes is not None:
        xa, ya = axes
    elif rot is not None and _finite(rot):
        r = math.radians(rot)
        xa, ya = (math.cos(r), math.sin(r), 0.0), (-math.sin(r), math.cos(r), 0.0)
    else:
        return None
    if not _finite(*xa, *ya):
        return None
    c = _sub(c, off)
    full = n.kind == "ELLIPSE"
    start = sweep = 0.0
    if not full:
        start, sweep = g.get("start"), g.get("sweep")
        if not _finite(start, sweep) or sweep == 0:
            return None
        full = abs(sweep) >= 360.0
    normal = _cross(xa, ya)
    if normal[2] < -0.999999:
        # Seen from below (a mirrored element): Y turned over and t with it.
        ya = (-ya[0], -ya[1], -ya[2])
        start, sweep = -start, -sweep
        normal = _cross(xa, ya)
    if not full and sweep < 0:
        start, sweep = start + sweep, -sweep
    if normal[2] > 0.999999:
        # In the plan: the 2D road, so a circular arc stays an ARC (pipe).
        rot = math.degrees(math.atan2(xa[1], xa[0]))
        if abs(a - b) <= CIRCLE_REL_TOL * max(a, b):
            if full:
                return ["circle", n.layer, c, a]
            return ["arc", n.layer, c, a, rot + start, rot + start + sweep]
        normal = None
    # DXF wants the long axis as the major one: with b > a it is Y, and t
    # runs 90 degrees behind (the minor axis is normal x major, so -X).
    if b > a:
        a, b = b, a
        xa = ya
        start -= 90.0
    major = (a * xa[0], a * xa[1], a * xa[2])
    p0, p1 = (0.0, math.tau) if full else (math.radians(start), math.radians(start + sweep))
    op = ["ellipse", n.layer, c, major, b / a, p0, p1]
    if normal is not None:
        op.append(normal)
    return op


class _Ops:
    """Walks the element tree into drawing ops for model space and blocks,
    and keeps the converted and not-converted counts. Every node it
    handles is marked (`handled`), so a model's records it never reached
    can be counted after the walk (`sweep`)."""

    def __init__(self):
        self.converted = 0
        self.texts = 0
        self.missed: dict = {}
        self.handled: set = set()
        self.shared = 0
        self.raster = 0
        # 3D texts whose turn ezdgn does not decode.
        self.text_turn_unknown = 0
        self.shared_names: set = set()
        self.blocks: dict = {}  # key -> (name, ops)
        self.cells: dict = {}  # cell name -> {"placements", "blocks"}
        self.names: set = set()  # block names taken, lower case (ezdxf ignores case)
        self.next: dict = {}  # lower-case name -> next variant number
        self.anon = 0

    def done(self, n: Node) -> None:
        self.converted += 1
        if n.i is not None:
            self.handled.add(n.i)

    def count_miss(self, key) -> None:
        self.missed[key] = self.missed.get(key, 0) + 1
        if key[1] == RASTER_FRAME:
            self.raster += 1

    def miss(self, n: Node) -> None:
        self.count_miss((n.kind, n.etype))
        if n.i is not None:
            self.handled.add(n.i)
        for kid in n.kids:
            self.miss(kid)

    def sweep(self, records) -> int:
        """Count each record that the walk never reached as not converted;
        return how many."""
        unreached = 0
        for i, rec in enumerate(records or ()):
            if rec is not None and i not in self.handled:
                self.count_miss(rec)
                unreached += 1
        return unreached

    def block_name(self, name: str) -> str:
        """A new block name for `name`: the name itself, or "<name>#k" once
        it is taken (ezdxf block names ignore case)."""
        clean = _clean_name(name).strip()
        if not clean:
            self.anon += 1
            return f"*U{self.anon}"
        low = clean.lower()
        k = self.next.get(low, 1)
        out = clean if k == 1 else f"{clean}#{k}"
        while out.lower() in self.names:
            k += 1
            out = f"{clean}#{k}"
        self.next[low] = k + 1
        self.names.add(out.lower())
        return out

    def place(self, name: str, key, body: list) -> str:
        """The block a cell placement inserts, and the placement counted
        under its cell name."""
        row = self.cells.setdefault(name, {"placements": 0, "blocks": []})
        row["placements"] += 1
        if key not in self.blocks:
            block = self.block_name(name)
            self.blocks[key] = (block, body)
            row["blocks"].append(block)
        return self.blocks[key][0]

    def walk(self, n: Node, off, ops: list, texts: list | None) -> None:
        """Ops for `n` into `ops`, its points less `off`. Inside a cell,
        `texts` collects the cell's texts in design coordinates."""
        kind, g = n.kind, n.g
        op = None
        if kind in ("LINE", "LINE_STRING", "SHAPE", "POINT_STRING", "CURVE"):
            pts = [p for p in (g.get("pts") or []) if p is not None]
            if not pts or not all(_sane(*p) for p in pts):
                return self.miss(n)
            pts = [_sub(p, off) for p in pts]
            if kind == "POINT_STRING":
                op = ["points", n.layer, pts]
            elif kind == "CURVE":
                fit = pts[2:-2]
                if len(fit) < 2:
                    return self.miss(n)
                op = ["spline", n.layer, fit]
            elif kind == "SHAPE":
                if len(pts) > 1 and pts[0] == pts[-1]:
                    pts = pts[:-1]
                if len(pts) < 2:
                    return self.miss(n)
                op = ["poly", n.layer, pts, True]
            elif len(pts) < 2:
                return self.miss(n)
            elif len(pts) == 2:
                op = ["line", n.layer, pts[0], pts[1]]
            else:
                op = ["poly", n.layer, pts, False]
        elif kind in ("ARC", "ELLIPSE"):
            op = _arc_ops(n, off)
            if op is None:
                return self.miss(n)
        elif kind == "TEXT":
            o, h, w, rot, text = g.get("o"), g.get("h"), g.get("w"), g.get("rot"), g.get("text")
            if text is None or o is None or not _sane(*o, h) or h == 0 or (rot is not None and not _finite(rot)):
                return self.miss(n)
            if rot is None:
                # A text with no turn ezdgn decodes (3D): drawn unturned in
                # the plan at its origin, and counted.
                rot = 0.0
                self.text_turn_unknown += 1
            # A negative size is mirrored text: DXF keeps the size positive
            # and sets its mirror flags (2 backward, 4 upside down).
            flags = (4 if h < 0 else 0) | (2 if _finite(w) and w and w < 0 else 0)
            h = abs(h)
            wf = abs(w) / h if _finite(w) and w else 1.0
            # ezdxf drops a line break from a TEXT, joining the words; a
            # space keeps them apart, as the registry's space folding does.
            text = re.sub(r"[\r\n]+", " ", str(text))
            if text.endswith("^"):
                # DXF reads "^x" as a control code and ezdxf drops a last
                # "^"; "^ " is DXF's own literal caret, and the registry's
                # space folding gives back the DGN text.
                text += " "
            self.texts += 1
            if texts is not None:
                # A cell's text: an ATTRIB of the top insert, where it stands.
                texts.append([n.layer, text, o, h, rot, wf, flags])
                self.done(n)
                return self.miss_kids(n)
            op = ["text", n.layer, text, _sub(o, off), h, rot, wf, flags]
        elif kind in ("TEXT_NODE", "COMPLEX_CHAIN", "COMPLEX_SHAPE"):
            # A container: its components are the content.
            self.done(n)
            for kid in n.kids:
                self.walk(kid, off, ops, texts)
            return None
        elif kind == "CELL":
            o = g.get("o") or ORIGIN
            if not _sane(*o):
                return self.miss(n)
            top = texts is None
            cell_texts = [] if top else texts
            body: list = []
            self.done(n)
            for kid in n.kids:
                self.walk(kid, o, body, cell_texts)
            name = g.get("name", "")
            key = ("cell", name, _signature(body))
            ops.append(["insert", n.layer, self.place(name, key, body), _sub(o, off), cell_texts if top else []])
            return None
        elif kind == "SHARED_CELL_INSTANCE":
            o = g.get("o")
            if o is None or not _sane(*o):
                return self.miss(n)
            name = g.get("name", "")
            self.shared += 1
            self.shared_names.add(name)
            op = ["insert", n.layer, self.place(name, ("shared", name), []), _sub(o, off), []]
        else:
            return self.miss(n)
        self.done(n)
        ops.append(op)
        return self.miss_kids(n)

    def miss_kids(self, n: Node) -> None:
        """Components under a kind that has none of its own (a line, an arc,
        a text, a shared cell instance) are not drawn: counted."""
        for kid in n.kids:
            self.miss(kid)


def _signature(body: list) -> bytes:
    """A geometry signature: a digest of the ops, floats rounded to a micro
    unit."""
    return hashlib.sha256(repr(_rounded(body)).encode("utf-8", "replace")).digest()


def _rounded(value):
    if isinstance(value, float):
        return round(value, 6)
    if isinstance(value, (list, tuple)):
        return tuple(_rounded(v) for v in value)
    return value


# ── drawing operations -> ezdxf ─────────────────────────────────────────


def _realize(space, ops: list, layers: set) -> None:
    for op in ops:
        kind, layer = op[0], op[1]
        layers.add(layer)
        a = {"layer": layer}
        if kind == "line":
            space.add_line(op[2], op[3], dxfattribs=a)
        elif kind == "poly":
            space.add_lwpolyline([(p[0], p[1]) for p in op[2]], close=op[3], dxfattribs=a)
        elif kind == "points":
            for p in op[2]:
                space.add_point(p, dxfattribs=a)
        elif kind == "spline":
            space.add_spline(fit_points=op[2], dxfattribs=a)
        elif kind == "circle":
            space.add_circle(op[2], op[3], dxfattribs=a)
        elif kind == "arc":
            space.add_arc(op[2], op[3], op[4], op[5], dxfattribs=a)
        elif kind == "ellipse":
            if len(op) > 7:
                a = {**a, "extrusion": op[7]}
            space.add_ellipse(op[2], major_axis=op[3], ratio=op[4], start_param=op[5],
                              end_param=op[6], dxfattribs=a)
        elif kind == "text":
            space.add_text(op[2], height=op[4], rotation=op[5], dxfattribs={
                **a, "insert": op[3], "width": op[6], "text_generation_flag": op[7]})
        elif kind == "insert":
            ref = space.add_blockref(op[2], op[3], dxfattribs=a)
            for i, (t_layer, text, o, h, rot, wf, flags) in enumerate(op[4], start=1):
                layers.add(t_layer)
                ref.add_attrib(f"TEXT{i}", text, insert=o, dxfattribs={
                    "layer": t_layer, "height": h, "rotation": rot, "width": wf,
                    "text_generation_flag": flags})


def build_document(models: list, facts: dict):
    """The ezdxf document of the models' element trees, and the `dgn` facts
    for the index. Its own function so tests can feed it trees by hand.

    The models rule: every model that holds records is converted; the one
    with the most converted elements (a tie: the first) is the drawing, in
    model space, where the registry, the bones and the picture read it.
    Every other one is kept apart in a block of its own (never merged into
    the drawing), and listed with what it holds. A model with no records
    is listed and skipped."""
    import ezdxf  # noqa: PLC0415 - child-only import

    walker = _Ops()
    listed = []
    bodies = {}
    for i, model in enumerate(models):
        records = model.get("records")
        entry = {
            "index": i,
            "name": model.get("name", ""),
            "dimension": model.get("dimension"),
            "not_flat": model.get("not_flat", 0),
            "wild_z": model.get("wild_z", 0),
        }
        listed.append(entry)
        if not model["top"] and not any(r is not None for r in records or ()):
            entry.update(elements=0, converted=0, not_converted=0, texts=0, space="empty")
            if records is not None:
                entry.update(records=0, gap=0)
            continue
        before = (walker.converted, sum(walker.missed.values()), walker.texts)
        walker.handled = set()
        body: list = []
        for n in model["top"]:
            walker.walk(n, ORIGIN, body, None)
        unreached = walker.sweep(records)
        bodies[i] = body
        entry["converted"] = walker.converted - before[0]
        entry["not_converted"] = sum(walker.missed.values()) - before[1]
        entry["elements"] = entry["converted"] + entry["not_converted"]
        entry["texts"] = walker.texts - before[2]
        entry["unreached"] = unreached
        entry["repeated"] = model.get("repeated", 0)
        if records is not None:
            entry["records"] = sum(1 for r in records if r is not None)
            # Every record handled once: a gap is a converter fault, stated.
            entry["gap"] = entry["records"] - entry["elements"]

    drawn = [m for m in listed if "converted" in m and m.get("space") != "empty"]
    main = max(drawn, key=lambda m: m["converted"], default=None)  # a tie: the first
    msp_ops: list = []
    for m in drawn:
        if m is main:
            m["space"] = "model"
            msp_ops = bodies[m["index"]]
        else:
            label = f"MODEL {m['index']} {m['name']}".strip()
            name = walker.block_name(label)
            walker.blocks[("model", m["index"])] = (name, bodies[m["index"]])
            m.update(space="block", block=name)
    drawing = models[main["index"]] if main else (models[0] if models else {})

    doc = ezdxf.new("R2010")
    unit = str(drawing.get("unit") or "").strip().lower()
    if unit in UNITS:
        doc.units = UNITS[unit]
    layers: set = set()
    # Blocks first: an INSERT names a block that must exist.
    for name, body in walker.blocks.values():
        _realize(doc.blocks.new(name), body, layers)
    _realize(doc.modelspace(), msp_ops, layers)
    for layer in sorted(layers):
        # Layer names that differ only in case share one table entry; each
        # entity keeps its own name, and the registry reads that.
        if layer and layer not in doc.layers:
            doc.layers.add(layer)

    missed = [
        {"kind": k, "type": t, "name": TYPE_NAMES.get(t), "count": c}
        for (k, t), c in sorted(walker.missed.items(), key=lambda kv: (-kv[1], kv[0][0], kv[0][1] or 0))
    ]
    not_converted = sum(m["count"] for m in missed)
    raster_only = walker.raster > 0 and walker.converted <= RASTER_ONLY_MAX
    dimension = drawing.get("dimension")
    not_flat = sum(m["not_flat"] for m in listed)
    wild = sum(m["wild_z"] for m in listed)
    unreached = sum(m.get("unreached", 0) for m in listed)
    repeated = sum(m.get("repeated", 0) for m in listed)
    gaps = [m["gap"] for m in listed if m.get("gap")]
    counted = [m["records"] for m in listed if "records" in m]
    cells = sorted(walker.cells.items(), key=lambda kv: (-kv[1]["placements"], kv[0]))
    split = sum(1 for _n, row in cells if len(row["blocks"]) > 1)
    changed = facts.get("levels_changed") or []
    notes = []
    if raster_only:
        notes.append(
            f"The DGN holds a raster frame and {walker.converted} other elements: the drawing"
            " is a scanned image that the DGN points at. Mantle does not read the scan."
        )
    if dimension == 3:
        notes.append(
            f"A 3D model, drawn in plan (top view): {not_flat} elements are not flat in Z"
            f" and {wild} have a wild Z."
        )
    kept_apart = [m for m in listed if m.get("space") == "block"]
    if kept_apart:
        notes.append(
            f"{len(kept_apart)} more models are converted into blocks of their own and are not"
            f" read: their {sum(m['elements'] for m in kept_apart)} elements, of them"
            f" {sum(m['texts'] for m in kept_apart)} texts, are not in the registry, the bones"
            " or the picture (see `models`)."
        )
    if changed:
        notes.append(
            f"{len(changed)} levels are renamed or share a layer (see `levels_changed`): DXF"
            " refuses \" * / : ; < = > ? \\ and ` in a layer name, and each becomes _. A"
            " circuit on such a level is named after its layer, not its level."
        )
    if split:
        notes.append(
            f"{split} cell names are placed with more than one geometry: such a placement"
            " inserts the block <name>#2 and so on. `cells` gives the true count per cell name."
        )
    if unreached:
        notes.append(f"{unreached} element records are under no drawn element and are counted as not converted.")
    if repeated:
        notes.append(f"{repeated} element references repeat an element already drawn: it is drawn once.")
    if gaps:
        notes.append(
            f"The converter's count differs from ezdgn's record count by {sum(gaps)}: a converter"
            " fault, so the counts are not exact."
        )
    info = {
        "format": facts.get("format"),
        "reader": facts.get("reader", "ezdgn"),
        "dimension": dimension,
        "unit": drawing.get("unit"),
        "models": listed,
        "records": sum(counted) if counted else None,
        "elements": walker.converted + not_converted,
        "converted": walker.converted,
        "not_converted": missed,
        "not_converted_total": not_converted,
        "gap": sum(gaps),
        "unreached": unreached,
        "repeated": repeated,
        "not_flat": not_flat,
        "wild_z": wild,
        "levels_changed": changed[:MAX_ROWS],
        "levels_changed_total": len(changed),
        "cells": [
            {"name": n, "placements": row["placements"], "variants": len(row["blocks"]),
             "blocks": row["blocks"][:MAX_ROW_BLOCKS]}
            for n, row in cells[:MAX_ROWS]
        ],
        "cell_names": len(cells),
        "shared_cells_not_expanded": walker.shared,
        "shared_cell_names": len(walker.shared_names),
        "text_turn_unknown": walker.text_turn_unknown,
        "raster_frames": walker.raster,
        "raster_only": raster_only,
        "note": " ".join(notes) or None,
    }
    for key in ("control_records", "text_encoding"):
        if key in facts:
            info[key] = facts[key]
    return doc, info


def load(src: str) -> tuple[list, dict]:
    """ezdgn's read of `src` as the element trees and the facts. Raises
    DgnRefused for a DGN Mantle does not read, and ezdgn's own errors for
    a file it cannot read."""
    import ezdgn  # noqa: PLC0415 - child-only import

    info = ezdgn.detect_format(src)
    if info.is_v7 and info.dimension == 3:
        raise DgnRefused("DGN V7 3D is not read")
    source = ezdgn.open_document(src)
    models, facts = _v7_tree(source) if info.is_v7 else _v8_tree(source)
    facts["reader"] = f"ezdgn {getattr(ezdgn, '__version__', '')}".strip()
    return models, facts


def read(src: str):
    """`src` as an ezdxf document and the `dgn` facts (load, then build)."""
    return build_document(*load(src))
