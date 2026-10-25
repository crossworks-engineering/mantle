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
            POINTS are the chord: a curve is never split by a tee.
  inserts   every INSERT, with or without attributes: block name, layer,
            handle, insertion point, rotation, scale and an axis-aligned
            bounding box of the block's own geometry (text left out).
  nodes     segment end points snapped together within `tol`.
  circuits  per `Circuit <name>` layer group, when the drawing has any.

Network rules (decided 2026-10-25, phase 1):
  - Snap tolerance `tol` = SNAP_REL (2e-4) x the diagonal of the box that
    holds the middle 99% of segment end points. On an A1 sheet drawn 1:1 in
    millimetres (diagonal about 1,030) that is about 0.2 mm, under a pen
    width. The middle 99% keeps one stray entity far off the sheet from
    loosening the tolerance for everything else.
  - Two end points within `tol` are one node (greedy, in drawing order,
    against the node's first point, so a chain of near points cannot creep).
  - An end point that lies within `tol` of the INTERIOR of a straight
    segment splits that segment there: a branch drawn up to a header is a
    tee even though the header is one LINE. The split pieces are separate
    rows with the same handle and part.
  - Two segments that cross with no end point at the crossing are NOT
    joined, whatever the angle: on a P&ID that is a line passing over
    another.
  - Degree is the number of segment ends at a node: 1 = end, 2 = joint,
    3 or more = tee.
  - A block bridges pipe ends: every degree-1 node inside a small insert's
    box (expanded by `tol`) touches that block, and a block touched by two
    or more ends joins them (kind "block": a valve, a reducer, a spec
    break). A block touched by one end leaves it an end, with the block
    named (a cap, a nozzle, a continuation arrow). "Small" is a box diagonal
    of at most BLOCK_MAX_REL (5%) of the extent diagonal, so a border or
    title block around the whole sheet never bridges anything.
  - A run is a connected set of segments, through joints, tees and block
    bridges.

Circuits (the Circuitizer layer convention, `Circuit <name>`):
  - `Circuit X`            the main path of circuit X.
  - `Circuit X-DL`         a deadleg of X (counted on X's row).
  - `Circuit X-B01-DL`     a deadleg of X on branch B01 (on X's row).
  - `Circuit X-D03`        deadleg 03 of X (on X's row).
  - `Circuit X-IP1`        injection point 1 of X: its own row, Parent X,
                           Kind "injection point" (API 570 treats an
                           injection point as a circuit of its own).
  Any other suffix is part of the circuit name. A drawing with no
  `Circuit ` layer gets no circuits at all.
"""

from __future__ import annotations

import json
import math
import re

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
        bulges = [p[2] for p in e.get_points("xyb")]
        pairs = list(range(len(pts) - 1))
        if e.closed and len(pts) > 2:
            pairs.append(len(pts) - 1)
        for i in pairs:
            a, b = pts[i], pts[(i + 1) % len(pts)]
            chord = math.hypot(b[0] - a[0], b[1] - a[1])
            bulge = float(bulges[i] or 0.0) if i < len(bulges) else 0.0
            add(i, a, b, _arc_length(chord, bulge), bool(bulge))
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
        pairs = list(range(len(pts) - 1))
        if e.is_closed and len(pts) > 2:
            pairs.append(len(pts) - 1)
        for i in pairs:
            a, b = pts[i], pts[(i + 1) % len(pts)]
            chord = math.hypot(b[0] - a[0], b[1] - a[1])
            add(i, a, b, _arc_length(chord, bulges[i]), bool(bulges[i]))
    return out


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


# ── spatial index ────────────────────────────────────────────────────────


class _Grid:
    """A uniform hash grid. `near(x, y)` yields every item whose geometry
    may lie within cell/4 of the point (callers pick cell >= 4 x reach)."""

    MAX_SAMPLES = 4096

    def __init__(self, cell: float):
        self.cell = cell
        self.cells: dict = {}
        self.long: list = []  # too long to sample: checked on every query

    def _key(self, x: float, y: float):
        return (math.floor(x / self.cell), math.floor(y / self.cell))

    def add_point(self, x: float, y: float, item) -> None:
        self.cells.setdefault(self._key(x, y), []).append(item)

    def add_segment(self, x1, y1, x2, y2, item) -> None:
        # Samples every cell/2, so every point of the segment is within
        # cell/4 of a sample: a query point within cell/4 of the segment is
        # then within cell/2 of a sampled cell, one of its 3x3 neighbours.
        n = int(math.ceil(math.hypot(x2 - x1, y2 - y1) / (self.cell / 2.0)))
        if n > self.MAX_SAMPLES:
            self.long.append(item)
            return
        n = max(n, 1)
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
        if (kx1 - kx0 + 1) * (ky1 - ky0 + 1) > self.MAX_SAMPLES:
            self.long.append(item)
            return
        for kx in range(kx0, kx1 + 1):
            for ky in range(ky0, ky1 + 1):
                self.cells.setdefault((kx, ky), []).append(item)

    def near(self, x: float, y: float):
        kx, ky = self._key(x, y)
        seen = set()
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for item in self.cells.get((kx + dx, ky + dy), ()):
                    if item not in seen:
                        seen.add(item)
                        yield item
        for item in self.long:
            if item not in seen:
                seen.add(item)
                yield item


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


def extent_diagonal(segments: list) -> float:
    """Diagonal of the box holding the middle 99% of segment end points."""
    xs, ys = [], []
    for s in segments:
        xs += (s["x1"], s["x2"])
        ys += (s["y1"], s["y2"])
    if not xs:
        return 0.0
    xs.sort()
    ys.sort()
    lo = int(math.floor(EXTENT_TRIM * (len(xs) - 1)))
    hi = int(math.ceil((1.0 - EXTENT_TRIM) * (len(xs) - 1)))
    return math.hypot(xs[hi] - xs[lo], ys[hi] - ys[lo])


def build_network(segments: list, boxes: list | None = None, tol: float | None = None) -> dict:
    """Snap `segments` (dicts with x1 y1 x2 y2 length curved, plus anything
    else, passed through) into a network. `boxes` are insert boxes as dicts
    with minx miny maxx maxy (and anything else). Returns:
      tol, diag
      nodes   [{x, y, degree, kind, block (index into boxes or None),
                bridged (bool)}], index = node id - 1
      pieces  [{seg (index into segments), x1 y1 x2 y2 length, n1, n2, run}]
      bridges [[node index, ...] per bridging box]
      runs    number of runs
    Pure: no ezdxf, no I/O."""
    boxes = boxes or []
    diag = extent_diagonal(segments)
    if tol is None:
        tol = max(diag * SNAP_REL, 1e-9)
    cell = max(diag / 256.0, 4.0 * tol, 1e-9)

    # 1. End points into nodes: greedy against each node's first point.
    anchors: list = []  # (x, y) of each node's first point
    members: list = []  # [[x, y, count]] running sums per node
    snap = _Grid(tol)
    ends: list = []  # per segment (n1, n2)
    for s in segments:
        pair = []
        for x, y in ((s["x1"], s["y1"]), (s["x2"], s["y2"])):
            best, best_d = None, None
            for n in snap.near(x, y):
                d = math.hypot(x - anchors[n][0], y - anchors[n][1])
                if d <= tol and (best_d is None or d < best_d or (d == best_d and n < best)):
                    best, best_d = n, d
            if best is None:
                best = len(anchors)
                anchors.append((x, y))
                members.append([0.0, 0.0, 0])
                snap.add_point(x, y, best)
            m = members[best]
            m[0] += x
            m[1] += y
            m[2] += 1
            pair.append(best)
        ends.append(tuple(pair))
    pos = [(m[0] / m[2], m[1] / m[2]) for m in members]

    # 2. Tees on a segment's interior: an end node within tol of a straight
    #    segment it is not an end of splits that segment there.
    seg_grid = _Grid(cell)
    for i, s in enumerate(segments):
        if not s.get("curved"):
            seg_grid.add_segment(s["x1"], s["y1"], s["x2"], s["y2"], i)
    splits: dict = {}
    for n, (px, py) in enumerate(pos):
        for i in seg_grid.near(px, py):
            if n in ends[i]:
                continue
            s = segments[i]
            d, t = _point_segment(px, py, s["x1"], s["y1"], s["x2"], s["y2"])
            run_len = math.hypot(s["x2"] - s["x1"], s["y2"] - s["y1"])
            if d <= tol and t * run_len > tol and (1.0 - t) * run_len > tol:
                splits.setdefault(i, []).append((t, n))

    # 3. Pieces between consecutive nodes along each segment.
    pieces: list = []
    degree = [0] * len(pos)
    # The same straight line drawn twice over is one connection, not two:
    # a duplicate keeps its row but adds no degree.
    seen_pairs = set()
    for i, s in enumerate(segments):
        n1, n2 = ends[i]
        chain = [(0.0, n1)] + sorted(splits.get(i, [])) + [(1.0, n2)]
        for (ta, na), (tb, nb) in zip(chain, chain[1:]):
            length = s["length"] * (tb - ta)
            if na == nb and length <= tol:
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
                 "length": length, "n1": na, "n2": nb, "run": None}
            )
            if not duplicate:
                degree[na] += 1
                degree[nb] += 1

    # 4. Block bridges: degree-1 nodes inside a small insert's box.
    box_grid = _Grid(cell)
    limit = BLOCK_MAX_REL * diag
    for b, box in enumerate(boxes):
        size = math.hypot(box["maxx"] - box["minx"], box["maxy"] - box["miny"])
        if 0 < size <= limit:
            box_grid.add_box(box["minx"] - tol, box["miny"] - tol, box["maxx"] + tol, box["maxy"] + tol, b)
    touched: dict = {}  # box index -> [node]
    node_boxes: dict = {}  # node -> [box index]
    for n, (px, py) in enumerate(pos):
        if degree[n] != 1:
            continue
        for b in box_grid.near(px, py):
            box = boxes[b]
            if (box["minx"] - tol <= px <= box["maxx"] + tol
                    and box["miny"] - tol <= py <= box["maxy"] + tol):
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
             "block": cands[0] if cands else None, "bridged": n in bridged}
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
        "tol": tol,
        "diag": diag,
        "nodes": nodes,
        "pieces": pieces,
        "bridges": bridges,
        "runs": len(run_of),
    }


# ── circuits (pure) ──────────────────────────────────────────────────────


def parse_circuit_layer(layer: str):
    """(circuit, role, sub, parent) for a `Circuit <name>` layer, else None.
    role is "main" or "deadleg"; an injection point is its own circuit
    (role "main") with `parent` set. See the module docstring for the
    suffix table."""
    m = _CIRCUIT_LAYER.match(layer or "")
    if not m:
        return None
    name = m.group(1)
    for pattern, role in (
        (r"^(?P<base>.+?)-(?P<sub>B\d+-DL)$", "deadleg"),
        (r"^(?P<base>.+?)-(?P<sub>DL)$", "deadleg"),
        (r"^(?P<base>.+?)-(?P<sub>D\d+)$", "deadleg"),
    ):
        mm = re.match(pattern, name, re.I)
        if mm:
            return (mm.group("base"), role, mm.group("sub").upper(), "")
    mm = re.match(r"^(?P<base>.+?)-(?P<sub>IP\d*)$", name, re.I)
    if mm:
        return (name, "main", mm.group("sub").upper(), mm.group("base"))
    return (name, "main", "", "")


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
                 near: float | None = None) -> list:
    """One row per circuit from `Circuit <name>` layers; [] when there are
    none. `segments` carry `layer` (and `handle`); `net` is
    build_network's result over the same list; `texts` are registry texts
    ({text, layer, x, y}); `blocks` are registry attribute blocks ({block,
    handle, x, y, attribs}); `boxes` the insert boxes passed to the network
    (for naming the block at an end). Pure."""
    texts = texts or []
    blocks = blocks or []
    boxes = boxes or []
    if near is None:
        near = max(net["diag"] * NEAR_REL, net["tol"])
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
             "handles": set()},
        )
        if seg.get("layer") not in g["layers"]:
            g["layers"].append(seg.get("layer"))
        g[role].append(p_index)
        if role == "main":
            g["handles"].add(seg.get("handle", ""))
    if not groups:
        return []

    # Labels near each circuit: one grid over every circuit piece.
    keys = sorted(groups)
    grid = _Grid(max(4.0 * near, 1e-9))
    for gi, key in enumerate(keys):
        g = groups[key]
        for p_index in g["main"] + g["deadleg"]:
            p = net["pieces"][p_index]
            grid.add_segment(p["x1"], p["y1"], p["x2"], p["y2"], (gi, p_index))

    def near_groups(x, y) -> set:
        hit = set()
        if not _finite(x, y):
            return hit
        for gi, p_index in grid.near(x, y):
            if gi in hit:
                continue
            p = net["pieces"][p_index]
            if _point_segment(x, y, p["x1"], p["y1"], p["x2"], p["y2"])[0] <= near:
                hit.add(gi)
        return hit

    nearby_text = {gi: [] for gi in range(len(keys))}
    for t in texts:
        for gi in near_groups(t.get("x"), t.get("y")):
            if t.get("text") and t["text"] not in nearby_text[gi]:
                nearby_text[gi].append(t["text"])
    line_numbers = {gi: [] for gi in range(len(keys))}
    by_name = {}
    for gi, key in enumerate(keys):
        by_name[_norm(groups[key]["name"])] = gi
        by_name[_norm("Circuit " + groups[key]["name"])] = gi
    for b in blocks:
        attribs = b.get("attribs") or {}
        number = next((v for k, v in attribs.items() if _LINE_TAG.match(k) and v), "")
        if not number:
            continue
        # A block that names its circuit belongs to it wherever it sits;
        # otherwise a line-number block counts when it is near the runs.
        named = {by_name[_norm(v)] for k, v in attribs.items()
                 if _CIRCUIT_TAG.match(k) and _norm(v) in by_name}
        hits = named | near_groups(b.get("x"), b.get("y"))
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
                   skipped: dict | None = None) -> dict:
    """The reply fields for the bones tabs, from the raw segment dicts
    (layer, handle, type, part, x1 y1 x2 y2, length, curved) and insert
    dicts (insert_record) gathered in the registry loop. Every list is cut
    by its character budget with its own cap bit."""
    boxes = []
    for ins in inserts:
        if ins.get("box") is not None:
            minx, miny, maxx, maxy = ins["box"]
            boxes.append({"minx": minx, "miny": miny, "maxx": maxx, "maxy": maxy,
                          "block": ins["block"], "handle": ins["handle"]})
    net = build_network(segments, boxes)

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
    circuits = circuit_rows(segments, net, texts, blocks, boxes)

    segs_out, segs_capped = _take(seg_rows, MAX_SEGMENT_CHARS)
    nodes_out, nodes_capped = _take(node_rows, MAX_NODE_CHARS)
    inserts_out, inserts_capped = _take(insert_rows, MAX_INSERT_CHARS)
    circuits_out, circuits_capped = _take(circuits, MAX_CIRCUIT_CHARS)
    kinds: dict = {}
    for row in node_rows:
        kinds[row["kind"]] = kinds.get(row["kind"], 0) + 1
    return {
        "geometry": {
            "snap_tolerance": float(f"{net['tol']:.6g}"),
            "near_distance": float(f"{max(net['diag'] * NEAR_REL, net['tol']):.6g}"),
            "extent_diagonal": coord(net["diag"]),
            "segments": len(seg_rows),
            "nodes": len(node_rows),
            "node_kinds": kinds,
            "inserts": len(insert_rows),
            "runs": net["runs"],
            "circuits": len(circuits),
            "skipped": dict(skipped or {}),
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
