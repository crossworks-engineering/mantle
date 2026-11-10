"""MicroStation DGN into ONE in-memory ezdxf document, so a DGN drawing takes
the same road as a DWG or DXF one: the registry, the bones, the picture and
the crops all read the document this module returns and never know it came
from a DGN. The reader is ezdgn (MIT, Rust core, no ODA): native V8, and V7
2D. A V7 3D file is refused, the same way as a DWG no converter can read.

The mapping, in master units:
  levels                 -> layers, by level name (V7 has numbers only)
  LINE                   -> LINE
  LINE_STRING            -> LWPOLYLINE (a 3D one -> POLYLINE)
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
                            mirror flags; a 3D text lies flat in the plan,
                            along its own X axis
  COMPLEX_CHAIN / SHAPE  -> their components, each as above
  CELL                   -> a block and an INSERT at the cell origin. DGN
                            keeps cell components in design coordinates, so
                            the block holds them less the origin and the
                            insert has no rotation or scale. Cells with the
                            same name and the same geometry share a block;
                            a variant gets "<name>#2". Texts of a cell (and
                            of cells inside it) become ATTRIBs of the top
                            insert, so the registry reads them.
  SHARED_CELL_INSTANCE   -> an INSERT of an empty block with the shared
                            cell's name: ezdgn does not expand shared cells,
                            so their geometry is not drawn (counted in
                            `shared_cells_not_expanded`)

Never a silent loss: every element record that is not converted is counted
by its kind and raw element type (dimensions, tags, B-spline curves and
their poles and knots, raster frames, unknown types). The counts, with the
element and converted totals (converted + not converted = elements), are
the `dgn` part of the --dwg-render index. A file with a raster frame and
almost no vector content is a scan in a DGN wrapper, and the index says so.

ezdgn's own scan limits apply (file size, records, objects, vertices,
hierarchy depth); the job's time and memory limits stay the backstop. No
network, and nothing is written: the document lives in memory.
"""

from __future__ import annotations

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
# V7 control records: design settings (9), digitizer setup (8) and level
# symbology (10). Not drawing content, so not in the element count.
V7_CONTROL_TYPES = (8, 9, 10)
# Master unit label -> DXF $INSUNITS.
UNITS = {"mm": 4, "cm": 5, "m": 6, "km": 7, "in": 1, '"': 1, "ft": 2, "'": 2, "um": 13}
_BAD_NAME = re.compile(r'[<>/\\":;?*|=`\x00-\x1f]')
CIRCLE_REL_TOL = 1e-6


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
    writer needs (`g`), and its components."""

    __slots__ = ("kind", "layer", "etype", "g", "kids")

    def __init__(self, kind: str, layer: str, etype, g=None, kids=None):
        self.kind = kind
        self.layer = layer
        self.etype = etype
        self.g = g or {}
        self.kids = kids or []


def _p3(p) -> tuple:
    if p is None:
        return None
    return (float(p[0]), float(p[1]), float(p[2]) if len(p) > 2 else 0.0)


def quat_axes(q) -> tuple:
    """The local X and Y axes of a 3D element from its quaternion (w, x, y,
    z): the rows of the rotation matrix, the rule ezdgn uses for V7 3D (it
    checked the rule on the ranges of 400 real ellipses). A zero quaternion
    is no turn. Also says whether the four numbers were a unit quaternion."""
    w, x, y, z = (float(v) for v in q)
    norm = math.sqrt(w * w + x * x + y * y + z * z)
    if not math.isfinite(norm) or norm <= 1e-12:
        return ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0)), False
    unit = abs(norm - 1.0) <= 1e-6
    w, x, y, z = w / norm, x / norm, y / norm, z / norm
    xa = (1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y - z * w), 2.0 * (x * z + y * w))
    ya = (2.0 * (x * y + z * w), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z - x * w))
    return (xa, ya), unit


def _v8_tree(doc) -> tuple[list, dict]:
    """Nodes of a V8 document's first model, and the facts for the index."""
    models = list(doc.models)
    if not models:
        raise DgnRefused("the DGN holds no model")
    model = models[0]
    names = {}
    for lv in doc.levels:
        if lv.name and lv.level_id not in names:
            names[lv.level_id] = lv.name
    elements = model.elements

    def node(e) -> Node:
        d = e.data
        kind = e.kind
        n = Node(kind, _layer(names.get(e.level) or str(e.level)), e.raw.element_type)
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
        if kind in ("CELL", "SHARED_CELL_INSTANCE"):
            n.g["name"] = d.name or ""
        rot = d.rotation_degrees
        if rot is not None:
            n.g["rot"] = rot
        elif kind in ("ARC", "ELLIPSE", "TEXT") and len(d.orientation) >= 4:
            # A 3D element turns by a quaternion, not an angle.
            n.g["rot"] = None
            n.g["axes"], n.g["unit_quat"] = quat_axes(d.orientation[:4])
        else:
            n.g["rot"] = 0.0
        n.kids = [node(elements[i]) for i in e.child_indices]
        return n

    top = [node(e) for e in elements if e.parent_index is None]
    other = sum(len(m.elements) for m in models[1:])
    facts = {
        "format": "V8",
        "models": len(models),
        "dimension": int(model.metadata.dimension),
        "unit": model.metadata.master_unit,
        "other_model_elements": other,
    }
    return top, facts


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

    def node(e) -> Node:
        kind = e.kind
        etype = e.record.element_type
        n = Node(kind, _layer(str(e.level)), etype)
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
            g["text"] = e.decode_text("latin-1")
        elif kind in ("CELL", "SHARED_CELL_INSTANCE", "TEXT_NODE"):
            g["o"] = _p3(pick(e.origin_master, e.origin_uor))
            g["name"] = getattr(e, "name", "") or ""
        n.kids = [node(elements[i]) for i in e.child_indices]
        return n

    top = []
    control = 0
    for e in elements:
        if e.parent_index is not None:
            continue
        if e.record.element_type in V7_CONTROL_TYPES or e.kind == "COLOR_TABLE":
            control += 1
            continue
        top.append(node(e))
    facts = {
        "format": "V7 2D",
        "models": 1,
        "dimension": 2,
        "unit": settings.master_unit_name if master else "uor",
        "other_model_elements": 0,
        "control_records": control,
    }
    return top, facts


