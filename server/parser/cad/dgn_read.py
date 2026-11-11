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
                            each cell name with its true placement count in
                            the drawing, its placements in the other
                            models, and its blocks. Texts of a cell (and of cells
                            inside it) become ATTRIBs of the top insert, so
                            the registry reads them. ezdgn 0.3.2 leaves a
                            V8 cell's name empty; it is read from the
                            cell's name linkage, the same linkage ezdgn
                            reads a shared cell's name from.
  SHARED_CELL_INSTANCE   -> an INSERT of an empty block with the shared
                            cell's name: ezdgn 0.3.2 does not expand shared
                            cells, so their geometry is not drawn (counted in
                            `shared_cells_not_expanded`). With the data
                            reader (below) it is expanded.

The data reader. One check (`reads_data`: does ezdgn have
`read_v8_shared_cell_definitions`) turns on the V8 data that ezdgn 0.3.2
does not decode. With 0.3.2 the document is what it always was.
  shared cells           -> the definitions are read once a file and found
                            by name and range (a dict, then ezdgn's
                            `matches`). Every definition the drawing uses
                            is built once, before the models, the ones it
                            inserts first: one block, walked like a plain
                            cell (in its own space, so less no origin), with
                            counts of its own. The insert takes the
                            instance's matrix as rotation and X and Y scale.
                            Its texts and tags become ATTRIBs of the top
                            insert (the insert in the model), placed through
                            the matrix. A nested instance is an insert
                            inside the block, at most MAX_SC_DEPTH deep.
                            Each definition has a weight (its entities, a
                            polyline, spline or point string by its
                            vertices, and those of what it inserts) and a
                            reach; an
                            instance in a model is expanded only while the
                            file's total weight stays within
                            MAX_EXPANDED_WEIGHT and its reach within WILD.
                            Not expanded, and counted by reason: no
                            definition, a matrix that is not a turn, mirror
                            or axis scale in the plan, a model with another
                            unit scale than the one the definitions are read
                            for, too large, and inside a definition the
                            depth limit or a cycle.
  item data              -> each property with a value (0 and False are
                            values) of an item instance on a shared cell
                            instance is a hidden ATTRIB of its insert: tag =
                            property name, at the insert origin, at most
                            MAX_ITEM_ATTRIBS an element. The class and
                            schema are counted. Two properties of one name
                            give two ATTRIBs of one tag (`data_same_tag`).
  TAG                    -> name from its tag set (sets read once a file),
                            value from the element. On a shared cell
                            instance or in a cell: a hidden ATTRIB of the
                            insert. With no host: a hidden TEXT of the value
                            at the tag origin; with no origin it is counted
                            only. Hidden, as ezdgn does not decode a tag's
                            size, angle or display flag: the registry reads
                            the value, the picture does not guess it.
Every attribute and text this adds counts against MAX_ADDED_ATTRIBS; past
it, they are dropped and counted. Tags and item data inside a definition
are counted once, as `in_definitions`. One guard (`read_data`) holds the
whole data path, ezdgn's reads and the build of the document: if any part
fails, the file is read and built again the 0.3.2 way and `data_error`
gives the error's type name, so a file that converts with 0.3.2 converts
with this build too (the render, the registry and the bones come after
the conversion, as for any DGN).

Models: the model with the most converted elements is the drawing, in model
space (a tie goes to the first). Every other model with elements is
converted into a block of its own, kept apart from the drawing; an empty
model is listed and skipped. The registry, the bones and the picture read
model space only, so the index lists every model with its elements and
texts, and the note says how many are not read.

3D: every point is projected to XY (Z is dropped, so a wild Z cannot reach
the extents, the frame or the picture). The index counts the elements that
are not flat in Z and those with a wild Z. A 3D text turns by the
quaternion it stores as the last four of its six orientation values (ezdgn
0.3.2 gives them too); a text that is not in the plan (tilted, or seen from
below) is drawn unturned and counted in `text_turn_unknown`.

Never a silent loss. Each element record ezdgn gives is marked when it is
converted or counted as not converted. After the walk, a record that was
never reached (under no top-level element, past the depth limit, or under
an element kind that has no components) is counted as not converted by its
kind and raw element type, and as `unreached`. A record referenced a second
time is drawn once and counted as `repeated`. The index compares the total
with the records ezdgn gave (`gap`), and those records with the graphical
objects ezdgn's own scan found in the file (`reader_gap`), and states any
difference. A model the DGN's model index lists but whose content is not in
the file is listed in `skipped_models` and stated. Also counted: dimensions,
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
# The data reader (see the module text).
ITEM_ENTRY = 0x56FF0000  # auxiliary entry type of an item instance
MAX_SC_DEPTH = 8  # shared cells inside shared cells (5 seen on test data)
# What the expanded shared cells of one file may add (a definition's weight:
# one an entity or attribute, one a vertex of a polyline, spline or point
# string, plus the weights of the inserts it holds). An instance that would
# take the file's total past it is not expanded, and is counted
# (`too_large`). Measured on made-up drawings, the full parser child on one
# CPU: 50,000 lines (the costliest unit) take 23 s and 0.8 GB, and 200,000
# took 87 s and 2.6 GB, past the parser's 2 GB (200,000 vertices: 11 s as
# polylines, 45 s as splines). The largest weight of a real file on the
# bench sets is 12,097.
MAX_EXPANDED_WEIGHT = 50_000
MAX_ADDED_ATTRIBS = 100_000  # attributes and texts the data reader adds a file
MAX_ITEM_ATTRIBS = 256  # attributes from item data on one element
MAX_TAG_LEN = 255
MAX_VALUE_LEN = 512  # the registry keeps 512 characters of a text
HIDDEN_HEIGHT = 1.0  # height of a hidden attribute or text (not drawn)
PLAN_TOL = 1e-6


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


