"""DWG "bones": the pipe geometry of a drawing's model space, as a network.

The registry half of `/dwg/render` (layers, texts, blocks, counts) says what
a drawing is labelled with; this module says how its lines connect. It rides
the SAME ezdxf pass in the `--dwg-render` child (one upload, one parse), and
everything past the entity readers is a pure function over plain numbers, so
the network rules can be unit tested without a drawing file.

What comes out (all coordinates are model space, WCS, drawing units):
  segments  every LINE, each vertex pair of an LWPOLYLINE / 2D or 3D
            POLYLINE, and each ARC, recorded by its two end points. A bulged
            polyline segment or an ARC keeps its true arc length but its END
            POINTS are the chord: a curve is never split by a tee. Small
            closed polylines (symbols) are left out.
  inserts   every INSERT, with or without attributes: block name, layer,
            handle, insertion point, rotation, scale and an axis-aligned
            bounding box of the block's own geometry (text left out).
  nodes     segment end points snapped together within `tol`.
  circuits  per `Circuit <name>` layer group, when the drawing has any.

Network rules (decided 2026-10-25, phase 1; round-1 fixes the same day):
  - Snap tolerance `tol` = SNAP_REL (2e-4) x the segment's sheet scale. On
    one sheet that is the diagonal of the box that holds the middle 99% of
    segment end points: on an A1 sheet drawn 1:1 in millimetres (diagonal
    about 1,030) about 0.2 mm, under a pen width. The middle 99% keeps one
    stray entity far off the sheet from loosening the tolerance for
    everything else. Several sheets tiled in one model space each scale by
    their own diagonal (see sheet_scales), so the layout's size does not
    loosen the snap or the block rule.
  - Two end points within `tol` are one node (greedy, in drawing order,
    against the node's first point, so a chain of near points cannot creep).
  - An end point that lies within `tol` of the INTERIOR of a straight
    segment splits that segment there: a branch drawn up to a header is a
    tee even though the header is one LINE. The split pieces are separate
    rows with the same handle and part.
  - Two segments that cross with no end point at the crossing are NOT
    joined, whatever the angle: on a P&ID that is a line passing over
    another. The same holds for a broken-line crossing, where the passing
    line is drawn with a gap under `tol` each side: two ends facing each
    other across the other line, on one line, are one node (the line goes
    on) and the other line is not split.
  - The same straight piece drawn twice over (same two nodes) is one
    connection: the copy keeps its Segments row but adds no degree, and a
    circuit counts it once.
  - A closed polyline whose box diagonal is at most SYMBOL_REL (1%) of its
    sheet scale is a symbol, not pipe (a DONUT tee dot, a valve drawn as a
    closed bowtie): its segments are left out (geometry.skipped "small
    closed polyline") and its box bridges like a small block's, with an
    empty Block name and the polyline's handle. A closed polyline with two
    vertices keeps its closing half when either half is bulged.
  - Degree is the number of segment ends at a node: 1 = end, 2 = joint,
    3 or more = tee.
  - A block bridges pipe ends: every degree-1 node inside a small insert's
    box (expanded by `tol`) touches that block, and a block touched by two
    or more ends joins them (kind "block": a valve, a reducer, a spec
    break). A block touched by one end leaves it an end, with the block
    named (a cap, a nozzle, a continuation arrow). "Small" is a box diagonal
    of at most BLOCK_MAX_REL (5%) of the node's sheet scale, so a border or
    title block around the whole sheet never bridges anything.
  - A run is a connected set of segments, through joints, tees and block
    bridges.
  - Budget: the pass spends work units (grid entries written, candidates
    looked at) and wall time; past MAX_WORK_UNITS or MAX_GEOMETRY_SECONDS it
    stops with GeometryBudgetExceeded and the caller reports geometry_error,
    keeping the registry and the render. An extent or number that is not
    finite stops it the same way (ValueError): no NaN or Infinity is ever
    sent.

Circuits (the Circuitizer layer convention, `Circuit <name>`):
  - `Circuit X`            the main path of circuit X.
  - `Circuit X-Bnn`        branch nn of X, drawn on its own layer: part of
                           X's main path (on X's row).
  - `Circuit X-DL`         a deadleg of X (counted on X's row); also
                           `X-DLn`.
  - `Circuit X-B01-DL`     a deadleg of X on branch B01 (on X's row); also
                           `X-B01-DLn`.
  - `Circuit X-D03`        deadleg 03 of X (on X's row). A GUESS: seen on
                           sheets, not documented by the add-in.
  - `Circuit X-IP1`        injection point 1 of X: its own row, Parent X,
                           Kind "injection point" (API 570 treats an
                           injection point as a circuit of its own).
                           `Circuit X-IP1-DL` is a deadleg of that row.
  Any other suffix is part of the circuit name. The root name (X) must have
  the circuit-name shape: letters, digits and . _ / - only, no spaces, at
  most 64 characters, starting with a letter or digit and holding at least
  one digit ("25000-015-01", "C-101"); "Circuit Breakers" is not a circuit.
  A drawing with no such layer gets no circuits at all. A line-number block
  whose CIRCUIT attribute names a circuit is listed on that circuit only;
  one with no circuit named is listed on every circuit it is near.
"""

from __future__ import annotations

import json
import math
import re
import time

# Snap tolerance as a share of the extent diagonal. See the module docstring.
SNAP_REL = 2e-4
# Labels within this share of the extent diagonal of a circuit's segments are
# "near" it (about 10 mm on an A1 sheet at 1:1): a line-number label sits a
# text height or two off its pipe.
NEAR_REL = 1e-2
# Largest insert box, as a share of the extent diagonal, that may bridge.
BLOCK_MAX_REL = 0.05
# The extent ignores this share of end points at each side (stray entities).
EXTENT_TRIM = 0.005
# Sheet clusters: segment boxes are laid on a grid this many cells across
# the extent (see sheet_scales).
SHEET_GRID = 256
# A closed polyline whose box diagonal is at most this share of its sheet's
# scale is a symbol (a DONUT tee dot, a valve drawn as a closed bowtie), not
# pipe: about 10 mm on an A1 sheet at 1:1.
SYMBOL_REL = 1e-2
# Broken-line crossing: each end must sit more than this share of the snap
# tolerance off the other line (an end ON the line is a tee), and the two
# halves must be antiparallel within about 10 degrees (cos 170 = -0.985).
GAP_MIN_REL = 0.1
GAP_COS = 0.985
# ...and each half must leave the other line at 20 degrees or more.
GAP_SIN = 0.342
# Work budget of one geometry pass (see _Budget): a large real P&ID (a few
# thousand segments) spends well under 1% of the units. Past either limit
# the bones are left out with geometry_error; the registry and the render
# stay. The seconds leave the render most of TIMEOUT_DWG_RENDER (240 s).
MAX_WORK_UNITS = 40_000_000
MAX_GEOMETRY_SECONDS = 60.0

SEGMENT_TYPES = ("LINE", "LWPOLYLINE", "POLYLINE", "ARC")
# Curves that could be drawn pipe but are not segments in phase 1.
SKIPPED_CURVES = ("SPLINE", "ELLIPSE", "MLINE")
TEXT_TYPES = ("TEXT", "MTEXT", "ATTDEF", "ATTRIB")