# ── element tree -> drawing operations ──────────────────────────────────


def _finite(*values) -> bool:
    try:
        return all(math.isfinite(float(v)) for v in values)
    except (TypeError, ValueError):
        return False


def _sub(p, off) -> tuple:
    return (p[0] - off[0], p[1] - off[1], p[2] - off[2])


def _clean_name(name: str) -> str:
    """A DXF table name: the characters DXF refuses become "_"."""
    return " ".join(_BAD_NAME.sub("_", str(name or "")).split())


def _layer(name: str) -> str:
    return _clean_name(name) or "0"


def _cross(u, v) -> tuple:
    return (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])


def _arc_ops(n: Node, off) -> list | None:
    """ARC, CIRCLE or ELLIPSE as one op, or None when the geometry is not
    usable. The DGN curve is c + a cos(t) X + b sin(t) Y on the element's
    local axes X and Y: turned by `rot` in 2D, from the quaternion in 3D."""
    g = n.g
    c, a, b, rot, axes = g.get("c"), g.get("a"), g.get("b"), g.get("rot"), g.get("axes")
    if c is None or not _finite(*c, a, b) or a <= 0 or b <= 0:
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
    and keeps the converted and not-converted counts."""

    def __init__(self):
        self.converted = 0
        self.missed: dict = {}
        self.shared = 0
        self.raster = 0
        # 3D texts whose turn did not read as a unit quaternion: drawn in
        # the plan at their origin, the turn a guess.
        self.text_turn_guess = 0
        self.blocks: dict = {}  # key -> (name, ops)
        self.names: set = set()
        self.anon = 0

    def miss(self, n: Node) -> None:
        key = (n.kind, n.etype)
        self.missed[key] = self.missed.get(key, 0) + 1
        if n.etype == RASTER_FRAME:
            self.raster += 1
        for kid in n.kids:
            self.miss(kid)

    def block_name(self, key, name: str) -> str:
        if key in self.blocks:
            return self.blocks[key][0]
        clean = _clean_name(name)
        if not clean:
            self.anon += 1
            return f"*U{self.anon}"
        out = clean
        k = 1
        while out in self.names:
            k += 1
            out = f"{clean}#{k}"
        self.names.add(out)
        return out

    def walk(self, n: Node, off, ops: list, texts: list | None) -> None:
        """Ops for `n` into `ops`, its points less `off`. Inside a cell,
        `texts` collects the cell's texts in design coordinates."""
        kind, g = n.kind, n.g
        op = None
        if kind in ("LINE", "LINE_STRING", "SHAPE", "POINT_STRING", "CURVE"):
            pts = [p for p in (g.get("pts") or []) if p is not None]
            if not pts or not all(_finite(*p) for p in pts):
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
            if rot is None and g.get("axes") is not None:
                # A 3D text is drawn in the plan, along its own X axis.
                xa = g["axes"][0]
                rot = math.degrees(math.atan2(xa[1], xa[0])) if math.hypot(xa[0], xa[1]) > 1e-9 else 0.0
                if not g.get("unit_quat"):
                    self.text_turn_guess += 1
            if text is None or o is None or rot is None or not _finite(*o, h, rot) or h == 0:
                return self.miss(n)
            # A negative size is mirrored text: DXF keeps the size positive
            # and sets its mirror flags (2 backward, 4 upside down).
            flags = (4 if h < 0 else 0) | (2 if _finite(w) and w and w < 0 else 0)
            h = abs(h)
            wf = abs(w) / h if _finite(w) and w else 1.0
            text = str(text)
            if text.endswith("^"):
                # DXF reads "^x" as a control code and ezdxf drops a last
                # "^"; "^ " is DXF's own literal caret, and the registry's
                # space folding gives back the DGN text.
                text += " "
            if texts is not None:
                # A cell's text: an ATTRIB of the top insert, where it stands.
                texts.append([n.layer, text, o, h, rot, wf, flags])
                self.converted += 1
                return None
            op = ["text", n.layer, text, _sub(o, off), h, rot, wf, flags]
        elif kind in ("TEXT_NODE", "COMPLEX_CHAIN", "COMPLEX_SHAPE"):
            # A container: its components are the content.
            self.converted += 1
            for kid in n.kids:
                self.walk(kid, off, ops, texts)
            return None
        elif kind == "CELL":
            o = g.get("o") or (0.0, 0.0, 0.0)
            if not _finite(*o):
                return self.miss(n)
            top = texts is None
            cell_texts = [] if top else texts
            body: list = []
            self.converted += 1
            for kid in n.kids:
                self.walk(kid, o, body, cell_texts)
            key = ("cell", g.get("name", ""), repr(_rounded(body)))
            name = self.block_name(key, g.get("name", ""))
            if key not in self.blocks:
                self.blocks[key] = (name, body)
            op = ["insert", n.layer, name, _sub(o, off), cell_texts if top else []]
            ops.append(op)
            return None
        elif kind == "SHARED_CELL_INSTANCE":
            o = g.get("o")
            if o is None or not _finite(*o):
                return self.miss(n)
            key = ("shared", g.get("name", ""))
            name = self.block_name(key, g.get("name", ""))
            if key not in self.blocks:
                self.blocks[key] = (name, [])
            self.shared += 1
            op = ["insert", n.layer, name, _sub(o, off), []]
        else:
            return self.miss(n)
        self.converted += 1
        ops.append(op)
        return None