def _text_turn(orientation) -> float | None:
    """The turn in the plan of a 3D text, in degrees, from the quaternion
    it stores as the last four of its six orientation values (the first
    two are its size). None when there is no usable quaternion (none given
    at all included), or the text is not in the plan (tilted, or seen from
    below).

    The evidence, counts only, on the two private bench sets: 1,875 of
    1,875 3D texts hold a unit quaternion in those four values, and for
    the 149 turned texts of three or more characters the turn this gives
    agrees with the direction of the stored range for 142 (5 at the side,
    2 on the other axis); read by columns, 75 of 149. Not proven: why the
    7 differ, and texts seen from below (none on the bench)."""
    try:
        orientation = tuple(orientation or ())
    except TypeError:
        return None
    if len(orientation) != 6 or not _finite(*orientation[2:6]):
        return None
    q = orientation[2:6]
    if sum(float(v) * float(v) for v in q) <= 1e-24:
        return None
    xa, ya = quat_axes(q)
    if _cross(xa, ya)[2] <= 0.999999:
        return None
    return math.degrees(math.atan2(xa[1], xa[0]))


def _plan(m) -> tuple | None:
    """A shared cell instance's 3x3 matrix (nine values by rows) as the
    INSERT's (rotation in degrees, X scale, Y scale), or None when the
    matrix is not that in the plan: a shear, a definition Z that moves the
    plan, a zero, or a value that is not usable. A mirror is a negative Y
    scale.

    The convention: a definition point p lands at origin + M p, M read by
    rows, so the image of the definition's X axis is M's first COLUMN
    (a, d). The evidence, counts only, on the two private bench sets: that
    rule gives the stored range of the instance for 2,358 of 2,376 line and
    shape definitions (ezdgn's own check); the box of the inserts made here
    matches the stored range for 52 of 54 instances turned by an angle that
    is not a multiple of 90 degrees (inside it for 54), where the transpose
    matches 24, and for 126 of 126 mirrored ones."""
    if len(m) != 9 or not _sane(*m[:6]):
        return None
    a, b, c, d, e, f = (float(v) for v in m[:6])
    n0, n1 = math.hypot(a, d), math.hypot(b, e)
    if n0 <= 1e-12 or n1 <= 1e-12:
        return None
    s = max(n0, n1)
    if abs(c) > PLAN_TOL * s or abs(f) > PLAN_TOL * s or abs(a * b + d * e) > PLAN_TOL * n0 * n1:
        return None
    det = a * e - b * d
    return (math.degrees(math.atan2(d, a)), n0, n1 if det > 0 else -n1)


def _place_text(t: list, o, plan) -> list:
    """An attribute entry in a definition's space, placed by an instance at
    `o` with `plan` (rotation, X scale, Y scale): position, turn, height
    and width through the matrix; a mirror turns the text upside down in
    its own frame (DXF flag 4)."""
    layer, text, p, h, rot, wf, flags = t[:7]
    turn, sx, sy = plan
    c, s = math.cos(math.radians(turn)), math.sin(math.radians(turn))

    def lin(x, y):
        x, y = x * sx, y * sy
        return (x * c - y * s, x * s + y * c)

    px, py = lin(p[0], p[1])
    r = math.radians(rot)
    dx, dy = lin(math.cos(r), math.sin(r))
    length = math.hypot(dx, dy)
    det = abs(sx * sy)
    return [layer, text, (o[0] + px, o[1] + py, 0.0), h * det / length,
            math.degrees(math.atan2(dy, dx)), wf * length * length / det,
            flags ^ 4 if sx * sy < 0 else flags, *t[7:]]


_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")


def _text_of(value) -> str:
    """A property, tag name or value as text: bytes are read as UTF-8."""
    if isinstance(value, (bytes, bytearray)):
        return bytes(value).decode("utf-8", "replace")
    return str(value)


def _attrib_tag(name) -> str:
    """An ATTRIB tag: the name with white space and control characters as
    "_", or "TAG" (a DXF tag has no space and no control character)."""
    out = "_".join(_CONTROL.sub(" ", _text_of(name if name is not None else "")).split())[:MAX_TAG_LEN]
    return out or "TAG"


def _attrib_value(value) -> str:
    return re.sub(r"[\r\n]+", " ", _text_of(value))[:MAX_VALUE_LEN]


def _hidden(layer: str, value, o, tag) -> list:
    """A hidden attribute entry: [layer, text, position, height, rotation,
    width factor, flags, tag, hidden]."""
    return [layer, _attrib_value(value), o, HIDDEN_HEIGHT, 0.0, 1.0, 0, _attrib_tag(tag), True]


def _items(e, budget: list) -> dict:
    """The item instances on an element, read once: the properties with a
    value (at most MAX_ITEM_ATTRIBS) and the counts. `budget` is the file's
    one budget of item values (MAX_ADDED_ATTRIBS): each decoded instance
    takes its values from it, at least one. Once it is spent no entry is
    decoded any more, only counted (`not_read`), so a hostile file cannot
    make every element's item data decoded for a fixed number of values.
    An entry ezdgn gives no data for (over its own limit, or a layout it
    does not know) is "no data", counted, not an error."""
    from ezdgn import v8  # noqa: PLC0415 - child-only import

    out = {"attrs": [], "instances": 0, "properties": 0, "no_data": 0, "dropped": 0, "not_read": 0,
           "classes": {}}
    for record in e.auxiliary_records:
        for entry in record.entries or ():
            if entry.type_id != ITEM_ENTRY:
                continue
            if budget[0] <= 0:
                out["not_read"] += 1
                continue
            item = v8.decode_item_instance(entry)
            if item is None:
                out["no_data"] += 1
                budget[0] -= 1
                continue
            kept = len(out["attrs"])
            out["instances"] += 1
            key = (item.class_name, item.schema_reference or "")
            out["classes"][key] = out["classes"].get(key, 0) + 1
            for name, value in item.properties:
                out["properties"] += 1
                # 0 and False are values; only no value is left out.
                if value is None or value == "" or value == b"":
                    continue
                if len(out["attrs"]) < MAX_ITEM_ATTRIBS:
                    out["attrs"].append((name, value))
                else:
                    out["dropped"] += 1
            budget[0] -= max(1, len(out["attrs"]) - kept)
    return out


