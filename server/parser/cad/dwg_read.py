"""AutoCAD DWG into ONE in-memory ezdxf document, built from the rows of
ezdwg's reader (MIT, Rust core, clean room). The registry, the bones, the
picture and the crops read the document this module returns, as for a DXF or
a DGN. ezdwg's own DXF export is not used: it loses text the reader has.
Nothing is written: the document lives in memory.

The reader is our ezdwg build (Dockerfile, `ezdwg-build`): upstream's reader
with the fixes for attributes it dropped, R2004 class names, WIPEOUT,
MULTILEADER and the saved picture of an entity. ONE check says it is there
(`reads_dwg`: does `ezdwg.raw` have `decode_entity_proxy_graphics`, the last
of those functions). Without it the result would be knowingly incomplete,
so every DWG is refused, and the parser's health says `ezdwg_reader
missing`.

DWG rows map almost one to one to DXF entities:
  LINE, POINT, CIRCLE, ARC,   -> the same entity
  ELLIPSE, SOLID, TRACE,
  3DFACE, LEADER, SPLINE,
  LWPOLYLINE
  HATCH                       -> HATCH with polyline paths; a pattern keeps
                                 the file's own pattern lines as stored (else
                                 the named pattern at the file's scale and
                                 angle); island style 0 ("normal"), as the
                                 reader does not give it
  POLYLINE_2D, POLYLINE_3D    -> POLYLINE, with its curve-fit or spline-fit
                                 kind and each vertex's kind (a spline's
                                 control points stay its frame);
                                 POLYLINE_PFACE -> a polyface
  TEXT, MTEXT, ATTDEF         -> the same; MTEXT keeps its raw text (with
                                 its format codes), as a DXF holds it, and
                                 its line spacing and flow. The reader gives
                                 no MTEXT column data: a text in columns is
                                 one column here
  INSERT, MINSERT             -> INSERT of the block named BY HANDLE, not by
                                 name. Blocks stay blocks: nothing is
                                 expanded, so no expansion cap is needed
  ATTRIB                      -> an attribute ON its INSERT (a second pass,
                                 by the attribute's owner), hidden or not as
                                 stored
  DIMENSION                   -> DIMENSION with its drawn block as geometry.
                                 One whose drawn block is not in the file is
                                 kept with no geometry (it draws nothing, as
                                 on the old road) and counted
  MULTILEADER                 -> MULTILEADER from the row (leaders, lines,
                                 points, text or block label, the block's
                                 attribute texts), with the saved picture of
                                 its record as `proxy_graphic`: ezdxf draws
                                 that picture when it is there, as it did
                                 on the old road. A record with no
                                 picture is drawn by ezdxf's own engine and
                                 counted. All pictures of a file come from
                                 one call
  WIPEOUT                     -> WIPEOUT (a mask) with its frame and boundary
Blocks: an anonymous block (the DWG stores "*U" with no number) gets a new
unique name, and a second block with a name already used is renamed; an
INSERT is linked by handle, so neither changes what it shows. A dynamic
block keeps its anonymous name: its true name is in the block's extended
data, which the reader does not return (the old road showed the anonymous
name too). Paper spaces become layouts; the registry reads model space only.

Never a silent loss. Every entity object the file lists (the reader's
object inventory) is converted, or counted in `not_converted` by type and
reason: no decoder in ezdwg, no converter here, a number that is not finite
or past WILD, an owner that is not known, and so on. `gap` compares the
total with the inventory. A file whose inventory cannot be read, or whose
inventory lists entity objects of which the reader decoded none, is refused
(DwgRefused), never returned as an empty document.

What bounds the work on a hostile file: ezdwg's own limits as it reads (each
count is checked against the bits left in its record before memory is
reserved), one entity a row and one pass a table here (no expansion: the
work is linear in what the reader returns), and the parser child's time
limit and the container's memory limit as the backstop. The saved pictures
of a file are at most the sum of their records' sizes, part of the object
data the reader already holds. A block that inserts itself, directly or
through others, is cut (the INSERT that closes the cycle is removed and
counted), so nothing downstream walks a block cycle. The child reads one
file and exits, so ezdwg's per-file caches go with the process.
"""

from __future__ import annotations

import math
import re
from collections import Counter

# A coordinate, size or angle past this is a damaged value, not a drawing.
WILD = 1e12
# Reader rows that are structure, not drawn entities.
STRUCTURAL = frozenset(
    {
        "VERTEX",
        "VERTEX_2D",
        "VERTEX_3D",
        "VERTEX_MESH",
        "VERTEX_PFACE",
        "VERTEX_PFACE_FACE",
        "SEQEND",
        "BLOCK",
        "ENDBLK",
    }
)
LINEWEIGHTS = frozenset(
    {-3, -2, -1, 0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211}
)
DIMTYPES = {"LINEAR": 0, "ALIGNED": 1, "ANG2LN": 2, "DIAMETER": 3, "RADIUS": 4, "ANG3PT": 5, "ORDINATE": 6}
# The reader function only our build has; the capability check reads it.
READER_FUNCTION = "decode_entity_proxy_graphics"
_DWG_MAGIC = re.compile(rb"^AC1\d{3}$")