def _rounded(value):
    """A geometry signature: floats rounded to a micro unit."""
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
            pts, closed = op[2], op[3]
            if any(p[2] for p in pts):
                space.add_polyline3d(pts, close=closed, dxfattribs=a)
            else:
                space.add_lwpolyline([(p[0], p[1]) for p in pts], close=closed, dxfattribs=a)
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


def build_document(top: list, facts: dict, reader: str = "ezdgn"):
    """The ezdxf document of an element tree, and the `dgn` facts for the
    index. Its own function so tests can feed it a tree by hand."""
    import ezdxf  # noqa: PLC0415 - child-only import

    walker = _Ops()
    msp_ops: list = []
    for n in top:
        walker.walk(n, (0.0, 0.0, 0.0), msp_ops, None)

    doc = ezdxf.new("R2010")
    unit = str(facts.get("unit") or "").strip().lower()
    if unit in UNITS:
        doc.units = UNITS[unit]
    layers: set = set()
    # Blocks first: an INSERT names a block that must exist.
    for name, body in walker.blocks.values():
        _realize(doc.blocks.new(name), body, layers)
    _realize(doc.modelspace(), msp_ops, layers)
    for layer in sorted(layers):
        if layer and layer not in doc.layers:
            try:
                doc.layers.add(layer)
            except Exception:  # noqa: BLE001 - a name ezdxf refuses keeps the entity
                pass

    missed = [
        {"kind": k, "type": t, "name": TYPE_NAMES.get(t), "count": c}
        for (k, t), c in sorted(walker.missed.items(), key=lambda kv: (-kv[1], kv[0][0], kv[0][1] or 0))
    ]
    other = int(facts.get("other_model_elements") or 0)
    if other:
        missed.append({"kind": "OTHER_MODEL", "type": None, "name": None, "count": other})
    not_converted = sum(m["count"] for m in missed)
    raster_only = walker.raster > 0 and walker.converted <= RASTER_ONLY_MAX
    note = None
    if raster_only:
        note = (
            f"The DGN holds a raster frame and {walker.converted} other elements: the drawing"
            " is a scanned image that the DGN points at. Mantle does not read the scan."
        )
    elif facts.get("dimension") == 3:
        note = "A 3D model, drawn in plan (top view); texts lie flat in the plan."
    info = {
        "format": facts.get("format"),
        "reader": reader,
        "models": facts.get("models"),
        "dimension": facts.get("dimension"),
        "unit": facts.get("unit"),
        "elements": walker.converted + not_converted,
        "converted": walker.converted,
        "not_converted": missed,
        "not_converted_total": not_converted,
        "shared_cells_not_expanded": walker.shared,
        "raster_frames": walker.raster,
        "text_turn_guessed": walker.text_turn_guess,
        "raster_only": raster_only,
        "note": note,
    }
    return doc, info


def read(src: str):
    """`src` as an ezdxf document and the `dgn` facts. Raises DgnRefused
    for a DGN Mantle does not read, and ezdgn's own errors for a file it
    cannot read."""
    import ezdgn  # noqa: PLC0415 - child-only import

    info = ezdgn.detect_format(src)
    if info.is_v7 and info.dimension == 3:
        raise DgnRefused("DGN V7 3D is not read")
    source = ezdgn.open_document(src)
    reader = f"ezdgn {getattr(ezdgn, '__version__', '')}".strip()
    if info.is_v7:
        top, facts = _v7_tree(source)
    else:
        top, facts = _v8_tree(source)
    return build_document(top, facts, reader)