def _tag_definitions(doc) -> dict:
    """{tag set element ID: {tag ID: definition}}, read once, here; the
    first set of an element ID and the first definition of a tag ID win, as
    in ezdgn's `tag_sets_by_id` and `definition`, so both data builds give
    the same names. A build with `tag_sets_by_id` decodes them all under
    one budget of its own; an older one decodes `tag_sets` on each access."""
    out: dict = {}
    by_id = getattr(doc, "tag_sets_by_id", None)
    for tag_set in by_id().values() if callable(by_id) else doc.tag_sets:
        if tag_set.element_id in out:
            continue
        defs = out[tag_set.element_id] = {}
        for definition in tag_set.definitions:
            defs.setdefault(definition.tag_id, definition)
    return out


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
    return {"top": [n for n in top if n is not None], "records": records, "repeated": repeated,
            "reached": len(seen)}


# Kinds whose components the walk draws; under any other kind they are
# counted, never walked.
CONTAINERS = ("TEXT_NODE", "COMPLEX_CHAIN", "COMPLEX_SHAPE", "CELL")


def _instances(nodes) -> list:
    """The shared cell instances the walk reaches in these trees, at any
    depth, in order. No recursion: a deep tree cannot overflow the stack."""
    out: list = []
    stack = list(reversed(nodes))
    while stack:
        n = stack.pop()
        if n.kind == "SHARED_CELL_INSTANCE":
            out.append(n)
        elif n.kind in CONTAINERS:
            stack.extend(reversed(n.kids))
    return out


def _wanted(n: Node):
    """The definition key an instance is expanded with, if it can be."""
    key = n.g.get("def")
    return key if key is not None and n.g.get("plan") is not None else None


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