# Reply budgets, in characters of JSON per list: a large real P&ID (about
# 1,000 LINEs and 800 LWPOLYLINEs, so a few thousand segments) uses well
# under a tenth of each.
MAX_SEGMENT_CHARS = 4_000_000
MAX_NODE_CHARS = 2_000_000
MAX_INSERT_CHARS = 2_000_000
MAX_CIRCUIT_CHARS = 1_000_000
# Per circuit row: end points listed, and characters of each text list.
MAX_CIRCUIT_ENDS = 40
MAX_CIRCUIT_LIST_CHARS = 2_000
# A node lists at most this many layers.
MAX_NODE_LAYERS = 8

_LINE_TAG = re.compile(r"^LINE[\s_.-]*(NO|NUM|NUMBER)?\.?$", re.I)
_CIRCUIT_TAG = re.compile(r"^CIRCUIT([\s_.-]*(NO|NAME|ID))?$", re.I)
_CIRCUIT_LAYER = re.compile(r"^\s*circuit\s+(.+?)\s*$", re.I)
# The shape of a circuit name: letters, digits and . _ / - with no spaces,
# at most 64 characters, starting with a letter or digit, and holding at
# least one digit ("25000-015-01", "C-101"). "Circuit Breakers" is not one.
_CIRCUIT_NAME = re.compile(r"^(?=[^\d]*\d)[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$")
# Deadleg suffixes (GUESSED from three Circuitizer sheets, not documented by
# the add-in): -DL, -DLn, -Bnn-DL, -Bnn-DLn and -Dnn.
_DEADLEG_SUFFIX = re.compile(r"^(?P<base>.+?)-(?P<sub>(?:B\d+-)?DL\d*|D\d+)$", re.I)
# -Bnn: a branch drawn on its own layer; part of its circuit's main path.
_BRANCH_SUFFIX = re.compile(r"^(?P<base>.+?)-(?P<sub>B\d+)$", re.I)
# -IPn: an injection point, a circuit of its own with a parent.
_IP_SUFFIX = re.compile(r"^(?P<base>.+?)-(?P<sub>IP\d*)$", re.I)


# ── numbers ──────────────────────────────────────────────────────────────


def coord(value, digits: int = 1):
    """A number rounded for the reply, or None. Same rule as the worker's
    coordinates: a bare NaN would make index.json unparseable app side."""
    try:
        v = float(value)
    except Exception:
        return None
    # + 0.0 turns a rounded -0.0 into 0.0.
    return round(v, digits) + 0.0 if math.isfinite(v) else None


def _finite(*values) -> bool:
    return all(isinstance(v, (int, float)) and math.isfinite(v) for v in values)


def _arc_length(chord: float, bulge: float) -> float:
    """Length of a polyline arc segment from its chord and bulge
    (bulge = tan(angle / 4))."""
    if not bulge:
        return chord
    theta = 4.0 * math.atan(abs(bulge))
    half = math.sin(theta / 2.0)
    return chord if half == 0 else chord * theta / (2.0 * half)


# ── entity readers (ezdxf in, plain tuples out) ──────────────────────────


def entity_segments(e) -> list:
    """The segments of one model-space entity, as dicts with raw floats:
    part, x1, y1, x2, y2, length, curved. [] for anything that is not a
    segment type. WCS throughout (an LWPOLYLINE or 2D POLYLINE is stored in
    its OCS; a mirrored one would otherwise land on the wrong side)."""
    t = e.dxftype()
    out = []

    def add(part, a, b, length, curved):
        x1, y1, x2, y2 = float(a[0]), float(a[1]), float(b[0]), float(b[1])
        if not _finite(x1, y1, x2, y2, length) or length <= 0:
            return
        out.append(
            {"part": part, "x1": x1, "y1": y1, "x2": x2, "y2": y2,
             "length": float(length), "curved": curved}
        )

    if t == "LINE":
        a, b = e.dxf.start, e.dxf.end
        add(0, a, b, math.hypot(b[0] - a[0], b[1] - a[1]), False)
    elif t == "ARC":
        a, b = e.start_point, e.end_point
        span = (float(e.dxf.end_angle) - float(e.dxf.start_angle)) % 360.0 or 360.0
        add(0, a, b, abs(float(e.dxf.radius)) * math.radians(span), True)
    elif t == "LWPOLYLINE":
        pts = list(e.vertices_in_wcs())
        bulges = [float(p[2] or 0.0) for p in e.get_points("xyb")]
        bulges += [0.0] * (len(pts) - len(bulges))
        closed = bool(e.closed)
        for i in _vertex_pairs(len(pts), bulges, closed):
            a, b = pts[i], pts[(i + 1) % len(pts)]
            chord = math.hypot(b[0] - a[0], b[1] - a[1])
            add(i, a, b, _arc_length(chord, bulges[i]), bool(bulges[i]))
        if closed:
            _mark_closed(out, pts, bulges)
    elif t == "POLYLINE":
        mode = e.get_mode()
        if mode not in ("AcDb2dPolyline", "AcDb3dPolyline"):
            return out  # meshes and polyface meshes are not pipe
        verts = [v for v in e.vertices if not (int(v.dxf.get("flags", 0)) & 16)]
        if mode == "AcDb2dPolyline":
            ocs = e.ocs()
            elevation = float(e.dxf.elevation[2]) if e.dxf.hasattr("elevation") else 0.0
            pts = [ocs.to_wcs((v.dxf.location[0], v.dxf.location[1], elevation)) for v in verts]
            bulges = [float(v.dxf.get("bulge", 0.0) or 0.0) for v in verts]
        else:
            pts = [v.dxf.location for v in verts]
            bulges = [0.0] * len(verts)
        closed = bool(e.is_closed)
        for i in _vertex_pairs(len(pts), bulges, closed):
            a, b = pts[i], pts[(i + 1) % len(pts)]
            chord = math.hypot(b[0] - a[0], b[1] - a[1])
            add(i, a, b, _arc_length(chord, bulges[i]), bool(bulges[i]))
        if closed:
            _mark_closed(out, pts, bulges)
    return out


def _vertex_pairs(count: int, bulges: list, closed: bool) -> list:
    """Indexes i of the vertex pairs (i, i + 1) of a polyline. A closed one
    adds the closing pair; with two vertices that pair is kept only when it
    is real geometry (either half bulged, as in a DONUT), not the first
    straight segment traced back."""
    pairs = list(range(count - 1))
    if closed and (count > 2 or (count == 2 and any(bulges[:2]))):
        pairs.append(count - 1)
    return pairs