class DwgRefused(Exception):
    """The file is not converted; the text says why (no path in it)."""


class Skip(Exception):
    """One entity is not converted; the text is the fixed reason."""


def is_dwg(head: bytes) -> bool:
    """True for DWG magic (AC1xxx) in the first six bytes."""
    return bool(_DWG_MAGIC.match(head[:6]))


def reads_dwg(ezdwg) -> bool:
    """The one capability rule: this ezdwg is our build (see the module text)."""
    return callable(getattr(getattr(ezdwg, "raw", None), READER_FUNCTION, None))


def reader_state() -> str:
    """For the parser's health: `ok`, or `missing` (DWG files are refused)."""
    try:
        import ezdwg  # noqa: PLC0415 - child-only import
    except Exception:
        return "missing"
    return "ok" if reads_dwg(ezdwg) else "missing"


def read(src: str):
    """`src` as (ezdxf document, notes). Raises DwgRefused, or the reader's
    own error for a file it cannot open."""
    import ezdwg  # noqa: PLC0415 - child-only import

    if not reads_dwg(ezdwg):
        raise DwgRefused("this ezdwg has no full reader (the parser image needs our ezdwg build)")
    return build_document(ezdwg.read(src))


def _num(v) -> float:
    v = float(v)
    if not math.isfinite(v) or abs(v) > WILD:
        raise Skip("a number is not finite or is wild")
    return v


def _p3(p) -> tuple:
    if p is None:
        raise Skip("a point is missing")
    return (_num(p[0]), _num(p[1]), _num(p[2]) if len(p) > 2 else 0.0)


def _raw_color(color) -> int:
    """A reader colour (index, value) as ezdxf takes a DXF 32-bit colour: a
    signed number. Before R2004 there is the index only."""
    index, value = int(color[0]), int(color[1])
    if not value:
        value = 0xC0000000 if index == 256 else (0xC1000000 if index == 0 else 0xC3000000 | (index & 0xFF))
    return value - (1 << 32) if value >= 1 << 31 else value