def _v8_tree(doc, definitions=None) -> tuple[list, dict]:
    """One entry a model of a V8 document (name, dimension, element tree,
    records, records not flat in Z, records with a wild Z), and the facts
    for the index. `definitions` are ezdgn's shared cell definitions of
    the file when the installed ezdgn has the data reader, else None: then
    the tree is the one ezdgn 0.3.2 gives, with no data read."""
    models = list(doc.models)
    if not models:
        raise DgnRefused("the DGN holds no model")
    names = {}
    for lv in doc.levels:
        # A name of only spaces is no name: the level shows by its number.
        if lv.name and lv.name.strip() and lv.level_id not in names:
            names[lv.level_id] = lv.name
    levels = _Levels(names)
    data = definitions is not None
    tag_defs = _tag_definitions(doc) if data else {}
    item_budget = [MAX_ADDED_ATTRIBS]  # the item values of the file (`_items`)
    # Definitions by (name, six range values): what ezdgn's `matches`
    # compares, so an instance finds its one candidate in O(1).
    index: dict = {}
    unusable = duplicates = 0
    for definition in definitions or ():
        rv = definition.range_values
        if rv is None:
            unusable += 1
        elif (definition.name, tuple(rv)) in index:
            duplicates += 1
        else:
            index[(definition.name, tuple(rv))] = definition
    def record_of(e):
        return (e.kind, e.raw.element_type)

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
        if kind in ("ARC", "ELLIPSE") and len(d.orientation) == 4:
            # A 3D arc or ellipse turns by a quaternion, not an angle
            # (ezdgn 0.3.2 gives a 3D one the quaternion and no rotation,
            # a 2D one the rotation and no quaternion; were both given,
            # the quaternion holds the whole turn).
            n.g["axes"] = quat_axes(d.orientation)
        elif rot is not None:
            n.g["rot"] = rot
        elif kind == "TEXT":
            # A 3D text: its turn from the stored quaternion; None (drawn
            # unturned, counted in `text_turn_unknown`) when not in the plan.
            # ezdgn 0.3.2 gives the quaternion too, so this is the ONE change
            # on the 0.3.2 path: a 2D file converts as before, and a 3D file
            # differs only in the rotation of its 3D texts (and the count).
            n.g["rot"] = _text_turn(d.orientation)
        elif kind in ("ARC", "ELLIPSE"):
            # No turn decoded: not converted.
            n.g["rot"] = None
        else:
            n.g["rot"] = 0.0
        if data:
            if kind == "SHARED_CELL_INSTANCE":
                n.g["eid"] = getattr(e.common, "element_id", None)
                m = tuple(d.transform or ())
                if len(m) == 15:
                    n.g["m"] = m[6:]
                    n.g["plan"] = _plan(m[6:])
                    found = index.get((d.name, m[:6]))
                    if found is not None and found.matches(e):
                        n.g["def"] = (d.name, m[:6])
                if e.auxiliary_records:
                    n.g["items"] = _items(e, item_budget)
            elif kind == "TAG":
                found = tag_defs.get(d.tag_set_element_id, {}).get(d.tag_id)
                n.g.update(tag=found.name if found is not None else None, value=d.value,
                           host=d.host_element_id)
        return n

    def definition_nodes(key) -> tuple:
        """The component trees of one definition (its header's components,
        and any record outside the header), and how many of its records
        no tree reaches."""
        t = _tree(index[key].elements, build, lambda e: e.parent_index is None, record_of)
        out = []
        for n in t["top"]:
            out.extend(n.kids if n.kind == "SHARED_CELL_DEFINITION" else [n])
        return out, len(index[key].elements) - t["reached"]

    uor0 = models[0].metadata.uor_per_master

    def tree(model) -> dict:
        elements = model.elements
        md = model.metadata
        # A stored range is rounded out to whole UOR: 2 UOR is still flat.
        flat_tol = 2.0 / md.uor_per_master if md.uor_per_master else 0.0
        out = _tree(elements, build, lambda e: e.parent_index is None, record_of)
        if data:
            # ezdgn gives definitions in the unit scale of the first model.
            out["expand"] = md.uor_per_master == uor0
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
    # The definitions the drawing uses, read here, once each: every read of
    # ezdgn's data happens inside this function (see `load`). A worklist,
    # not recursion: a chain of definitions cannot overflow the stack, and a
    # cycle ends, as each definition is read once.
    nodes: dict = {}
    deps: dict = {}
    def_unreached = 0
    work = [k for t in trees if t.get("expand") for k in map(_wanted, _instances(t["top"])) if k is not None]
    while work:
        key = work.pop()
        if key in nodes:
            continue
        nodes[key], unreached = definition_nodes(key)
        def_unreached += unreached
        deps[key] = [k for k in map(_wanted, _instances(nodes[key])) if k is not None]
        work.extend(deps[key])
    # ezdgn's own scan: the graphical objects it found in every stored model,
    # and the models its index lists with no storage in the file (deleted,
    # or kept in another file). Both are checked against the trees.
    facts = {"format": "V8", "levels_changed": levels.changed(),
             "objects": int(doc.raw.graphical_object_count),
             "skipped_models": [str(m) for m in doc.raw.skipped_models]}
    if data:
        facts["definitions"] = {
            "nodes": nodes, "deps": deps, "count": len(definitions),
            "unusable": unusable, "duplicates": duplicates, "unreached": def_unreached,
            "tag_sets": len(tag_defs),
        }
    return trees, facts


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

    def __init__(self, definitions: dict | None = None):
        self.converted = 0
        self.texts = 0
        self.missed: dict = {}
        self.handled: set = set()
        self.shared = 0
        self.raster = 0
        # 3D texts whose turn is not known (not in the plan).
        self.text_turn_unknown = 0
        self.shared_names: set = set()
        self.blocks: dict = {}  # key -> (name, ops)
        self.cells: dict = {}  # cell name -> {"placements", "blocks"}
        self.names: set = set()  # block names taken, lower case (ezdxf ignores case)
        self.next: dict = {}  # lower-case name -> next variant number
        self.anon = 0
        self.model = 0  # the model being walked, for the cell counts; None in a definition
        # The data reader (None with ezdgn 0.3.2).
        self.defs = definitions
        self.expand = True  # this model has the definitions' unit scale
        self.expanded = 0
        self.built: dict = {}  # definition key -> _Built
        self.sizes: dict = {}  # block name -> (weight, reach) of the cell blocks
        self.total = 0  # the weight of the expanded instances in the models
        self.inner = 0  # the deepest definition the one being built inserts
        self.hosts: dict = {}  # host element ID -> its tag nodes (this model)
        self.hosted: set = set()  # id() of those tag nodes
        self.added = 0
        self.dropped = 0
        self.same_tag = 0  # attributes whose tag is already on their insert
        self.sc: dict = {}  # shared cell counts
        self.tag: dict = {}  # tag counts (models only)
        self.item: dict = {}  # item data counts (models only)
        self.classes: dict = {}  # (class, schema) -> item instances

    @staticmethod
    def bump(counts: dict, key: str, by: int = 1) -> None:
        counts[key] = counts.get(key, 0) + by

    def add(self, out: list, entry: list) -> bool:
        """Append an attribute or text the data reader makes, within
        MAX_ADDED_ATTRIBS a file; past it, drop and count."""
        if self.added >= MAX_ADDED_ATTRIBS:
            self.dropped += 1
            return False
        self.added += 1
        out.append(entry)
        return True

    def item_attribs(self, n: Node, o, out: list) -> None:
        """A shared cell instance's item data as hidden attributes."""
        it = n.g.get("items")
        if not it:
            return
        if self.model is None:
            self.bump(self.item, "in_definitions", it["instances"])
            self.bump(self.item, "not_read", it["not_read"])
        else:
            for key in ("instances", "properties", "no_data", "dropped", "not_read"):
                self.bump(self.item, key, it[key])
            for key, count in it["classes"].items():
                self.classes[key] = self.classes.get(key, 0) + count
        for name, value in it["attrs"]:
            if self.add(out, _hidden(n.layer, value, o, name)) and self.model is not None:
                self.bump(self.item, "attributes")

    def count_tag(self, t: Node, outcome: str) -> None:
        if self.model is None:
            # In a definition: built once, placed by each instance.
            self.bump(self.tag, "in_definitions")
            return
        self.bump(self.tag, "tags")
        self.bump(self.tag, outcome)
        if t.g.get("value") is not None:
            self.bump(self.tag, "with_value")
        if t.g.get("tag") is not None:
            self.bump(self.tag, "with_definition")

    def tag_attribs(self, n: Node, o, out: list) -> None:
        """The tags whose host is this insert, as hidden attributes at the
        tag's origin (else the insert's)."""
        for t in self.hosts.get(n.g.get("eid"), ()):
            p = t.g.get("o")
            p = p if p is not None and _sane(*p) else o
            if self.add(out, _hidden(t.layer, t.g["value"], p, t.g.get("tag"))):
                self.done(t)
                self.count_tag(t, "attached")
            else:
                self.miss(t)
                self.count_tag(t, "dropped")

    def shared_block(self, n: Node):
        """(definition key, plan) for an instance that is expanded; None,
        counted by reason, when it is not. Two checks are new with the
        definitions built first: inside a definition, the nesting depth;
        in a model, the weight and reach (`fits`)."""
        if self.defs is None:
            return None
        top = self.model is not None
        key, plan = n.g.get("def"), n.g.get("plan")
        built = self.built.get(key)
        reason = None
        if key is None:
            reason = "no_definition"
        elif not self.expand:
            reason = "other_unit_scale"
        elif plan is None:
            reason = "not_in_plan"
        elif built is None:
            reason = "cycle"  # a definition inside itself, at any depth
        elif not top and built.depth >= MAX_SC_DEPTH:
            reason = "depth_limit"
        elif top and not self.fits(built, n.g["o"], plan):
            reason = "too_large"
        if reason is not None:
            self.bump(self.sc, reason if top else "nested_" + reason)
            return None
        if not top:
            self.inner = max(self.inner, built.depth)
        return key, plan

    def fits(self, built, o, plan) -> bool:
        """One check for an instance in a model: its weight keeps the file's
        total within MAX_EXPANDED_WEIGHT, and its reach (origin plus scale
        times the definition's reach) stays within WILD, so neither the
        work of the readers after this one nor the extents can run away."""
        reach = max(abs(o[0]), abs(o[1])) + max(abs(plan[1]), abs(plan[2])) * built.reach
        if self.total + built.weight > MAX_EXPANDED_WEIGHT or not _sane(reach):
            return False
        self.total += built.weight
        return True

    def build_definitions(self) -> None:
        """Every definition the drawing uses, built once, before the models,
        each after the ones it inserts (depth first, by a stack, so a long
        chain cannot overflow). Only an instance inside a cycle finds its
        definition not built yet (`cycle`); a definition that only inserts
        one is built after it, whole. Their counts are their own, not the
        models' (their components are not model records)."""
        nodes, deps = self.defs["nodes"], self.defs["deps"]
        order: list = []
        seen: set = set()
        for root in nodes:
            if root in seen:
                continue
            seen.add(root)
            stack = [(root, iter(deps[root]))]
            while stack:
                key, todo = stack[-1]
                d = next((d for d in todo if d not in seen), None)
                if d is None:
                    stack.pop()
                    order.append(key)
                else:
                    seen.add(d)
                    stack.append((d, iter(deps[d])))
        self.model = None
        for key in order:
            body: list = []
            texts: list = []
            self.inner = 0
            for kid in nodes[key]:
                self.walk(kid, ORIGIN, body, texts)
            weight, reach = _measure(body, self.sizes)
            for t in texts:
                weight += 1
                reach = max(reach, _text_reach(t))
            self.built[key] = _Built(body, texts, min(weight, MAX_EXPANDED_WEIGHT + 1), reach, 1 + self.inner)
        self.bump(self.sc, "definitions_built", len(order))
        self.bump(self.sc, "components_converted", self.converted)
        self.bump(self.sc, "components_not_converted", sum(self.missed.values()))
        self.bump(self.sc, "components_unreached", self.defs["unreached"])
        # The models' counts start here.
        self.converted = self.texts = self.raster = self.text_turn_unknown = 0
        self.shared = self.expanded = 0
        self.missed, self.handled = {}, set()

    def count_same_tag(self, attribs: list) -> None:
        """Attributes whose tag is already on the same insert (with the data
        reader only: item data and tags give tags; a cell text has none)."""
        if self.defs is None:
            return
        tags = [at[7] for at in attribs if len(at) > 7]
        self.same_tag += len(tags) - len(set(tags))

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
        row = self.cells.setdefault(name, {"by_model": {}, "blocks": []})
        if self.model is not None:  # a placement inside a definition is not one in a model
            row["by_model"][self.model] = row["by_model"].get(self.model, 0) + 1
        if key not in self.blocks:
            block = self.block_name(name)
            self.blocks[key] = (block, body)
            row["blocks"].append(block)
            if self.defs is not None:
                self.sizes[block] = _measure(body, self.sizes)
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
            # A width that is not usable (not finite, zero, past WILD) is
            # the plain width.
            w = w if _sane(w) and w else None
            flags = (4 if h < 0 else 0) | (2 if w is not None and w < 0 else 0)
            h = abs(h)
            wf = abs(w) / h if w is not None else 1.0
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
            if top:
                self.count_same_tag(cell_texts)
            ops.append(["insert", n.layer, self.place(name, key, body), _sub(o, off), cell_texts if top else []])
            return None
        elif kind == "SHARED_CELL_INSTANCE":
            o = g.get("o")
            if o is None or not _sane(*o):
                for t in self.hosts.get(g.get("eid"), ()):
                    # Its tags wait for this insert: not placed, and said so.
                    self.count_tag(t, "not_placed")
                    self.miss(t)
                return self.miss(n)
            name = g.get("name", "")
            if self.model is not None:
                self.shared_names.add(name)
            # Its attributes: on its own insert at the top, else (inside a
            # cell or a definition) on the top insert, as a cell's texts.
            top = texts is None
            attribs: list = [] if top else texts
            self.item_attribs(n, o, attribs)
            self.tag_attribs(n, o, attribs)
            found = self.shared_block(n)
            if found is None:
                self.shared += 1
                op = ["insert", n.layer, self.place(name, ("shared", name), []), _sub(o, off),
                      attribs if top else []]
            else:
                key, plan = found
                body, def_texts = self.built[key].body, self.built[key].texts
                self.expanded += 1
                if self.added + len(def_texts) > MAX_ADDED_ATTRIBS:
                    self.dropped += len(def_texts)
                else:
                    for t in def_texts:
                        self.add(attribs, _place_text(t, o, plan))
                    if self.model is not None:
                        self.bump(self.sc, "texts_placed", len(def_texts))
                op = ["insert", n.layer, self.place(name, ("sdef", key), body), _sub(o, off),
                      attribs if top else [], *plan]
            if top:
                self.count_same_tag(attribs)
        elif kind == "TAG" and self.defs is not None:
            # Only the data reader gives this kind (0.3.2: UNKNOWN, type 37).
            if id(n) in self.hosted:
                return None  # its host's insert takes it (tag_attribs)
            value = g.get("value")
            o = g.get("o")
            if value is None:
                self.count_tag(n, "not_placed")
                return self.miss(n)
            if texts is not None:
                # In a cell or a definition: an attribute of the top insert.
                p = o if o is not None and _sane(*o) else off
                if not self.add(texts, _hidden(n.layer, value, p, g.get("tag"))):
                    self.count_tag(n, "dropped")
                    return self.miss(n)
                self.count_tag(n, "attached")
                self.done(n)
                return self.miss_kids(n)
            if o is None or not _sane(*o):
                self.count_tag(n, "not_placed")
                return self.miss(n)
            hidden: list = []
            if not self.add(hidden, _hidden(n.layer, value, _sub(o, off), g.get("tag"))):
                self.count_tag(n, "dropped")
                return self.miss(n)
            self.count_tag(n, "as_text")
            layer, value, p, h = hidden[0][:4]
            op = ["text", layer, value, p, h, 0.0, 1.0, 0, True]
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