def _mark_closed(out: list, pts: list, bulges: list) -> None:
    """Mark the segments of a closed polyline with `span`, the entity's box
    (minx, miny, maxx, maxy), arcs widened by their mid points. The network
    reads a closed polyline that small as a symbol, not pipe."""
    xs, ys = [], []
    n = len(pts)
    for i in range(n):
        a, b = pts[i], pts[(i + 1) % n]
        xs.append(float(a[0]))
        ys.append(float(a[1]))
        bulge = bulges[i] if i < len(bulges) else 0.0
        if bulge:
            # The arc mid point sits the sagitta off the chord's middle.
            mx, my = (a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0
            dx, dy = b[0] - a[0], b[1] - a[1]
            # Sagitta = bulge x chord / 2, to the right of a->b for bulge > 0.
            xs.append(float(mx + dy * bulge / 2.0))
            ys.append(float(my - dx * bulge / 2.0))
    if not xs or not _finite(*xs, *ys):
        return
    span = (min(xs), min(ys), max(xs), max(ys))
    for seg in out:
        seg["span"] = span


def block_box(doc, name: str, cache: dict):
    """Axis-aligned box of a block definition's geometry in block
    coordinates, text left out (a tag above a valve must not widen the
    valve). Cached per block name; None when the block has no geometry."""
    if name in cache:
        return cache[name]
    box = None
    try:
        from ezdxf import bbox  # noqa: PLC0415 - child-only import

        block = doc.blocks.get(name)
        if block is not None:
            ext = bbox.extents((x for x in block if x.dxftype() not in TEXT_TYPES), fast=False)
            if ext.has_data:
                box = (ext.extmin[0], ext.extmin[1], ext.extmax[0], ext.extmax[1], ext.extmin[2])
    except Exception:
        box = None
    cache[name] = box
    return box


def insert_record(e, doc, cache: dict) -> dict:
    """One INSERT as a dict of raw values: block, handle, x, y, rotation,
    sx, sy, box (minx, miny, maxx, maxy in WCS, or None), attribs (number of
    non-empty attribute values)."""
    name = str(getattr(e.dxf, "name", "") or "")
    try:
        point = e.ocs().to_wcs(e.dxf.insert)
        x, y = float(point[0]), float(point[1])
    except Exception:
        x = y = None
    box = None
    local = block_box(doc, name, cache)
    if local is not None:
        try:
            m = e.matrix44()
            minx, miny, maxx, maxy, z = local
            corners = list(
                m.transform_vertices(
                    [(minx, miny, z), (maxx, miny, z), (minx, maxy, z), (maxx, maxy, z)]
                )
            )
            xs = [c[0] for c in corners]
            ys = [c[1] for c in corners]
            if _finite(*xs, *ys):
                box = (min(xs), min(ys), max(xs), max(ys))
        except Exception:
            box = None
    attribs = 0
    for attrib in getattr(e, "attribs", None) or []:
        try:
            if str(attrib.dxf.text or "").strip():
                attribs += 1
        except Exception:
            continue
    return {
        "block": name,
        "handle": str(getattr(e.dxf, "handle", "") or ""),
        "x": x,
        "y": y,
        "rotation": float(e.dxf.get("rotation", 0.0) or 0.0),
        "sx": float(e.dxf.get("xscale", 1.0)),
        "sy": float(e.dxf.get("yscale", 1.0)),
        "box": box,
        "attribs": attribs,
    }


# ── work budget ──────────────────────────────────────────────────────────


class GeometryBudgetExceeded(Exception):
    """The geometry pass would cost more than its budget. The caller drops
    the bones and reports this as geometry_error; the registry and the
    render are kept."""


class _Budget:
    """Work units (grid entries written, candidates looked at) and a wall
    clock for one geometry pass. Units make the cut the same on every
    machine; the clock is the backstop under the child's hard timeout."""

    def __init__(self, units: int | None = None, seconds: float | None = None):
        self.units = MAX_WORK_UNITS if units is None else units
        self.seconds = MAX_GEOMETRY_SECONDS if seconds is None else seconds
        self.left = self.units
        self.deadline = time.monotonic() + self.seconds
        self.calls = 0

    def spend(self, n: int = 1) -> None:
        self.left -= n
        if self.left < 0:
            raise GeometryBudgetExceeded(
                f"the network needs more than {self.units:,} work units"
                " (a very dense or very large drawing): geometry not built"
            )
        self.calls += 1
        if not self.calls & 255:
            self.check_clock()

    def check_clock(self) -> None:
        """Stop past the wall clock, for a loop that spends its units up
        front."""
        if time.monotonic() > self.deadline:
            raise GeometryBudgetExceeded(
                f"the network took more than {self.seconds:g} s: geometry not built"
            )


# ── spatial index ────────────────────────────────────────────────────────


class _Grid:
    """A uniform hash grid. `near(x, y)` yields every item whose geometry
    may lie within cell/4 of the point (callers pick cell >= 4 x reach).
    Every entry written and every candidate yielded is spent from the
    budget."""

    MAX_SAMPLES = 4096

    def __init__(self, cell: float, budget: _Budget, dense=None):
        self.cell = cell
        self.cells: dict = {}
        self.long: list = []  # too long to sample: checked on every query
        # `dense` (minx, miny, maxx, maxy) is where nearly every query point
        # is (the trimmed extent). A segment is sampled only inside it, and
        # also listed in `outside`, checked only for queries outside it: a
        # line from far away across a dense cluster costs its length in the
        # cluster, not on every query.
        self.dense = dense
        self.outside: list = []
        self.budget = budget

    def _key(self, x: float, y: float):
        return (math.floor(x / self.cell), math.floor(y / self.cell))

    def add_point(self, x: float, y: float, item) -> None:
        self.cells.setdefault(self._key(x, y), []).append(item)

    def add_segment(self, x1, y1, x2, y2, item) -> None:
        if self.dense is not None:
            # Clip to the dense box widened by a cell, so a query inside the
            # box still finds every segment part within reach of it.
            a, b, c, d = self.dense
            pad = self.cell
            inside = (a <= min(x1, x2) and max(x1, x2) <= c
                      and b <= min(y1, y2) and max(y1, y2) <= d)
            if not inside:
                self.outside.append(item)
                clipped = _clip(x1, y1, x2, y2, a - pad, b - pad, c + pad, d + pad)
                if clipped is None:
                    return
                x1, y1, x2, y2 = clipped
        # Samples every cell/2, so every point of the segment is within
        # cell/4 of a sample: a query point within cell/4 of the segment is
        # then within cell/2 of a sampled cell, one of its 3x3 neighbours.
        n = int(math.ceil(math.hypot(x2 - x1, y2 - y1) / (self.cell / 2.0)))
        if n > self.MAX_SAMPLES:
            self.long.append(item)
            return
        n = max(n, 1)
        self.budget.spend(n + 1)
        seen = set()
        for i in range(n + 1):
            t = i / n
            k = self._key(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t)
            if k not in seen:
                seen.add(k)
                self.cells.setdefault(k, []).append(item)

    def add_box(self, minx, miny, maxx, maxy, item) -> None:
        kx0, ky0 = self._key(minx, miny)
        kx1, ky1 = self._key(maxx, maxy)
        area = (kx1 - kx0 + 1) * (ky1 - ky0 + 1)
        if area > self.MAX_SAMPLES:
            self.long.append(item)
            return
        self.budget.spend(area)
        for kx in range(kx0, kx1 + 1):
            for ky in range(ky0, ky1 + 1):
                self.cells.setdefault((kx, ky), []).append(item)

    def near(self, x: float, y: float):
        kx, ky = self._key(x, y)
        seen = set()
        spend = self.budget.spend
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                items = self.cells.get((kx + dx, ky + dy))
                if not items:
                    continue
                spend(len(items))
                for item in items:
                    if item not in seen:
                        seen.add(item)
                        yield item
        extra = self.long
        if self.outside:
            a, b, c, d = self.dense
            if not (a <= x <= c and b <= y <= d):
                extra = self.long + self.outside
        if extra:
            spend(len(extra))
            for item in extra:
                if item not in seen:
                    seen.add(item)
                    yield item


def _clip(x1, y1, x2, y2, minx, miny, maxx, maxy):
    """The part of a segment inside a box (Liang-Barsky), or None."""
    t0, t1 = 0.0, 1.0
    dx, dy = x2 - x1, y2 - y1
    for p, q in ((-dx, x1 - minx), (dx, maxx - x1), (-dy, y1 - miny), (dy, maxy - y1)):
        if p == 0:
            if q < 0:
                return None
            continue
        r = q / p
        if p < 0:
            if r > t1:
                return None
            t0 = max(t0, r)
        else:
            if r < t0:
                return None
            t1 = min(t1, r)
    return x1 + dx * t0, y1 + dy * t0, x1 + dx * t1, y1 + dy * t1


def _point_segment(px, py, x1, y1, x2, y2):
    """(distance, t) from a point to a segment, t the projection in [0, 1]."""
    dx, dy = x2 - x1, y2 - y1
    den = dx * dx + dy * dy
    t = 0.0 if den == 0 else max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / den))
    return math.hypot(px - (x1 + t * dx), py - (y1 + t * dy)), t