class _Build:
    """One document from one reader document `d`. `run()` returns it."""

    def __init__(self, d):
        import ezdxf  # noqa: PLC0415 - child-only import

        self.d = d
        self.path = d.decode_path or d.path
        self.raw = d.raw
        self.doc = ezdxf.new("R2010")
        self.msp = self.doc.modelspace()
        self.converted: Counter = Counter()
        self.skipped: Counter = Counter()
        self.facts: Counter = Counter()
        self.kept: Counter = Counter()
        self.inventory_rows: list = []
        self.lt_names: set = set()
        self.lt_by_handle: dict = {}
        self.style_by_handle: dict = {}
        self.layer_by_handle: dict = {}
        self.space_by_handle: dict = {}
        self.block_name_by_handle: dict = {}
        self.name_to_handles: dict = {}
        self.place: dict = {}
        self.insert_block: dict = {}
        self.made_inserts: dict = {}
        self.pictures: dict | None = None

    # ── tables ──

    def header(self) -> None:
        d, doc = self.d, self.doc
        try:
            self.inventory_rows = list(self.raw.list_object_headers_with_type(self.path))
        except Exception as err:
            raise DwgRefused(f"the object list could not be read ({type(err).__name__})") from None
        # ezdxf takes its own handles past the highest DWG handle, so an
        # entity can keep its own.
        top = max((int(r[0]) for r in self.inventory_rows), default=0)
        if 0 < top < 0xFFFFFFFFFF:
            doc.entitydb.handles.reset("%X" % (top + 1))
        try:
            if d.insunits is not None:
                doc.units = int(d.insunits)
        except Exception:
            self.facts["units not carried"] += 1
        try:
            hv = d.header_variables() or {}
            if "ltscale" in hv and float(hv["ltscale"]) > 0:
                doc.header["$LTSCALE"] = _num(hv["ltscale"])
        except Exception:
            self.facts["linetype scale not carried"] += 1

    def linetypes_and_styles(self) -> None:
        d, doc = self.d, self.doc
        self.lt_names = {lt.dxf.name.upper() for lt in doc.linetypes}
        try:
            rows = d.linetypes() or {}
        except Exception:
            rows = {}
            self.facts["linetype table not read"] += 1
        for name, row in rows.items():
            if not name:
                continue
            if name.upper() not in self.lt_names:
                dashes = [float(x) for x in (row.get("dashes") or [])]
                pattern = [float(row.get("pattern_length") or 0.0), *dashes] if dashes else [0.0]
                try:
                    doc.linetypes.add(name, pattern=pattern, description=str(row.get("description") or ""))
                    self.lt_names.add(name.upper())
                except Exception:
                    self.facts["linetype not carried"] += 1
                    continue
            if row.get("handle") is not None:
                self.lt_by_handle[int(row["handle"])] = name
        try:
            table_rows = self.raw.decode_write_tables(self.path)
        except Exception:
            table_rows = []
            self.facts["style table not read"] += 1
        for row in table_rows:
            if row.get("kind") != "STYLE" or row.get("shape") or not row.get("name"):
                continue
            name = str(row["name"])
            if name not in doc.styles:
                attribs = {}
                for key in ("width", "oblique", "height"):
                    try:
                        attribs[key] = _num(row.get(key) or 0.0)
                    except Skip:
                        pass
                if not attribs.get("width"):
                    attribs["width"] = 1.0
                try:
                    doc.styles.add(name, font=str(row.get("font") or "txt"), dxfattribs=attribs)
                except Exception:
                    self.facts["text style not carried"] += 1
                    continue
            self.style_by_handle[int(row["handle"])] = name

    def layers(self) -> None:
        doc = self.doc
        for layer in self.d.layers:
            name = layer.name
            if not name:
                continue
            self.layer_by_handle[int(layer.handle)] = name
            if name in doc.layers:
                target = doc.layers.get(name)
            else:
                try:
                    target = doc.layers.add(name)
                except Exception:
                    self.facts["layer name refused by ezdxf"] += 1
                    continue
            try:
                color = layer.color
                if isinstance(color, int) and 1 <= abs(color) <= 255:
                    target.dxf.color = abs(color)
                if isinstance(layer.true_color, int) and 0 <= layer.true_color <= 0xFFFFFF:
                    target.dxf.true_color = layer.true_color
                if layer.linetype and str(layer.linetype).upper() in self.lt_names:
                    target.dxf.linetype = str(layer.linetype)
                if isinstance(layer.lineweight, int) and layer.lineweight in LINEWEIGHTS:
                    target.dxf.lineweight = layer.lineweight
                if layer.on is False:
                    target.off()
                if layer.frozen:
                    target.freeze()
                if layer.locked:
                    target.lock()
                if layer.plot is False:
                    target.dxf.plot = 0
            except Exception:
                self.facts["layer properties partly carried"] += 1

    def spaces_and_blocks(self) -> None:
        doc, msp, raw, path = self.doc, self.msp, self.raw, self.path
        paper_n = 0
        try:
            layouts = list((self.d.layouts() or {}).values())
        except Exception:
            layouts = []
            self.facts["layouts not read"] += 1
        for row in layouts:
            h = row.get("block_record_handle")
            if h is None:
                continue
            if row.get("model"):
                self.space_by_handle[int(h)] = msp
            else:
                paper_n += 1
                try:
                    self.space_by_handle[int(h)] = (
                        doc.paperspace() if paper_n == 1 else doc.layouts.new(f"Layout{paper_n}")
                    )
                except Exception:
                    self.facts["paper layout not made"] += 1
        # Only rows the inventory names BLOCK_HEADER are blocks: the name
        # list also gives rows of other objects.
        header_handles = {
            int(r[0]) for r in self.inventory_rows if str(r[4]).strip().upper() == "BLOCK_HEADER"
        }
        headers: dict = {}
        for h, n in raw.decode_block_header_names(path):
            if int(h) in header_handles:
                headers[int(h)] = str(n)
        base_points: dict = {}
        try:
            for row in raw.decode_write_blocks(path):
                h = int(row["handle"])
                base_points[h] = row.get("base_point")
                if h in header_handles:
                    headers.setdefault(h, str(row.get("name") or ""))
        except Exception:
            self.facts["block base points not read"] += 1
        used = {b.name.upper() for b in doc.blocks}
        counters: Counter = Counter()
        for h in sorted(headers):
            name = headers[h].strip()
            up = name.upper()
            if h in self.space_by_handle:
                continue
            if up.startswith("*MODEL_SPACE"):
                self.space_by_handle[h] = msp
                continue
            if up.startswith("*PAPER_SPACE"):
                self.space_by_handle[h] = doc.paperspace()
                continue
            if not name:
                name, up = "*U", "*U"
            if name.startswith("*") or up in used:
                stem = name.rstrip("0123456789") or name
                while True:
                    counters[stem.upper()] += 1
                    n = counters[stem.upper()]
                    candidate = f"{stem}{n}" if name.startswith("*") else f"{name}#{n + 1}"
                    if candidate.upper() not in used:
                        break
                if name.startswith("*"):
                    self.facts["anonymous blocks named"] += 1
                else:
                    self.facts["blocks with a repeated name renamed"] += 1
                name = candidate
            try:
                bp = _p3(base_points.get(h) or (0.0, 0.0, 0.0))
            except Skip:
                bp = (0.0, 0.0, 0.0)
            try:
                self.space_by_handle[h] = doc.blocks.new(name, base_point=bp)
                self.block_name_by_handle[h] = name
                used.add(name.upper())
            except Exception:
                self.facts["block name refused by ezdxf"] += 1
        for h, n in headers.items():
            if h in self.block_name_by_handle:
                self.name_to_handles.setdefault(n.strip().upper(), []).append(h)

    # ── entities ──

    def common(self, g) -> dict:
        a = {}
        layer = self.layer_by_handle.get(g.get("layer_handle"))
        if layer:
            a["layer"] = layer
        color = g.get("color_index")
        if color is None:
            color = g.get("resolved_color_index")
        if isinstance(color, int) and 0 <= color <= 257:
            a["color"] = color
        tc = g.get("true_color")
        if isinstance(tc, int) and 0 <= tc <= 0xFFFFFF:
            a["true_color"] = tc
        lt = g.get("linetype")
        if isinstance(lt, str) and lt.upper() in self.lt_names:
            a["linetype"] = lt
        lw = g.get("lineweight")
        if isinstance(lw, int) and lw in LINEWEIGHTS:
            a["lineweight"] = lw
        ls = g.get("linetype_scale")
        if isinstance(ls, (int, float)) and math.isfinite(ls) and 0 < ls < WILD and ls != 1.0:
            a["ltscale"] = float(ls)
        if g.get("invisible"):
            a["invisible"] = 1
        ex = g.get("extrusion")
        if ex is not None:
            try:
                ex = _p3(ex)
                if ex != (0.0, 0.0, 1.0) and any(ex):
                    a["extrusion"] = ex
            except Skip:
                pass
        return a

    def text_attribs(self, g, a) -> dict:
        a = dict(a)
        a["insert"] = _p3(g.get("insert"))
        for key in ("height", "rotation", "width", "oblique"):
            if g.get(key):
                a[key] = _num(g[key])
        if g.get("text_generation_flag"):
            a["text_generation_flag"] = int(g["text_generation_flag"])
        style = self.style_by_handle.get(g.get("style_handle"))
        if style:
            a["style"] = style
        halign, valign = int(g.get("halign") or 0), int(g.get("valign") or 0)
        if (halign or valign) and g.get("align_point") is not None:
            a["halign"], a["valign"] = halign, valign
            a["align_point"] = _p3(g["align_point"])
        return a

    def target_of(self, handle: int):
        mode, owner = self.place.get(handle, (None, None))
        if mode == 2:
            return self.msp
        if owner is not None and owner in self.space_by_handle:
            return self.space_by_handle[owner]
        if mode == 1:
            return self.doc.paperspace()
        raise Skip("owner block unknown" if mode == 0 else "no placement")

    def picture(self, handle: int):
        """The saved picture of a MULTILEADER record, or None. ONE reader
        call a file, for every MULTILEADER the inventory lists."""
        if self.pictures is None:
            asked = sorted(
                {int(r[0]) for r in self.inventory_rows if str(r[4]).strip().upper() == "MULTILEADER"}
            )
            try:
                self.pictures = {int(h): b for h, b in self.raw.decode_entity_proxy_graphics(self.path, asked)}
            except Exception:
                self.pictures = {}
                self.facts["saved pictures not read"] += 1
            self.facts["MULTILEADER records not read for a saved picture"] += len(asked) - len(self.pictures)
        return self.pictures.get(handle)

    def mleader(self, e, g, a, space):
        from ezdxf.entities.mleader import AttribData, BlockData, LeaderData, LeaderLine, MTextData  # noqa: PLC0415
        from ezdxf.math import Vec3  # noqa: PLC0415

        doc = self.doc
        c = g["context"]
        block = c.get("block")
        block_name = None
        if block is not None:
            block_name = self.block_name_by_handle.get(block["block_handle"])
            if block_name is None:
                raise Skip("its content block is not in the file's block list")
        made = space.new_entity("MULTILEADER", dxfattribs=a)
        picture = self.picture(int(e.handle))
        if picture:
            made.proxy_graphic = picture
            self.facts["MULTILEADER with its saved picture"] += 1
        else:
            self.facts["MULTILEADER with no saved picture (drawn by ezdxf)"] += 1
        dx = made.dxf
        # The drawing's styles are not carried: the record holds every value
        # that is drawn, so every property is set on the entity itself.
        dx.style_handle = doc.mleader_styles.get("Standard").dxf.handle
        dx.property_override_flags = (1 << 30) - 1
        dx.leader_type = int(g["leader_line_type"])
        dx.leader_line_color = _raw_color(g["leader_color"])
        lt = self.lt_by_handle.get(g["leader_linetype_handle"])
        dx.leader_linetype_handle = doc.linetypes.get(lt if lt else "BYBLOCK").dxf.handle
        if g["leader_lineweight"] in LINEWEIGHTS:
            dx.leader_lineweight = int(g["leader_lineweight"])
        dx.has_landing = int(g["landing_enabled"])
        dx.has_dogleg = int(g["dogleg_enabled"])
        dx.dogleg_length = _num(g["dogleg_length"])
        arrow = self.block_name_by_handle.get(g["arrow_handle"])
        if arrow is not None:
            dx.arrow_head_handle = doc.blocks.get(arrow).block_record_handle
        elif g["arrow_handle"]:
            self.facts["MULTILEADER arrowhead block not in the block list"] += 1
        dx.arrow_head_size = _num(g["arrow_size"])
        dx.content_type = int(g["content_type"])
        style = self.style_by_handle.get(g["text_style_handle"])
        if style is not None:
            dx.text_style_handle = doc.styles.get(style).dxf.handle
        dx.text_left_attachment_type = int(g["left_attachment"])
        dx.text_right_attachment_type = int(g["right_attachment"])
        dx.has_text_frame = int(g["text_frame"])
        dx.block_connection_type = int(g["block_connection"])
        ctx = made.context
        ctx.scale = _num(c["scale"])
        ctx.base_point = Vec3(_p3(c["content_base"]))
        ctx.char_height = _num(c["text_height"])
        ctx.arrow_head_size = _num(c["arrow_size"])
        ctx.landing_gap_size = _num(c["landing_gap"])
        ctx.left_attachment = int(c["left_attachment"])
        ctx.right_attachment = int(c["right_attachment"])
        ctx.text_align_type = int(c["text_alignment"])
        ctx.attachment_type = int(c["attachment_type"])
        ctx.plane_origin = Vec3(_p3(c["plane_origin"]))
        ctx.plane_x_axis = Vec3(_p3(c["plane_x_axis"]))
        ctx.plane_y_axis = Vec3(_p3(c["plane_y_axis"]))
        ctx.plane_normal_reversed = int(c["plane_normal_reversed"])
        for leader in c["leaders"]:
            ld = LeaderData()
            ld.has_last_leader_line = int(leader["has_last_point"])
            ld.has_dogleg_vector = int(leader["has_dogleg"])
            ld.last_leader_point = Vec3(_p3(leader["last_point"]))
            ld.dogleg_vector = Vec3(_p3(leader["dogleg_vector"]))
            ld.dogleg_length = _num(leader["dogleg_length"])
            ld.index = int(leader["index"])
            ld.attachment_direction = int(leader["attachment_direction"] or 0)
            for line in leader["lines"]:
                ll = LeaderLine()
                ll.vertices = [Vec3(_p3(p)) for p in line["points"]]
                ll.index = int(line["index"])
                ld.lines.append(ll)
            ctx.leaders.append(ld)
        if c["leaders"]:
            dx.text_attachment_direction = int(c["leaders"][0]["attachment_direction"] or 0)
        text = c.get("text")
        if text is not None:
            m = MTextData()
            m.default_content = str(text["text"])
            m.extrusion = Vec3(_p3(text["normal"]))
            style = self.style_by_handle.get(text["style_handle"])
            if style is not None:
                m.style_handle = doc.styles.get(style).dxf.handle
            m.insert = Vec3(_p3(text["location"]))
            m.text_direction = Vec3(_p3(text["direction"]))
            m.rotation = _num(text["rotation"])
            m.width = _num(text["width"])
            m.color = _raw_color(text["color"])
            m.alignment = int(text["attachment"])
            m.flow_direction = int(text["drawing_direction"])
            m.bg_color = _raw_color(text["background_color"])
            m.bg_scale_factor = _num(text["background_scale"])
            m.has_bg_fill = int(text["background_on"])
            ctx.mtext = m
        if block is not None:
            b = BlockData()
            b.block_record_handle = doc.blocks.get(block_name).block_record_handle
            b.extrusion = Vec3(_p3(block["normal"]))
            b.insert = Vec3(_p3(block["location"]))
            b.scale = Vec3(_p3(block["scale"]))
            b.rotation = _num(block["rotation"])
            b.color = _raw_color(block["color"])
            b._matrix = [_num(v) for v in block["matrix"]]
            ctx.block = b
            dx.block_record_handle = b.block_record_handle
        made.block_attribs = [
            AttribData("%X" % int(attr["definition_handle"]), int(attr["index"]), _num(attr["width"]), str(attr["text"]))
            for attr in g.get("attributes") or []
        ]
        return made

    def convert(self, e, space):  # noqa: C901, PLR0912, PLR0915 - one branch a type, as the table says
        t, g = e.dxftype, e.dxf
        a = self.common(g)
        if t == "LINE":
            return space.add_line(_p3(g["start"]), _p3(g["end"]), dxfattribs=a)
        if t == "POINT":
            return space.add_point(_p3(g["location"]), dxfattribs=a)
        if t == "CIRCLE":
            return space.add_circle(_p3(g["center"]), _num(g["radius"]), dxfattribs=a)
        if t == "ARC":
            return space.add_arc(
                _p3(g["center"]), _num(g["radius"]), _num(g["start_angle"]), _num(g["end_angle"]), dxfattribs=a
            )
        if t == "ELLIPSE":
            ratio = _num(g["axis_ratio"])
            if not 1e-6 <= ratio <= 1.0:
                raise Skip("axis ratio out of range")
            end = g.get("end_angle")
            return space.add_ellipse(
                _p3(g["center"]),
                major_axis=_p3(g["major_axis"]),
                ratio=ratio,
                start_param=_num(g.get("start_angle") or 0.0),
                end_param=_num(end if end is not None else math.tau),
                dxfattribs=a,
            )
        if t == "LWPOLYLINE":
            pts = g.get("points") or []
            bulges = g.get("bulges") or []
            widths = g.get("widths") or []
            rows = []
            for i, p in enumerate(pts):
                w = widths[i] if i < len(widths) else (0.0, 0.0)
                b = _num(bulges[i]) if i < len(bulges) else 0.0
                rows.append((_num(p[0]), _num(p[1]), _num(w[0]), _num(w[1]), b))
            if not rows:
                raise Skip("no points")
            if g.get("const_width"):
                a["const_width"] = _num(g["const_width"])
            if g.get("elevation"):
                a["elevation"] = _num(g["elevation"])
            made = space.add_lwpolyline(rows, format="xyseb", close=bool(g.get("closed")), dxfattribs=a)
            # Linetype generation (128): a dash pattern runs on over the vertices.
            made.dxf.flags |= int(g.get("flags") or 0) & 128
            return made
        if t == "TEXT":
            return space.add_text(str(g.get("text") or ""), dxfattribs=self.text_attribs(g, a))
        if t == "ATTDEF":
            ta = self.text_attribs(g, a)
            ta["prompt"] = str(g.get("prompt") or "")
            if g.get("attribute_flags"):
                ta["flags"] = int(g["attribute_flags"])
            ins = ta.pop("insert")
            return space.add_attdef(str(g.get("tag") or ""), ins, str(g.get("text") or ""), dxfattribs=ta)
        if t == "MTEXT":
            a["insert"] = _p3(g.get("insert"))
            if g.get("char_height"):
                a["char_height"] = _num(g["char_height"])
            if g.get("rect_width"):
                a["width"] = _num(g["rect_width"])
            if isinstance(g.get("attachment_point"), int) and 1 <= g["attachment_point"] <= 9:
                a["attachment_point"] = g["attachment_point"]
            td = g.get("text_direction")
            if td is not None and any(td):
                a["text_direction"] = _p3(td)
            elif g.get("rotation"):
                a["rotation"] = _num(g["rotation"])
            if g.get("line_spacing_factor"):
                a["line_spacing_factor"] = min(4.0, max(0.25, _num(g["line_spacing_factor"])))
            if g.get("line_spacing_style") in (1, 2):
                a["line_spacing_style"] = g["line_spacing_style"]
            if g.get("drawing_direction") in (1, 3, 5):
                a["flow_direction"] = g["drawing_direction"]
            style = self.style_by_handle.get(g.get("style_handle"))
            if style:
                a["style"] = style
            body = g.get("raw_text")
            return space.add_mtext(str(body if body else (g.get("text") or "")), dxfattribs=a)
        if t in ("INSERT", "MINSERT"):
            bh = self.insert_block.get(int(e.handle))
            name = self.block_name_by_handle.get(bh) if bh else None
            if name is None:
                hits = self.name_to_handles.get(str(g.get("name") or "").strip().upper(), [])
                if len(hits) == 1:
                    name = self.block_name_by_handle[hits[0]]
            if name is None:
                raise Skip("its block is not in the file's block list")
            for key in ("xscale", "yscale", "zscale"):
                a[key] = _num(g.get(key, 1.0))
            if g.get("rotation"):
                a["rotation"] = _num(g["rotation"])
            if t == "MINSERT":
                for key in ("column_count", "row_count", "column_spacing", "row_spacing"):
                    if g.get(key):
                        a[key] = g[key]
            made = space.add_blockref(name, _p3(g["insert"]), dxfattribs=a)
            self.made_inserts[int(e.handle)] = made
            return made
        if t in ("SOLID", "TRACE", "3DFACE"):
            pts = [_p3(p) for p in (g.get("points") or [])]
            if len(pts) < 3:
                raise Skip("fewer than 3 points")
            add = space.add_solid if t == "SOLID" else space.add_trace if t == "TRACE" else space.add_3dface
            return add(pts[:4], dxfattribs=a)
        if t == "HATCH":
            rows = []
            for p in g.get("paths") or []:
                pts = [_p3(q) for q in (p.get("points") or [])]
                rows.append((pts, bool(p.get("closed", True))))
            if g.get("elevation"):
                a["elevation"] = (0.0, 0.0, _num(g["elevation"]))
            hatch = space.add_hatch(color=a.pop("color", 256), dxfattribs=a)
            # Island style: the reader does not give it, so 0 ("normal",
            # AutoCAD's default).
            if g.get("solid_fill"):
                hatch.set_solid_fill(color=hatch.dxf.color, style=0)
            else:
                self.pattern(hatch, g)
            for pts, closed in rows:
                if len(pts) >= 2:
                    hatch.paths.add_polyline_path(pts, is_closed=closed)
            return hatch
        if t == "SPLINE":
            cps = [_p3(p) for p in (g.get("control_points") or [])]
            fits = [_p3(p) for p in (g.get("fit_points") or [])]
            knots = [_num(k) for k in (g.get("knots") or [])]
            degree = int(g.get("degree") or 3)
            if cps and len(knots) == len(cps) + degree + 1:
                s = space.add_spline(dxfattribs=a)
                s.dxf.degree = degree
                s.control_points = cps
                s.knots = knots
                w = g.get("weights") or []
                if len(w) == len(cps):
                    s.weights = [_num(x) for x in w]
                if g.get("closed"):
                    s.closed = True
                return s
            if len(fits) >= 2:
                return space.add_spline(fit_points=fits, dxfattribs=a)
            if len(cps) >= 2:
                return space.add_open_spline(cps, degree=min(degree, len(cps) - 1), dxfattribs=a)
            raise Skip("no usable points")
        if t == "LEADER":
            pts = [_p3(p) for p in (g.get("points") or [])]
            if len(pts) < 2:
                raise Skip("fewer than 2 points")
            return space.add_leader(pts, dxfattribs=a)
        if t in ("POLYLINE_2D", "POLYLINE_3D", "POLYLINE"):
            pts = g.get("points") or g.get("vertices") or []
            closed = bool(g.get("closed")) or bool(int(g.get("flags") or 0) & 1)
            if len(pts) < 2:
                raise Skip("fewer than 2 points")
            if t == "POLYLINE_3D":
                made = space.add_polyline3d([_p3(p) for p in pts], close=closed, dxfattribs=a)
            else:
                bulges = g.get("bulges") or []
                rows = [
                    (_num(p[0]), _num(p[1]), _num(bulges[i]) if i < len(bulges) else 0.0)
                    for i, p in enumerate(pts)
                ]
                made = space.add_polyline2d(rows, format="xyb", close=closed, dxfattribs=a)
            self.fitted(made, g, len(pts))
            return made
        if t == "POLYLINE_PFACE":
            verts = [_p3(p) for p in (g.get("vertices") or [])]
            face = space.add_polyface(dxfattribs=a)
            for f in g.get("faces") or []:
                pts = [verts[abs(int(i)) - 1] for i in f if i and abs(int(i)) <= len(verts)]
                if len(pts) >= 3:
                    face.append_face(pts)
            return face
        if t == "DIMENSION":
            a.update(
                defpoint=_p3(g.get("defpoint") or (0, 0, 0)),
                text_midpoint=_p3(g.get("text_midpoint") or (0, 0, 0)),
                dimtype=DIMTYPES.get(str(g.get("dimtype") or "").upper(), 0),
                text=str(g.get("text") or ""),
            )
            name = self.block_name_by_handle.get(g.get("anonymous_block_handle"))
            if name is not None:
                a["geometry"] = name
            else:
                self.facts["DIMENSION with no drawn block (kept, draws nothing)"] += 1
            return space.new_entity("DIMENSION", dxfattribs=a)
        if t == "MULTILEADER":
            return self.mleader(e, g, a, space)
        if t == "WIPEOUT":
            # The record is an IMAGE record with no image; the DXF entity
            # takes the same frame and boundary.
            verts = [(_num(v[0]), _num(v[1])) for v in (g.get("clip_vertices") or [])]
            if len(verts) < 2:
                raise Skip("fewer than 2 boundary vertices")
            size = g.get("size") or (1.0, 1.0)
            a.update(
                insert=_p3(g["insert"]),
                u_pixel=_p3(g["u_vector"]),
                v_pixel=_p3(g["v_vector"]),
                image_size=(_num(size[0]), _num(size[1])),
                flags=int(g.get("display_props") or 0) & 0xF,
            )
            made = space.new_entity("WIPEOUT", dxfattribs=a)
            made.set_boundary_path(verts)
            return made
        raise Skip("no converter")

    def pattern(self, hatch, g) -> None:
        """A pattern fill. The file's own pattern lines when the reader has
        them: they are stored final (scaled and turned), so they are set as
        they are. Else the pattern of that name, at the file's scale and
        angle. Else ANSI31, counted."""
        name = str(g.get("pattern_name") or "")
        lines = [
            [_num(line["angle"]), tuple(_num(v) for v in line["base"]), tuple(_num(v) for v in line["offset"]),
             [_num(v) for v in line.get("dashes") or []]]
            for line in g.get("pattern_lines") or []
        ]
        angle = _num(g.get("pattern_angle") or 0.0)
        scale = _num(g.get("pattern_scale") or 1.0)
        if lines:
            # A pattern with no name is user-defined (type 0).
            hatch.set_pattern_fill(name or "_USER", color=hatch.dxf.color, angle=angle, scale=scale,
                                   double=int(bool(g.get("pattern_double"))), style=0,
                                   pattern_type=1 if name else 0, definition=lines)
            hatch.set_pattern_definition(lines, factor=1.0, angle=0.0)
            return
        try:
            if not name:
                raise ValueError("no pattern name")
            hatch.set_pattern_fill(name, color=hatch.dxf.color, angle=angle, scale=scale, style=0)
        except Exception:
            hatch.set_pattern_fill("ANSI31", color=hatch.dxf.color, style=0)
            self.facts["hatch pattern with no lines and no name ezdxf knows: drawn as ANSI31"] += 1

    @staticmethod
    def fitted(made, g, n: int) -> None:
        """A curve-fit or spline-fit polyline keeps its kind and its vertex
        kinds: a spline's control points (vertex flag 16) are its frame, not
        drawn line, and the picture and the bones leave them out."""
        made.dxf.flags |= int(g.get("flags") or 0) & (2 | 4)
        if g.get("curve_type") in (5, 6, 8):
            made.dxf.smooth_type = int(g["curve_type"])
        kinds = g.get("vertex_flags") or []
        if len(kinds) == n:
            for vertex, kind in zip(made.vertices, kinds):
                vertex.dxf.flags |= int(kind) & (1 | 2 | 8 | 16)

    def keep_handle(self, made, e) -> None:
        try:
            old = made.dxf.handle
            ok = self.doc.entitydb.reset_handle(made, "%X" % int(e.handle))
            if ok and hasattr(made, "all_sub_entities"):
                # An INSERT or POLYLINE owns its SEQEND and vertices by handle.
                for sub in made.all_sub_entities():
                    if sub is not None and sub.dxf.get("owner") == old:
                        sub.dxf.owner = made.dxf.handle
        except Exception:
            ok = False
        self.kept["kept" if ok else "new"] += 1

    def attach(self, e) -> None:
        """An ATTRIB onto its INSERT."""
        g = e.dxf
        ref = self.made_inserts.get(g.get("owner_handle"))
        if ref is None:
            raise Skip("its INSERT is not converted")
        ta = self.text_attribs(g, self.common(g))
        ins = ta.pop("insert")
        if g.get("attribute_flags"):
            ta["flags"] = int(g["attribute_flags"])
        self.keep_handle(ref.add_attrib(str(g.get("tag") or ""), str(g.get("text") or ""), ins, dxfattribs=ta), e)

    def cut_block_cycles(self) -> int:
        """Remove each INSERT that closes a cycle of blocks; their count.
        Iterative, so a long chain of blocks needs no recursion."""
        graph = {b.name.upper(): [e for e in b if e.dxftype() == "INSERT"] for b in self.doc.blocks}
        state: dict = {}
        removed = 0
        for root in list(graph):
            if root in state:
                continue
            state[root] = 1
            stack = [(root, iter(list(graph[root])))]
            while stack:
                name, refs = stack[-1]
                ref = next(refs, None)
                if ref is None:
                    state[name] = 2
                    stack.pop()
                    continue
                child = str(ref.dxf.name).upper()
                if state.get(child) == 1:
                    self.doc.blocks.get(name).delete_entity(ref)
                    removed += 1
                elif child not in state and child in graph:
                    state[child] = 1
                    stack.append((child, iter(list(graph[child]))))
        return removed

    def run(self):
        self.header()
        self.linetypes_and_styles()
        self.layers()
        self.spaces_and_blocks()
        raw, path = self.raw, self.path
        entities = {}
        for e in self.d.entities().iter_entities():
            if e.dxftype not in STRUCTURAL:
                entities[int(e.handle)] = e
        self.place = {int(h): (int(m), int(o) if o else None) for h, m, o in raw.decode_entity_placements(path)}
        try:
            for row in raw.decode_insert_write_properties(path):
                if row[2]:
                    self.insert_block[int(row[0])] = int(row[2])
        except Exception:
            self.facts["insert block handles not read"] += 1
        # Every entity object the file lists: one the reader did not decode
        # is counted, never lost.
        objects = 0
        for row in self.inventory_rows:
            handle, name, category = int(row[0]), str(row[4]).strip().upper(), str(row[5]).upper()
            if category not in ("E", "ENTITY") or name in STRUCTURAL:
                continue
            objects += 1
            if handle not in entities:
                self.skipped[(name, "not decoded by ezdwg")] += 1
        if objects and not entities:
            raise DwgRefused(f"the reader decoded none of the {objects} drawing objects the file lists")
        # Every entity but ATTRIB, in handle order; then each ATTRIB on its
        # INSERT. One odd entity is counted by its error's class.
        for second in (False, True):
            for handle in sorted(entities):
                e = entities[handle]
                if (e.dxftype == "ATTRIB") != second:
                    continue
                try:
                    if second:
                        self.attach(e)
                    else:
                        self.keep_handle(self.convert(e, self.target_of(handle)), e)
                    self.converted[e.dxftype] += 1
                except Skip as why:
                    self.skipped[(e.dxftype, str(why))] += 1
                except Exception as err:
                    self.skipped[(e.dxftype, f"error {type(err).__name__}")] += 1
        cut = self.cut_block_cycles()
        if cut:
            self.converted["INSERT"] -= cut
            self.skipped[("INSERT", "closes a cycle of blocks")] += cut
        converted = sum(self.converted.values())
        not_converted = sum(self.skipped.values())
        notes = {
            "reader": "ezdwg",
            "version": getattr(self.d, "version", None),
            "objects": objects,
            "converted": converted,
            "converted_by_type": dict(sorted(self.converted.items())),
            "not_converted_total": not_converted,
            "not_converted": [
                {"type": t, "reason": r, "count": n}
                for (t, r), n in sorted(self.skipped.items(), key=lambda kv: (-kv[1], kv[0]))
            ],
            "gap": objects - converted - not_converted,
            "blocks": len(self.block_name_by_handle),
            "handles_kept": self.kept["kept"],
            "handles_new": self.kept["new"],
            "facts": dict(sorted(self.facts.items())),
        }
        return self.doc, notes


def build_document(d):
    """The ezdxf document of a reader document `d` (ezdwg.read's), and the
    notes for the index's `dwg` record."""
    return _Build(d).run()