class _Built:
    """A built definition: its block body and texts in its own space, its
    weight (entities, saturated past MAX_EXPANDED_WEIGHT), its reach (the
    largest X or Y it draws to from its origin) and its depth (1, plus the
    deepest definition it inserts)."""

    __slots__ = ("body", "texts", "weight", "reach", "depth")

    def __init__(self, body, texts, weight, reach, depth):
        self.body, self.texts, self.weight, self.reach, self.depth = body, texts, weight, reach, depth


def _far(p) -> float:
    return max(abs(p[0]), abs(p[1]))


def _text_reach(t) -> float:
    """How far an attribute or text entry can draw: its position, plus its
    height times its width factor and length."""
    return _far(t[2]) + abs(t[3]) * max(1.0, abs(t[5])) * max(1, len(t[1]))


def _measure(body: list, sizes: dict) -> tuple:
    """(weight, reach) of a block body: one a drawing operation, and one a
    vertex for a polyline, a spline or a point string (the render and the
    bones work per vertex); for an insert one, its attributes, and the
    weight of the block it inserts, whose reach it scales."""
    weight, reach = 0, 0.0
    for op in body:
        kind = op[0]
        if kind == "insert":
            w, r = sizes.get(op[2], (0, 0.0))
            scale = max(abs(op[6]), abs(op[7])) if len(op) > 5 else 1.0
            weight += 1 + w + len(op[4])
            reach = max(reach, _far(op[3]) + scale * r, *(_text_reach(t) for t in op[4]))
        elif kind in ("poly", "points", "spline"):
            weight += len(op[2])  # the work after this one is per vertex
            reach = max(reach, *(_far(p) for p in op[2]))
        elif kind == "line":
            weight += 1
            reach = max(reach, _far(op[2]), _far(op[3]))
        elif kind in ("circle", "arc"):
            weight += 1
            reach = max(reach, _far(op[2]) + abs(op[3]))
        elif kind == "ellipse":
            weight += 1
            reach = max(reach, _far(op[2]) + math.hypot(op[3][0], op[3][1]))
        elif kind == "text":
            weight += 1
            reach = max(reach, _text_reach(op[1:]))
    return min(weight, MAX_EXPANDED_WEIGHT + 1), reach