class _Union:
    """Union-find over node indexes, sparse: it costs what it touches."""

    def __init__(self):
        self.parent: dict = {}

    def find(self, a: int) -> int:
        parent = self.parent
        while parent.get(a, a) != a:
            parent[a] = parent.get(parent[a], parent[a])
            a = parent[a]
        return a

    def join(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[max(ra, rb)] = min(ra, rb)


# ── the network (pure) ───────────────────────────────────────────────────


def _trimmed_box(xs: list, ys: list):
    """(minx, miny, maxx, maxy) of the middle 99% of the points; sorts the
    lists in place."""
    xs.sort()
    ys.sort()
    lo = int(math.floor(EXTENT_TRIM * (len(xs) - 1)))
    hi = int(math.ceil((1.0 - EXTENT_TRIM) * (len(xs) - 1)))
    return xs[lo], ys[lo], xs[hi], ys[hi]


def extent_diagonal(segments: list) -> float:
    """Diagonal of the box holding the middle 99% of segment end points."""
    xs, ys = [], []
    for s in segments:
        xs += (s["x1"], s["x2"])
        ys += (s["y1"], s["y2"])
    if not xs:
        return 0.0
    x0, y0, x1, y1 = _trimmed_box(xs, ys)
    return math.hypot(x1 - x0, y1 - y0)


def sheet_scales(segments: list, budget: _Budget | None = None):
    """(scale per segment, extent diagonal, sheets, extent box): the
    length every tolerance of a segment is a share of.

    One sheet in model space (the usual case): every segment's scale is the
    extent diagonal, as before. Several sheets tiled in one model space
    would otherwise loosen the snap and the block rule by the whole
    layout's size, so the segments are grouped into clusters: the boxes of
    segments that overlap, at 1/SHEET_GRID of the extent, are one cluster
    (a sheet border's box holds its whole sheet). A cluster is sheet sized
    when its diagonal is at least half the largest cluster's and at least
    1/16 of the layout's long side, and its box is two dimensional (area at
    least a tenth of its diagonal squared). When there are two or more,
    they cover at least half the extent box, and the largest is at most 80%
    of the extent diagonal, each sheet scales by its own diagonal and
    everything else by the largest sheet's. Anything less clear keeps the
    one extent: a sparse drawing of separate small parts is not several
    sheets."""
    budget = budget or _Budget()
    n = len(segments)
    if not n:
        return [], 0.0, 0, None
    xs, ys = [], []
    for s in segments:
        xs += (s["x1"], s["x2"])
        ys += (s["y1"], s["y2"])
    budget.spend(2 * n)
    x0, y0, x1, y1 = _trimmed_box(xs, ys)
    w, h = x1 - x0, y1 - y0
    diag = math.hypot(w, h)
    box = (x0, y0, x1, y1)
    one = ([diag] * n, diag, 1, box)
    size = max(w, h) / SHEET_GRID
    if not math.isfinite(diag) or not size > 0 or not math.isfinite(size):
        return one
    cols = min(SHEET_GRID, int(w / size)) + 1
    rows = min(SHEET_GRID, int(h / size)) + 1

    def cx(x):
        return min(cols - 1, max(0, int((x - x0) / size)))

    def cy(y):
        return min(rows - 1, max(0, int((y - y0) / size)))

    # Box coverage by a 2D difference array: O(segments + cells).
    diff = [[0] * (cols + 1) for _ in range(rows + 1)]
    for s in segments:
        a, b = cx(min(s["x1"], s["x2"])), cx(max(s["x1"], s["x2"]))
        c, d = cy(min(s["y1"], s["y2"])), cy(max(s["y1"], s["y2"]))
        diff[c][a] += 1
        diff[c][b + 1] -= 1
        diff[d + 1][a] -= 1
        diff[d + 1][b + 1] += 1
    budget.spend(n + rows * cols)
    covered = [[False] * cols for _ in range(rows)]
    acc = [0] * (cols + 1)
    for r in range(rows):
        run = 0
        for c in range(cols):
            run += diff[r][c]
            acc[c] += run
            covered[r][c] = acc[c] > 0
    label = [[-1] * cols for _ in range(rows)]
    count = 0
    for r in range(rows):
        for c in range(cols):
            if not covered[r][c] or label[r][c] >= 0:
                continue
            stack = [(r, c)]
            label[r][c] = count
            while stack:
                rr, cc = stack.pop()
                for nr, nc in ((rr + 1, cc), (rr - 1, cc), (rr, cc + 1), (rr, cc - 1)):
                    if 0 <= nr < rows and 0 <= nc < cols and covered[nr][nc] and label[nr][nc] < 0:
                        label[nr][nc] = count
                        stack.append((nr, nc))
            count += 1
    if count < 2:
        return one
    comp = [label[cy(s["y1"])][cx(s["x1"])] for s in segments]
    pts: dict = {}
    for k, s in zip(comp, segments):
        p = pts.setdefault(k, ([], []))
        p[0].extend((s["x1"], s["x2"]))
        p[1].extend((s["y1"], s["y2"]))
    diags, areas = {}, {}
    for k, (px, py) in pts.items():
        a, b, c, d = _trimmed_box(px, py)
        diags[k] = math.hypot(c - a, d - b)
        areas[k] = (c - a) * (d - b)
    largest = max(diags.values())
    floor = max(0.5 * largest, max(w, h) / 16.0)
    sheets = {k for k, v in diags.items() if v >= floor and areas[k] >= 0.1 * v * v}
    if (len(sheets) < 2 or largest > 0.8 * diag
            or sum(areas[k] for k in sheets) < 0.5 * w * h):
        return one
    return [diags[k] if k in sheets else largest for k in comp], diag, len(sheets), box


def build_network(segments: list, boxes: list | None = None, tol: float | None = None,
                  budget: _Budget | None = None) -> dict:
    """Snap `segments` (dicts with x1 y1 x2 y2 length curved, plus anything
    else, passed through) into a network. `boxes` are insert boxes as dicts
    with minx miny maxx maxy (and anything else). Returns:
      tol, diag   the largest snap tolerance used, the extent diagonal
      sheets      sheet clusters the tolerances scale by (1 = the extent)
      scale       per segment, the length its tolerances are a share of
      nodes   [{x, y, degree, kind, block (index into boxes or None),
                bridged (bool), tol}], index = node id - 1
      pieces  [{seg (index into segments), x1 y1 x2 y2 length, n1, n2, run,
                duplicate}]
      bridges [[node index, ...] per bridging box]
      boxes   `boxes` plus one per small closed polyline read as a symbol
      symbols number of those symbols (their segments are not pieces)
      runs    number of runs
    Raises GeometryBudgetExceeded past the work budget, and ValueError on
    an extent that is not a finite number. Pure: no ezdxf, no I/O."""
    budget = budget or _Budget()
    boxes = list(boxes or [])
    scale, diag, sheets, dense = sheet_scales(segments, budget)
    if not math.isfinite(diag):
        raise ValueError("the drawing extent is not a finite number: geometry not built")
    if tol is not None:
        tols = [tol] * len(segments)
    else:
        tols = [max(sc * SNAP_REL, 1e-9) for sc in scale]
    tol_max = max(tols, default=max(tol or 0.0, 1e-9))

    # 0. Small closed polylines (a DONUT tee dot, a valve drawn as a closed
    #    bowtie) are symbols, not pipe: their box may bridge like a block's.
    symbol_box: dict = {}
    active = []
    for i, s in enumerate(segments):
        span = s.get("span")
        if span is not None and math.hypot(span[2] - span[0], span[3] - span[1]) <= SYMBOL_REL * scale[i]:
            key = (s.get("handle", ""), span)
            if key not in symbol_box:
                symbol_box[key] = len(boxes)
                boxes.append({"minx": span[0], "miny": span[1], "maxx": span[2], "maxy": span[3],
                              "block": "", "handle": s.get("handle", "")})
            continue
        active.append(i)
    budget.spend(len(segments))

    # 1. End points into nodes: greedy against each node's first point.
    anchors: list = []  # (x, y) of each node's first point
    node_tol: list = []  # snap tolerance of each node (its first point's)
    node_scale: list = []  # sheet scale of each node (its first point's)
    members: list = []  # [[x, y, count]] running sums per node
    incident: list = []  # [(segment, end 0|1)] per node
    snap = _Grid(tol_max, budget)
    ends: dict = {}  # per active segment (n1, n2)
    for i in active:
        s = segments[i]
        pair = []
        for k, (x, y) in enumerate(((s["x1"], s["y1"]), (s["x2"], s["y2"]))):
            best, best_d = None, None
            for n in snap.near(x, y):
                d = math.hypot(x - anchors[n][0], y - anchors[n][1])
                if d <= min(tols[i], node_tol[n]) and (
                        best_d is None or d < best_d or (d == best_d and n < best)):
                    best, best_d = n, d
            if best is None:
                best = len(anchors)
                anchors.append((x, y))
                node_tol.append(tols[i])
                node_scale.append(scale[i])
                members.append([0.0, 0.0, 0])
                incident.append([])
                snap.add_point(x, y, best)
            m = members[best]
            m[0] += x
            m[1] += y
            m[2] += 1
            incident[best].append((i, k))
            pair.append(best)
        ends[i] = tuple(pair)
    pos = [(m[0] / m[2], m[1] / m[2]) for m in members]

    # 2. Tees on a segment's interior: an end node within tol of a straight
    #    segment it is not an end of splits that segment there.
    cell = max(diag / 256.0, 4.0 * tol_max, 1e-9)
    seg_grid = _Grid(cell, budget, dense)
    geo: dict = {}  # straight segment -> (x1, y1, dx, dy, length^2, length)
    for i in active:
        s = segments[i]
        if not s.get("curved"):
            seg_grid.add_segment(s["x1"], s["y1"], s["x2"], s["y2"], i)
            dx, dy = s["x2"] - s["x1"], s["y2"] - s["y1"]
            den = dx * dx + dy * dy
            geo[i] = (s["x1"], s["y1"], dx, dy, den, math.sqrt(den))
    splits: dict = {}
    hypot = math.hypot
    for n, (px, py) in enumerate(pos):
        nt = node_tol[n]
        for i in seg_grid.near(px, py):
            if n in ends[i]:
                continue
            x1, y1, dx, dy, den, run_len = geo[i]
            t = 0.0 if den == 0 else ((px - x1) * dx + (py - y1) * dy) / den
            t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
            reach = tols[i] if tols[i] < nt else nt
            if (t * run_len > reach and (1.0 - t) * run_len > reach
                    and hypot(px - (x1 + t * dx), py - (y1 + t * dy)) <= reach):
                splits.setdefault(i, []).append((t, n))

    # 2b. A broken-line crossing: a line drawn with a gap where it passes
    #     over another has two ends just off the other line, one each side,
    #     facing each other. That is NOT two tees: the other line is not
    #     split, and the two ends are one node (the line goes on).
    merge = _Union()
    for i, cands in list(splits.items()):
        if len(cands) < 2 and not any(len(incident[n]) > 1 for _t, n in cands):
            continue
        s = segments[i]
        gapped = _crossing_gap_nodes(s, cands, incident, segments, min(tols[i], tol_max), budget)
        if not gapped:
            continue
        kept = [(t, n) for t, n in cands if n not in gapped]
        if kept:
            splits[i] = kept
        else:
            del splits[i]
        for group in gapped.values():
            for n in group[1:]:
                merge.join(group[0], n)
    if merge.parent:
        canon = {}
        for n in list(merge.parent):
            root = merge.find(n)
            if root != n:
                canon[n] = root
        for n, root in canon.items():
            m, r = members[n], members[root]
            r[0] += m[0]
            r[1] += m[1]
            r[2] += m[2]
            m[2] = 0
        for n, root in canon.items():
            pos[root] = (members[root][0] / members[root][2], members[root][1] / members[root][2])
        for i in active:
            a, b = ends[i]
            ends[i] = (canon.get(a, a), canon.get(b, b))
        for i, cands in splits.items():
            splits[i] = [(t, canon.get(n, n)) for t, n in cands]

    # 3. Pieces between consecutive nodes along each segment.
    pieces: list = []
    degree = [0] * len(pos)
    # The same straight line drawn twice over is one connection, not two:
    # a duplicate keeps its row but adds no degree.
    seen_pairs = set()
    for i in active:
        s = segments[i]
        n1, n2 = ends[i]
        chain = [(0.0, n1)] + sorted(splits.get(i, [])) + [(1.0, n2)]
        for (ta, na), (tb, nb) in zip(chain, chain[1:]):
            length = s["length"] * (tb - ta)
            if na == nb and length <= tols[i]:
                continue  # shorter than the tolerance: no geometry left
            xa = s["x1"] + (s["x2"] - s["x1"]) * ta
            ya = s["y1"] + (s["y2"] - s["y1"]) * ta
            xb = s["x1"] + (s["x2"] - s["x1"]) * tb
            yb = s["y1"] + (s["y2"] - s["y1"]) * tb
            pair = (min(na, nb), max(na, nb))
            duplicate = not s.get("curved") and pair in seen_pairs
            if not s.get("curved"):
                seen_pairs.add(pair)
            pieces.append(
                {"seg": i, "x1": xa, "y1": ya, "x2": xb, "y2": yb,
                 "length": length, "n1": na, "n2": nb, "run": None, "duplicate": duplicate}
            )
            if not duplicate:
                degree[na] += 1
                degree[nb] += 1
    budget.spend(len(pieces))

    # 4. Block bridges: degree-1 nodes inside a small insert's box. "Small"
    #    is against the node's own sheet.
    box_grid = _Grid(cell, budget)
    limit_max = BLOCK_MAX_REL * max(scale, default=0.0)
    sizes = []
    for b, box in enumerate(boxes):
        size = math.hypot(box["maxx"] - box["minx"], box["maxy"] - box["miny"])
        sizes.append(size)
        if 0 < size <= limit_max:
            box_grid.add_box(box["minx"] - tol_max, box["miny"] - tol_max,
                             box["maxx"] + tol_max, box["maxy"] + tol_max, b)
    touched: dict = {}  # box index -> [node]
    node_boxes: dict = {}  # node -> [box index]
    for n, (px, py) in enumerate(pos):
        if degree[n] != 1:
            continue
        reach = node_tol[n]
        limit = BLOCK_MAX_REL * node_scale[n]
        for b in box_grid.near(px, py):
            box = boxes[b]
            if (sizes[b] <= limit
                    and box["minx"] - reach <= px <= box["maxx"] + reach
                    and box["miny"] - reach <= py <= box["maxy"] + reach):
                touched.setdefault(b, []).append(n)
                node_boxes.setdefault(n, []).append(b)
    bridges = [touched[b] for b in sorted(touched) if len(touched[b]) >= 2]
    bridged = {n for group in bridges for n in group}

    def area(b):
        box = boxes[b]
        return (box["maxx"] - box["minx"]) * (box["maxy"] - box["miny"])

    nodes = []
    for n, (px, py) in enumerate(pos):
        cands = node_boxes.get(n, [])
        # Prefer the box that bridges, then the smallest (the valve, not the
        # instrument loop drawn around it).
        cands = sorted(cands, key=lambda b: (len(touched[b]) < 2, area(b), b))
        d = degree[n]
        kind = "end" if d <= 1 else ("joint" if d == 2 else "tee")
        if n in bridged:
            kind = "block"
        nodes.append(
            {"x": px, "y": py, "degree": d, "kind": kind,
             "block": cands[0] if cands else None, "bridged": n in bridged,
             "tol": node_tol[n], "scale": node_scale[n]}
        )

    # 5. Runs: connected pieces, through bridges.
    uf = _Union()
    for p in pieces:
        uf.join(p["n1"], p["n2"])
    for group in bridges:
        for n in group[1:]:
            uf.join(group[0], n)
    run_of: dict = {}
    for p in pieces:
        root = uf.find(p["n1"])
        if root not in run_of:
            run_of[root] = len(run_of) + 1
        p["run"] = run_of[root]
    return {
        "tol": tol_max,
        "diag": diag,
        "sheets": sheets,
        "scale": scale,
        "nodes": nodes,
        "pieces": pieces,
        "bridges": bridges,
        "boxes": boxes,
        "symbols": len(symbol_box),
        "runs": len(run_of),
    }


def _crossing_gap_nodes(s: dict, cands: list, incident: list, segments: list, tol: float,
                        budget: _Budget) -> dict:
    """Of the end nodes `cands` ([(t, node)]) that would split straight
    segment `s`, the ones that are a broken-line crossing: {node: [nodes of
    its pair]}. A pair is two straight segment ends on opposite sides of s,
    each clearly off it (more than GAP_MIN_REL x tol), the two segments
    leaving s across it (at 20 degrees or more), antiparallel, and on one
    line. A node counts only when every segment end at it is in such a
    pair. The pair loop is quadratic in the segment ends at the split
    points (many lines fanning out of one header): it spends every pair
    from the budget before it starts and checks the clock as it goes."""
    sx, sy = s["x2"] - s["x1"], s["y2"] - s["y1"]
    slen = math.hypot(sx, sy)
    if slen == 0:
        return {}
    ux, uy = sx / slen, sy / slen
    off = []  # (node, segment, side distance, px, py, dx, dy)
    for _t, n in cands:
        for j, k in incident[n]:
            o = segments[j]
            if o.get("curved"):
                continue
            px, py = (o["x1"], o["y1"]) if k == 0 else (o["x2"], o["y2"])
            qx, qy = (o["x2"], o["y2"]) if k == 0 else (o["x1"], o["y1"])
            dl = math.hypot(qx - px, qy - py)
            if dl == 0:
                continue
            side = ux * (py - s["y1"]) - uy * (px - s["x1"])
            off.append((n, j, side, px, py, (qx - px) / dl, (qy - py) / dl))
    budget.spend(len(off) * (len(off) - 1) // 2 + 1)
    paired: dict = {}  # (node, segment) -> partner node
    for a in range(len(off)):
        if not a & 63:
            budget.check_clock()
        na, ja, sa, pax, pay, dax, day = off[a]
        for b in range(a + 1, len(off)):
            nb, jb, sb, pbx, pby, dbx, dby = off[b]
            if ja == jb or sa * sb >= 0:
                continue
            if min(abs(sa), abs(sb)) <= GAP_MIN_REL * tol:
                continue
            # Each leaves s on its own side, across it (not along it), the
            # two point opposite ways...
            if (ux * day - uy * dax) * (1 if sa > 0 else -1) < GAP_SIN:
                continue
            if (ux * dby - uy * dbx) * (1 if sb > 0 else -1) < GAP_SIN:
                continue
            if dax * dbx + day * dby > -GAP_COS:
                continue
            # ...and they are one line: b's end sits on a's line.
            if abs(dax * (pby - pay) - day * (pbx - pax)) > tol:
                continue
            paired[(na, ja)] = nb
            paired[(nb, jb)] = na
    out: dict = {}
    for _t, n in cands:
        if n in out or not incident[n]:
            continue
        mates = [paired.get((n, j)) for j, _k in incident[n]]
        if all(m is not None for m in mates):
            out[n] = [n] + sorted({m for m in mates if m != n})
    # Both ends of a pair must qualify: a real tee on one side keeps both.
    while True:
        drop = [n for n, group in out.items() if any(m not in out for m in group[1:])]
        if not drop:
            return out
        for n in drop:
            del out[n]


# ── circuits (pure) ──────────────────────────────────────────────────────


def parse_circuit_layer(layer: str):
    """(circuit, role, sub, parent) for a `Circuit <name>` layer, else None.
    role is "main" or "deadleg"; an injection point is its own circuit with
    `parent` set, and its deadlegs (`X-IP1-DL`) carry the same parent. The
    root name (the circuit, or an injection point's parent) must have the
    circuit-name shape (_CIRCUIT_NAME). See the module docstring for the
    suffix table."""
    m = _CIRCUIT_LAYER.match(layer or "")
    if not m:
        return None
    name, role, sub = m.group(1), "main", ""
    mm = _DEADLEG_SUFFIX.match(name)
    if mm:
        name, role, sub = mm.group("base"), "deadleg", mm.group("sub").upper()
    else:
        mm = _BRANCH_SUFFIX.match(name)
        if mm:
            name, sub = mm.group("base"), mm.group("sub").upper()
    parent = ""
    mm = _IP_SUFFIX.match(name)
    if mm:
        parent = mm.group("base")
        sub = sub or mm.group("sub").upper()
    if not _CIRCUIT_NAME.match(parent or name) or not _CIRCUIT_NAME.match(name):
        return None
    return (name, role, sub, parent)


def circuit_key(value: str) -> str:
    """The circuit a CIRCUIT attribute value names, lower case, for matching
    against layer groups: "Circuit X-DL", "X-DL" and "x" all give "x"."""
    text = " ".join(str(value or "").split())
    parsed = parse_circuit_layer(text) or parse_circuit_layer("Circuit " + text)
    return (parsed[0] if parsed else text).lower()


def _norm(text: str) -> str:
    return " ".join(str(text or "").split()).lower()


def _capped_join(items: list, limit: int) -> str:
    out, spent = [], 0
    for i, item in enumerate(items):
        if spent + len(item) + 2 > limit:
            out.append(f"+{len(items) - i} more")
            break
        out.append(item)
        spent += len(item) + 2
    return "; ".join(out)


def circuit_rows(segments: list, net: dict, texts: list | None = None,
                 blocks: list | None = None, boxes: list | None = None,
                 near: float | None = None, budget: _Budget | None = None) -> list:
    """One row per circuit from `Circuit <name>` layers; [] when there are
    none. `segments` carry `layer` (and `handle`); `net` is
    build_network's result over the same list; `texts` are registry texts
    ({text, layer, x, y}); `blocks` are registry attribute blocks ({block,
    handle, x, y, attribs}); `boxes` the boxes for naming the block at an
    end (default: the network's own, symbols included). `near` overrides
    the per-sheet near distance (NEAR_REL x the sheet scale). Pure.

    A straight piece drawn twice over (same two nodes) counts once per
    circuit, as in the Nodes tab. A line-number block that names a circuit
    in a CIRCUIT attribute belongs to that circuit only, wherever it sits
    (and to none here when that circuit is not on this drawing); one with
    no circuit named counts on every circuit whose runs it is near."""
    budget = budget or _Budget()
    texts = texts or []
    blocks = blocks or []
    boxes = net.get("boxes", boxes or []) if boxes is None else boxes
    scale = net.get("scale") or [net["diag"]] * len(segments)

    def near_of(seg_index: int) -> float:
        if near is not None:
            return near
        return max(scale[seg_index] * NEAR_REL, net["tol"])

    groups: dict = {}
    for p_index, p in enumerate(net["pieces"]):
        seg = segments[p["seg"]]
        parsed = parse_circuit_layer(seg.get("layer", ""))
        if parsed is None:
            continue
        name, role, _sub, parent = parsed
        g = groups.setdefault(
            name.lower(),
            {"name": name, "parent": parent, "layers": [], "main": [], "deadleg": [],
             "handles": set(), "pairs": set()},
        )
        # A deadleg layer read first must not leave its circuit parentless.
        if parent and not g["parent"]:
            g["parent"] = parent
        if seg.get("layer") not in g["layers"]:
            g["layers"].append(seg.get("layer"))
        if not segments[p["seg"]].get("curved"):
            pair = (min(p["n1"], p["n2"]), max(p["n1"], p["n2"]))
            if pair in g["pairs"]:
                continue  # drawn twice over: one connection
            g["pairs"].add(pair)
        g[role].append(p_index)
        if role == "main":
            g["handles"].add(seg.get("handle", ""))
    if not groups:
        return []

    # Labels near each circuit: one grid over every circuit piece.
    keys = sorted(groups)
    reach = max((near_of(net["pieces"][i]["seg"]) for k in keys
                 for i in groups[k]["main"] + groups[k]["deadleg"]), default=1e-9)
    grid = _Grid(max(4.0 * reach, 1e-9), budget)
    for gi, key in enumerate(keys):
        g = groups[key]
        for p_index in g["main"] + g["deadleg"]:
            p = net["pieces"][p_index]
            grid.add_segment(p["x1"], p["y1"], p["x2"], p["y2"], (gi, p_index))

    # Per cell, the pieces grouped by circuit: a label stops looking at a
    # circuit as soon as it is near one of its pieces.
    by_cell: dict = {}
    for k, items in grid.cells.items():
        cell_groups: dict = {}
        for gi, p_index in items:
            cell_groups.setdefault(gi, []).append(p_index)
        by_cell[k] = cell_groups
    far: dict = {}
    for gi, p_index in grid.long:
        far.setdefault(gi, []).append(p_index)
    pieces_all = net["pieces"]
    piece_near = [near_of(p["seg"]) for p in pieces_all]
    # The centre cell first: most labels are near a piece in their own.
    around = [(0, 0)] + [(dx, dy) for dx in (-1, 0, 1) for dy in (-1, 0, 1) if dx or dy]

    def near_groups(x, y) -> set:
        hit = set()
        if not _finite(x, y):
            return hit
        kx, ky = grid._key(x, y)
        lists = [by_cell.get((kx + dx, ky + dy)) for dx, dy in around]
        for cell_groups in [c for c in lists if c] + ([far] if far else []):
            for gi, p_list in cell_groups.items():
                if gi in hit:
                    continue
                budget.spend(len(p_list))
                for p_index in p_list:
                    p = pieces_all[p_index]
                    if _point_segment(x, y, p["x1"], p["y1"], p["x2"], p["y2"])[0] <= piece_near[p_index]:
                        hit.add(gi)
                        break
        return hit

    nearby_text = {gi: [] for gi in range(len(keys))}
    nearby_seen = {gi: set() for gi in range(len(keys))}
    for t in texts:
        if not t.get("text"):
            continue
        for gi in near_groups(t.get("x"), t.get("y")):
            if t["text"] not in nearby_seen[gi]:
                nearby_seen[gi].add(t["text"])
                nearby_text[gi].append(t["text"])
    line_numbers = {gi: [] for gi in range(len(keys))}
    by_name = {key: gi for gi, key in enumerate(keys)}
    for b in blocks:
        attribs = b.get("attribs") or {}
        number = next((v for k, v in attribs.items() if _LINE_TAG.match(k) and v), "")
        if not number:
            continue
        named = [v for k, v in attribs.items() if _CIRCUIT_TAG.match(k) and str(v or "").strip()]
        if named:
            hits = {by_name[circuit_key(v)] for v in named if circuit_key(v) in by_name}
        else:
            hits = near_groups(b.get("x"), b.get("y"))
        label = f"{number} [{b.get('handle', '')}]"
        for gi in hits:
            if label not in line_numbers[gi]:
                line_numbers[gi].append(label)

    pieces, nodes = net["pieces"], net["nodes"]
    layers_at: dict = {}
    for p in pieces:
        for n in (p["n1"], p["n2"]):
            layers_at.setdefault(n, set()).add(segments[p["seg"]].get("layer", ""))
    bridge_of = {}
    for group in net["bridges"]:
        for n in group:
            bridge_of[n] = group
    rows = []
    for gi, key in enumerate(keys):
        g = groups[key]
        own = g["main"] + g["deadleg"]
        incidence: dict = {}
        for p_index in own:
            p = pieces[p_index]
            incidence[p["n1"]] = incidence.get(p["n1"], 0) + 1
            incidence[p["n2"]] = incidence.get(p["n2"], 0) + 1
        uf = _Union()
        for p_index in own:
            uf.join(pieces[p_index]["n1"], pieces[p_index]["n2"])
        inside_bridge = set()
        for n in incidence:
            mates = [m for m in bridge_of.get(n, []) if m != n and m in incidence]
            for m in mates:
                uf.join(n, m)
            if mates:
                inside_bridge.add(n)
        runs = {uf.find(pieces[p_index]["n1"]) for p_index in own}
        tees = sum(1 for n, c in incidence.items() if c >= 3)
        end_nodes = sorted(n for n, c in incidence.items() if c == 1 and n not in inside_bridge)
        own_layers = set(g["layers"])
        end_texts = []
        for n in end_nodes[:MAX_CIRCUIT_ENDS]:
            node = nodes[n]
            where = f"#{n + 1} ({coord(node['x'])}, {coord(node['y'])})"
            others = sorted(layers_at.get(n, set()) - own_layers) if node["degree"] > 1 else []
            if others:
                end_texts.append(f"{where} meets {', '.join(others[:3])}")
            elif node["block"] is not None and node["block"] < len(boxes):
                box = boxes[node["block"]]
                end_texts.append(f"{where} at block {box.get('block', '')} [{box.get('handle', '')}]")
            else:
                end_texts.append(f"{where} open")
        if len(end_nodes) > MAX_CIRCUIT_ENDS:
            end_texts.append(f"+{len(end_nodes) - MAX_CIRCUIT_ENDS} more")
        rows.append(
            {
                "circuit": g["name"],
                "parent": g["parent"],
                "kind": "injection point" if g["parent"] else "circuit",
                "layers": "; ".join(g["layers"]),
                "entities": len(g["handles"]),
                "segments": len(g["main"]),
                "length": coord(sum(pieces[i]["length"] for i in g["main"])),
                "deadleg_segments": len(g["deadleg"]),
                "deadleg_length": coord(sum(pieces[i]["length"] for i in g["deadleg"])),
                "runs": len(runs),
                "tees": tees,
                "ends": len(end_nodes),
                "end_points": "; ".join(end_texts),
                "line_numbers": _capped_join(line_numbers[gi], MAX_CIRCUIT_LIST_CHARS),
                "nearby_text": _capped_join(nearby_text[gi], MAX_CIRCUIT_LIST_CHARS),
            }
        )
    return rows


# ── the reply (caps) ─────────────────────────────────────────────────────


def _take(rows: list, budget: int):
    """Rows that fit `budget` characters of JSON, and whether any were cut."""
    out, spent = [], 0
    for row in rows:
        size = len(json.dumps(row)) + 1
        if spent + size > budget:
            return out, True
        out.append(row)
        spent += size
    return out, False


def geometry_index(segments: list, inserts: list, texts: list, blocks: list,
                   skipped: dict | None = None, budget: _Budget | None = None) -> dict:
    """The reply fields for the bones tabs, from the raw segment dicts
    (layer, handle, type, part, x1 y1 x2 y2, length, curved, span) and
    insert dicts (insert_record) gathered in the registry loop. Every list
    is cut by its character budget with its own cap bit. Raises
    GeometryBudgetExceeded past the work budget and ValueError when a
    number in the reply would not be finite: the caller reports either as
    geometry_error and keeps the registry."""
    budget = budget or _Budget()
    boxes = []
    for ins in inserts:
        if ins.get("box") is not None:
            minx, miny, maxx, maxy = ins["box"]
            boxes.append({"minx": minx, "miny": miny, "maxx": maxx, "maxy": maxy,
                          "block": ins["block"], "handle": ins["handle"]})
    net = build_network(segments, boxes, budget=budget)
    boxes = net["boxes"]
    near_max = max(net["diag"] * NEAR_REL if net["sheets"] <= 1 else
                   max(net["scale"], default=0.0) * NEAR_REL, net["tol"])
    if not (math.isfinite(net["tol"]) and math.isfinite(near_max) and math.isfinite(net["diag"])):
        raise ValueError("the drawing extent is not a finite number: geometry not built")

    seg_rows = []
    for p in net["pieces"]:
        s = segments[p["seg"]]
        seg_rows.append(
            {"layer": s.get("layer", ""), "handle": s.get("handle", ""), "type": s.get("type", ""),
             "part": s.get("part", 0), "x1": coord(p["x1"]), "y1": coord(p["y1"]),
             "x2": coord(p["x2"]), "y2": coord(p["y2"]), "length": coord(p["length"]),
             "n1": p["n1"] + 1, "n2": p["n2"] + 1, "run": p["run"]}
        )
    layers_at: dict = {}
    for p in net["pieces"]:
        layer = segments[p["seg"]].get("layer", "")
        for n in (p["n1"], p["n2"]):
            at = layers_at.setdefault(n, [])
            if layer not in at:
                at.append(layer)
    node_rows = []
    for n, node in enumerate(net["nodes"]):
        if node["degree"] == 0:
            continue
        box = boxes[node["block"]] if node["block"] is not None else None
        at = layers_at.get(n, [])
        node_rows.append(
            {"id": n + 1, "x": coord(node["x"]), "y": coord(node["y"]),
             "degree": node["degree"], "kind": node["kind"],
             "block": box["block"] if box else "", "block_handle": box["handle"] if box else "",
             "layers": "; ".join(at[:MAX_NODE_LAYERS]) + (" …" if len(at) > MAX_NODE_LAYERS else "")}
        )
    insert_rows = []
    for ins in inserts:
        box = ins.get("box") or (None, None, None, None)
        insert_rows.append(
            {"block": ins["block"], "layer": ins.get("layer", ""), "handle": ins["handle"],
             "x": coord(ins["x"]), "y": coord(ins["y"]), "rotation": coord(ins["rotation"], 2),
             "sx": coord(ins["sx"], 4), "sy": coord(ins["sy"], 4),
             "minx": coord(box[0]), "miny": coord(box[1]),
             "maxx": coord(box[2]), "maxy": coord(box[3]), "attribs": ins["attribs"]}
        )
    circuits = circuit_rows(segments, net, texts, blocks, boxes, budget=budget)

    segs_out, segs_capped = _take(seg_rows, MAX_SEGMENT_CHARS)
    nodes_out, nodes_capped = _take(node_rows, MAX_NODE_CHARS)
    inserts_out, inserts_capped = _take(insert_rows, MAX_INSERT_CHARS)
    circuits_out, circuits_capped = _take(circuits, MAX_CIRCUIT_CHARS)
    kinds: dict = {}
    for row in node_rows:
        kinds[row["kind"]] = kinds.get(row["kind"], 0) + 1
    skipped = dict(skipped or {})
    if net["symbols"]:
        skipped["small closed polyline"] = net["symbols"]
    return {
        "geometry": {
            # With several sheets these are the largest sheet's (see
            # sheet_scales); `sheets` says how many there are.
            "snap_tolerance": float(f"{net['tol']:.6g}"),
            "near_distance": float(f"{near_max:.6g}"),
            "extent_diagonal": coord(net["diag"]),
            "sheets": net["sheets"],
            "segments": len(seg_rows),
            "nodes": len(node_rows),
            "node_kinds": kinds,
            "inserts": len(insert_rows),
            "runs": net["runs"],
            "circuits": len(circuits),
            "skipped": skipped,
        },
        "segments": segs_out,
        "segments_capped": segs_capped,
        "nodes": nodes_out,
        "nodes_capped": nodes_capped,
        "inserts": inserts_out,
        "inserts_capped": inserts_capped,
        "circuits": circuits_out,
        "circuits_capped": circuits_capped,
    }