# ── drawing operations -> ezdxf ─────────────────────────────────────────


def _realize(space, ops: list, layers: set) -> int:
    """The ops as ezdxf entities in `space`. One guard an entity and one an
    attribute: what ezdxf refuses is left out and counted (the count is
    returned), and the rest of the file converts. ezdxf 1.4.5 took every
    character tried on the bench in a tag, a value and a text (control
    characters included); it refuses a layer name with a double quote,
    which `_clean_name` changes first."""
    refused = 0
    for op in ops:
        try:
            refused += _realize_one(space, op, layers)
        except Exception:  # noqa: BLE001 - one entity ezdxf refuses: count it, go on
            refused += 1
    return refused


def _realize_one(space, op: list, layers: set) -> int:
    """One op as an entity; the count of its attributes ezdxf refused."""
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
        a = {**a, "insert": op[3], "width": op[6], "text_generation_flag": op[7]}
        if len(op) > 8 and op[8]:
            a["invisible"] = 1  # a hidden text (a tag with no host)
        space.add_text(op[2], height=op[4], rotation=op[5], dxfattribs=a)
    elif kind == "insert":
        if len(op) > 5:
            # An expanded shared cell: the instance's matrix.
            a = {**a, "rotation": op[5], "xscale": op[6], "yscale": op[7]}
        ref = space.add_blockref(op[2], op[3], dxfattribs=a)
        refused = 0
        for i, at in enumerate(op[4], start=1):
            try:
                t_layer, text, o, h, rot, wf, flags = at[:7]
                layers.add(t_layer)
                attribs = {"layer": t_layer, "height": h, "rotation": rot, "width": wf,
                           "text_generation_flag": flags}
                if len(at) > 8 and at[8]:
                    attribs["flags"] = 1  # invisible ATTRIB
                ref.add_attrib(at[7] if len(at) > 7 else f"TEXT{i}", text, insert=o, dxfattribs=attribs)
            except Exception:  # noqa: BLE001 - one attribute ezdxf refuses
                refused += 1
        return refused
    return 0


def _tag_hosts(top: list) -> tuple[dict, set]:
    """{host element ID: its tag nodes} for the top-level tags with a value
    whose host is a top-level shared cell instance of the same model, and
    the id() of those tag nodes. One pass, one dict lookup a tag."""
    eids = {n.g["eid"] for n in top if n.kind == "SHARED_CELL_INSTANCE" and n.g.get("eid") is not None}
    hosts: dict = {}
    hosted: set = set()
    for n in top:
        if n.kind == "TAG" and n.g.get("value") is not None and n.g.get("host") in eids:
            hosts.setdefault(n.g["host"], []).append(n)
            hosted.add(id(n))
    return hosts, hosted


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

    defs = facts.get("definitions")
    walker = _Ops(defs)
    if defs is not None:
        walker.build_definitions()
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
        walker.model = i
        walker.expand = model.get("expand", True)
        walker.hosts, walker.hosted = _tag_hosts(model["top"]) if defs is not None else ({}, set())
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
    refused = 0
    for name, body in walker.blocks.values():
        refused += _realize(doc.blocks.new(name), body, layers)
    refused += _realize(doc.modelspace(), msp_ops, layers)
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
    # Per model, so gaps of opposite sign cannot cancel.
    gap = sum(abs(m["gap"]) for m in listed if m.get("gap"))
    counted = [m["records"] for m in listed if "records" in m]
    records = sum(counted) if counted else None
    # ezdgn's own object count against the records it gave (V8 only).
    objects = facts.get("objects")
    reader_gap = objects - records if objects is not None and records is not None else 0
    skipped = facts.get("skipped_models") or []
    # A cell's placements in the drawing (model space), and in the models
    # kept apart.
    main_i = main["index"] if main else None
    cells = []
    for name, row in walker.cells.items():
        here = row["by_model"].get(main_i, 0)
        cells.append((name, here, sum(row["by_model"].values()) - here, row["blocks"]))
    cells.sort(key=lambda c: (-c[1], -c[2], c[0]))
    split = sum(1 for c in cells if len(c[3]) > 1)
    changed = facts.get("levels_changed") or []
    notes = []
    if raster_only:
        notes.append(
            f"The DGN holds a raster frame and {walker.converted} other elements: the drawing"
            " is a scanned image that the DGN points at. Mantle does not read the scan."
        )
    if any(m["dimension"] == 3 and m.get("elements") for m in listed):
        notes.append(
            f"3D, drawn in plan (top view): {not_flat} elements are not flat in Z"
            f" and {wild} have a wild Z (all models; see `models` for each)."
        )
    kept_apart = [m for m in listed if m.get("space") == "block"]
    if kept_apart:
        notes.append(
            f"{len(kept_apart)} more models are converted into blocks of their own and are not"
            f" read: their {sum(m['elements'] for m in kept_apart)} elements, of them"
            f" {sum(m['texts'] for m in kept_apart)} texts, are not in the registry, the bones"
            " or the picture (see `models`)."
        )
    renamed = sum(1 for c in changed if c["level"] != c["layer"])
    if renamed:
        notes.append(
            f"{renamed} levels are renamed (see `levels_changed`): DXF refuses"
            " \" * / : ; < = > ? \\ and ` in a layer name, and each becomes _. A circuit"
            " on such a level is named after its layer, not its level."
        )
    if len(changed) > renamed:
        notes.append(
            f"{len(changed) - renamed} levels share one layer name with another level (see"
            " `levels_changed`); a level with no name is shown by its number."
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
    if gap:
        notes.append(
            f"The converter's count differs from ezdgn's record count by {gap}: a converter"
            " fault, so the counts are not exact."
        )
    if reader_gap:
        notes.append(
            f"ezdgn found {objects} graphical objects in the file but gave {records} element"
            f" records: {abs(reader_gap)} are not read, and the counts here do not hold them."
        )
    if skipped:
        notes.append(
            f"The DGN's model index lists {len(skipped)} more models whose content is not in the"
            " file (deleted, or kept in another file): they are not read (see `skipped_models`)."
        )
    if refused:
        notes.append(f"{refused} entities or attributes are left out: ezdxf refused them.")
    if facts.get("data_error"):
        notes.append(
            "The DGN data reader failed on this file, so it is read as ezdgn 0.3.2 reads it:"
            " no item data, tags or shared cell definitions (see `data_error`)."
        )
    info = {
        "format": facts.get("format"),
        "reader": facts.get("reader", "ezdgn"),
        "dimension": dimension,
        "unit": drawing.get("unit"),
        "models": listed,
        "records": records,
        "ezdgn_objects": objects,
        "reader_gap": reader_gap,
        "skipped_models": skipped[:MAX_ROWS],
        "elements": walker.converted + not_converted,
        "converted": walker.converted,
        "not_converted": missed,
        "not_converted_total": not_converted,
        "gap": gap,
        "unreached": unreached,
        "repeated": repeated,
        "not_flat": not_flat,
        "wild_z": wild,
        "levels_changed": changed[:MAX_ROWS],
        "levels_changed_total": len(changed),
        "cells": [
            {"name": n, "placements": here, "other_models": other, "variants": len(blocks),
             "blocks": blocks[:MAX_ROW_BLOCKS]}
            for n, here, other, blocks in cells[:MAX_ROWS]
        ],
        "cell_names": len(cells),
        "shared_cells_not_expanded": walker.shared,
        "shared_cell_names": len(walker.shared_names),
        "text_turn_unknown": walker.text_turn_unknown,
        "raster_frames": walker.raster,
        "raster_only": raster_only,
        "note": " ".join(notes) or None,
    }
    for key in ("control_records", "text_encoding", "data_error"):
        if key in facts:
            info[key] = facts[key]
    if refused:
        info["entities_refused"] = refused
    if defs is not None:
        _data_facts(info, walker, defs, facts)
    return doc, info


def _data_facts(info: dict, walker: _Ops, defs: dict, facts: dict) -> None:
    """The data reader's counts and notes in the index (only with it)."""
    sc = walker.sc
    info["shared_cells"] = {
        "definitions": defs["count"],
        "definitions_unusable": defs["unusable"],
        "definitions_same_key": defs["duplicates"],
        "definitions_error": facts.get("definitions_error"),
        "definitions_built": sc.get("definitions_built", 0),
        "expanded": walker.expanded,
        "not_expanded": walker.shared,
        "weight": walker.total,
        **{k: sc.get(k, 0) for k in (
            "no_definition", "not_in_plan", "other_unit_scale", "too_large",
            "nested_no_definition", "nested_not_in_plan", "nested_depth_limit", "nested_cycle",
            "components_converted", "components_not_converted", "components_unreached",
            "texts_placed")},
    }
    info["tags"] = {"tag_sets": defs["tag_sets"], **{k: walker.tag.get(k, 0) for k in (
        "tags", "with_value", "with_definition", "attached", "as_text", "not_placed", "dropped",
        "in_definitions")}}
    classes = sorted(walker.classes.items(), key=lambda kv: (-kv[1], kv[0]))
    info["item_data"] = {
        **{k: walker.item.get(k, 0) for k in (
            "instances", "properties", "no_data", "attributes", "dropped", "not_read", "in_definitions")},
        "classes": [{"class": c, "schema": s, "instances": k} for (c, s), k in classes[:MAX_ROW_BLOCKS]],
    }
    info["data_dropped"] = walker.dropped
    info["data_same_tag"] = walker.same_tag
    notes = []
    if walker.shared:
        notes.append(
            f"{walker.shared} shared cell instances are not expanded (an empty block; see"
            " `shared_cells` for why): their geometry is not drawn."
        )
    if walker.item.get("attributes"):
        notes.append(
            f"{walker.item['attributes']} item data values are hidden attributes of their shared"
            " cell inserts (tag = property name)."
        )
    if walker.tag.get("tags"):
        t = walker.tag
        notes.append(
            f"{t['tags']} tags: {t.get('attached', 0)} are hidden attributes of their cell,"
            f" {t.get('as_text', 0)} are hidden texts at their origin, {t.get('not_placed', 0)}"
            " are not placed (no value, or no origin and no host)."
        )
    if walker.dropped:
        notes.append(f"{walker.dropped} attributes or texts past {MAX_ADDED_ATTRIBS} a file are dropped.")
    if walker.item.get("not_read"):
        notes.append(
            f"{walker.item['not_read']} item data entries are not read: the file's {MAX_ADDED_ATTRIBS}"
            " item values were spent."
        )
    if sc.get("too_large"):
        notes.append(
            f"{sc['too_large']} shared cell instances are not expanded: they would take the file"
            f" past {MAX_EXPANDED_WEIGHT} expanded entities and vertices, or past {WILD:g} master units."
        )
    if walker.same_tag:
        notes.append(
            f"{walker.same_tag} attributes repeat a tag already on their insert: the registry's"
            " `blocks` keeps the first, and `texts` holds them all."
        )
    if facts.get("definitions_error"):
        notes.append("ezdgn could not read the shared cell definitions: no shared cell is expanded.")
    if notes:
        info["note"] = " ".join(filter(None, [info.get("note"), *notes]))


def load(src: str, data: bool = True) -> tuple[list, dict]:
    """ezdgn's read of `src` as the element trees and the facts, with the
    data when `data` and the installed ezdgn has the data reader. Raises
    DgnRefused for a DGN Mantle does not read, and ezdgn's own errors for
    a file it cannot read."""
    import ezdgn  # noqa: PLC0415 - child-only import

    info = ezdgn.detect_format(src)
    if info.is_v7 and info.dimension == 3:
        raise DgnRefused("DGN V7 3D is not read")
    source = ezdgn.open_document(src)
    if info.is_v7:
        models, facts = _v7_tree(source)
    elif data and reads_data(ezdgn):
        definitions, error = _definitions(ezdgn, src)
        models, facts = _v8_tree(source, definitions)
        if error:
            facts["definitions_error"] = error
    else:
        models, facts = _v8_tree(source)
    facts["reader"] = f"ezdgn {getattr(ezdgn, '__version__', '')}".strip()
    return models, facts


def read_data(src: str) -> tuple:
    """((document, facts), None) of `src` read with the data, or (None, why)
    when it is not: why is None when the installed ezdgn has no data reader,
    else the type name of what failed. The one guard of the data reader: it
    covers ezdgn's reads and the build of the document, so the caller reads
    the file again the 0.3.2 way (`load(src, data=False)`) with nothing
    lost. Only the type name is kept (an error's text may quote the file),
    and the failed attempt is gone (this frame has returned) before the
    caller reads again."""
    import ezdgn  # noqa: PLC0415 - child-only import

    if not reads_data(ezdgn):
        return None, None
    try:
        return build_document(*load(src)), None
    except (SystemExit, KeyboardInterrupt, DgnRefused):
        raise
    except BaseException as err:  # noqa: BLE001 - a Rust panic is a BaseException
        return None, type(err).__name__


def reads_data(ezdgn) -> bool:
    """The one check: an ezdgn that reads shared cell definitions is the
    build with the data reader (item data, tags, definitions). ezdgn 0.3.2
    has none of them."""
    return callable(getattr(ezdgn, "read_v8_shared_cell_definitions", None))


def _definitions(ezdgn, src: str) -> tuple:
    """The file's shared cell definitions, read once (ezdgn's own limits
    apply), and the error's type name when the read fails: the file is
    then read with no definition, not refused."""
    try:
        return tuple(ezdgn.read_v8_shared_cell_definitions(src)), None
    except (SystemExit, KeyboardInterrupt):
        raise
    except BaseException as err:  # noqa: BLE001 - a Rust panic is a BaseException
        return (), type(err).__name__


def read(src: str):
    """`src` as an ezdxf document and the `dgn` facts: with the data, else
    (or when it fails) the 0.3.2 way. cad.py takes the same steps, so a
    failure names its part."""
    done, error = read_data(src)
    if done is not None:
        return done
    models, facts = load(src, data=False)
    if error:
        facts["data_error"] = error
    return build_document(models, facts)
