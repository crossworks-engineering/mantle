"""Tests for dwg_read.py: DWG into an in-memory ezdxf document from ezdwg's
reader rows.

Run (stdlib unittest; the cases skip when ezdxf, ezdwg or matplotlib is
missing, unless PARSER_TESTS_REQUIRE_CAD is set; the sample cases need our
ezdwg build and skip by name with the official one, as in CI):

    python -m unittest discover -s server/parser/cad/tests

Two kinds of case. Most hand made-up reader rows to the builder (`fake`
below has the shape of an ezdwg reader document), so each special case is
pinned without a drawing. The rest read the public sample drawing
(tests/data/sample_AC1032.dwg, MIT, see tests/data/README.md) through the
real reader and the real `open_cad`.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from types import SimpleNamespace as NS
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import dwg_read  # noqa: E402

SAMPLE = os.path.join(HERE, "data", "sample_AC1032.dwg")

try:
    import ezdxf  # noqa: F401

    HAVE_EZDXF = True
except Exception:  # pragma: no cover - the venv case
    HAVE_EZDXF = False
    if os.environ.get("PARSER_TESTS_REQUIRE_CAD"):
        raise

try:
    import ezdwg

    HAVE_EZDWG_MODULE = True
except Exception:  # pragma: no cover - the venv case
    HAVE_EZDWG_MODULE = False
    if os.environ.get("PARSER_TESTS_REQUIRE_CAD"):
        raise
# Our reader build (the parser image's), or an official ezdwg (CI's).
HAVE_EZDWG = HAVE_EZDWG_MODULE and dwg_read.reads_dwg(ezdwg)

try:
    import matplotlib  # noqa: F401

    HAVE_MPL = True
except Exception:  # pragma: no cover - the venv case
    HAVE_MPL = False
    if os.environ.get("PARSER_TESTS_REQUIRE_CAD"):
        raise

LAYER0 = 0x10
MODEL = 0x1F
PAPER = 0x1B


def ent(handle, dxftype, owner=None, paper=False, **dxf):
    """One reader row; `owner` is a block handle, else model (or paper) space."""
    dxf.setdefault("layer_handle", LAYER0)
    row = NS(handle=handle, dxftype=dxftype, dxf=dxf)
    row.place = (0, owner) if owner is not None else ((1, None) if paper else (2, None))
    return row


def fake(entities, blocks=(), inserts=None, extra=(), pictures=None, inventory=True):
    """A reader document with the shape of ezdwg's: `blocks` are (handle,
    stored name, base point); `inserts` maps an INSERT handle to its block
    handle; `extra` are (handle, type) entity objects the reader did not
    decode; `pictures` maps a handle to its saved picture."""
    headers = [(MODEL, "*Model_Space"), (PAPER, "*Paper_Space")] + [(h, n) for h, n, _ in blocks]
    rows = [(h, 0, 10, 0, "BLOCK_HEADER", "O") for h, _ in headers]
    rows += [(e.handle, 0, 10, 0, e.dxftype, "E") for e in entities]
    rows += [(h, 0, 10, 0, t, "E") for h, t in extra]

    def object_list(_path):
        if not inventory:
            raise ValueError("damaged")
        return rows

    raw = NS(
        list_object_headers_with_type=object_list,
        decode_write_tables=lambda _p: [],
        decode_block_header_names=lambda _p: headers,
        decode_write_blocks=lambda _p: [{"handle": h, "name": n, "base_point": bp} for h, n, bp in blocks],
        decode_entity_placements=lambda _p: [(e.handle, e.place[0], e.place[1]) for e in entities],
        decode_insert_write_properties=lambda _p: [(h, (0, 0, 0), b, None) for h, b in (inserts or {}).items()],
        decode_entity_proxy_graphics=lambda _p, hs: [(h, (pictures or {}).get(h)) for h in hs],
    )
    return NS(
        path="drawing.dwg",
        decode_path=None,
        version="AC1032",
        raw=raw,
        insunits=4,
        header_variables=lambda: {},
        linetypes=lambda: {},
        layers=[
            NS(name="0", handle=LAYER0, color=7, true_color=None, linetype="Continuous", lineweight=-3,
               on=True, frozen=False, locked=False, plot=True),
        ],
        layouts=lambda: {"Model": {"model": True, "block_record_handle": MODEL},
                         "Layout1": {"model": False, "block_record_handle": PAPER}},
        entities=lambda: NS(iter_entities=lambda: iter(entities)),
    )


def line(handle, owner=None, paper=False):
    return ent(handle, "LINE", owner, paper, start=(0, 0, 0), end=(1, 1, 0))


def not_converted(notes) -> dict:
    return {(m["type"], m["reason"]): m["count"] for m in notes["not_converted"]}


@unittest.skipUnless(HAVE_EZDXF, "ezdxf not installed")
class BuildTests(unittest.TestCase):
    def test_every_object_is_converted_or_counted_by_type(self):
        doc, notes = dwg_read.build_document(
            fake([line(0x100), ent(0x101, "RAY", start=(0, 0, 0)), ent(0x102, "LINE", start=(0, 0, 0), end=(float("nan"), 0, 0))],
                 extra=[(0x103, "ACAD_TABLE")])
        )
        self.assertEqual([e.dxftype() for e in doc.modelspace()], ["LINE"])
        self.assertEqual(
            not_converted(notes),
            {("RAY", "no converter"): 1, ("ACAD_TABLE", "not decoded by ezdwg"): 1,
             ("LINE", "a number is not finite or is wild"): 1},
        )
        self.assertEqual((notes["objects"], notes["converted"], notes["not_converted_total"], notes["gap"]), (4, 1, 3, 0))
        # The DWG handle is kept.
        self.assertEqual(next(iter(doc.modelspace())).dxf.handle, "100")

    def test_attributes_sit_on_their_insert_hidden_or_not(self):
        doc, notes = dwg_read.build_document(
            fake(
                [
                    ent(0x110, "INSERT", insert=(5, 5, 0), name="TAG"),
                    ent(0x111, "ATTRIB", owner_handle=0x110, tag="LINENO", text="L-1", insert=(5, 5, 0), height=1.0),
                    ent(0x112, "ATTRIB", owner_handle=0x110, tag="CIRCUIT", text="C-7", insert=(5, 4, 0),
                        height=1.0, attribute_flags=1),
                    ent(0x113, "ATTRIB", owner_handle=0x999, tag="LOST", text="x", insert=(0, 0, 0)),
                ],
                blocks=[(0x50, "TAG", (0, 0, 0))],
                inserts={0x110: 0x50},
            )
        )
        ref = next(iter(doc.modelspace()))
        self.assertEqual(ref.dxf.name, "TAG")
        got = {a.dxf.tag: (a.dxf.text, a.is_invisible) for a in ref.attribs}
        self.assertEqual(got, {"LINENO": ("L-1", False), "CIRCUIT": ("C-7", True)})
        self.assertEqual(not_converted(notes), {("ATTRIB", "its INSERT is not converted"): 1})
        self.assertEqual(notes["gap"], 0)

    def test_an_insert_links_by_handle_and_anonymous_or_repeated_names_get_new_ones(self):
        # The DWG stores "*U" with no number; two blocks share a stored name.
        doc, notes = dwg_read.build_document(
            fake(
                [
                    line(0x120, owner=0x60),
                    ent(0x121, "CIRCLE", owner=0x61, center=(0, 0, 0), radius=2.0),
                    ent(0x122, "LINE", owner=0x62, start=(0, 0, 0), end=(0, 3, 0)),
                    ent(0x123, "INSERT", insert=(0, 0, 0), name="*U"),
                    ent(0x124, "INSERT", insert=(9, 0, 0), name="*U"),
                    ent(0x125, "INSERT", insert=(0, 9, 0), name="VALVE"),
                ],
                blocks=[(0x60, "*U", None), (0x61, "*U", None), (0x62, "VALVE", None), (0x63, "VALVE", None)],
                inserts={0x123: 0x60, 0x124: 0x61, 0x125: 0x62},
            )
        )
        refs = [e for e in doc.modelspace() if e.dxftype() == "INSERT"]
        names = [r.dxf.name for r in refs]
        self.assertEqual(len(set(names)), 3)
        self.assertTrue(names[0].startswith("*U") and names[1].startswith("*U"))
        kinds = [[x.dxftype() for x in doc.blocks.get(n)] for n in names]
        self.assertEqual(kinds, [["LINE"], ["CIRCLE"], ["LINE"]])
        self.assertEqual(notes["facts"]["anonymous blocks named"], 2)
        self.assertEqual(notes["facts"]["blocks with a repeated name renamed"], 1)

    def test_a_dimension_keeps_its_drawn_block_or_is_kept_without_one(self):
        doc, notes = dwg_read.build_document(
            fake(
                [
                    line(0x130, owner=0x70),
                    ent(0x131, "DIMENSION", anonymous_block_handle=0x70, dimtype="LINEAR", text="<>"),
                    ent(0x132, "DIMENSION", anonymous_block_handle=0x7777, dimtype="ALIGNED", text="12"),
                ],
                blocks=[(0x70, "*D", None)],
            )
        )
        dims = [e for e in doc.modelspace() if e.dxftype() == "DIMENSION"]
        self.assertEqual(len(dims), 2)
        self.assertTrue(dims[0].dxf.geometry.startswith("*D"))
        self.assertFalse(dims[1].dxf.hasattr("geometry"))
        self.assertEqual(notes["facts"]["DIMENSION with no drawn block (kept, draws nothing)"], 1)
        self.assertEqual((notes["not_converted_total"], notes["gap"]), (0, 0))

    @unittest.skipUnless(HAVE_MPL, "matplotlib not installed")
    def test_a_dimension_with_no_drawn_block_renders_the_rest(self):
        import cad  # noqa: PLC0415

        doc, _ = dwg_read.build_document(
            fake([line(0x140), ent(0x141, "DIMENSION", anonymous_block_handle=None, dimtype="LINEAR", text="9")])
        )
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(cad, "open_cad", return_value=(doc, "ezdwg", {})):
            self.assertEqual(cad.dwg_render_worker("x.dwg", tmp, 50), 0)
            with open(os.path.join(tmp, "index.json"), encoding="utf-8") as f:
                index = json.load(f)
        self.assertIsNone(index["render_error"])
        self.assertEqual(index["counts"], {"LINE": 1, "DIMENSION": 1})

    def test_paper_space_and_blocks_take_their_own_entities(self):
        doc, notes = dwg_read.build_document(
            fake([line(0x150), line(0x151, paper=True), line(0x152, owner=0x80), line(0x153, owner=0x8888)],
                 blocks=[(0x80, "B", None)])
        )
        self.assertEqual(len(list(doc.modelspace())), 1)
        self.assertEqual(len(list(doc.paperspace())), 1)
        self.assertEqual(len(list(doc.blocks.get("B"))), 1)
        self.assertEqual(not_converted(notes), {("LINE", "owner block unknown"): 1})

    def test_a_wipeout_is_a_mask_with_its_boundary(self):
        doc, notes = dwg_read.build_document(
            fake([
                ent(0x160, "WIPEOUT", insert=(1, 1, 0), u_vector=(0.01, 0, 0), v_vector=(0, 0.01, 0), size=(100, 50),
                    display_props=7, clip_vertices=[(-0.5, -0.5), (99.5, -0.5), (99.5, 49.5), (-0.5, 49.5)]),
                ent(0x161, "WIPEOUT", insert=(1, 1, 0), u_vector=(1, 0, 0), v_vector=(0, 1, 0), clip_vertices=[(0, 0)]),
            ])
        )
        (w,) = list(doc.modelspace())
        self.assertEqual((w.dxftype(), w.dxf.flags, len(w.boundary_path)), ("WIPEOUT", 7, 5))
        self.assertEqual(not_converted(notes), {("WIPEOUT", "fewer than 2 boundary vertices"): 1})

    def test_a_hatch_keeps_its_own_pattern_lines_and_the_normal_island_style(self):
        square = [{"closed": True, "points": [(0, 0, 0), (10, 0, 0), (10, 10, 0), (0, 10, 0), (0, 0, 0)]}]
        lines = [{"angle": 45.0, "base": (2.75, 0.0), "offset": (-0.0883883, 0.0883883), "dashes": []}]
        doc, notes = dwg_read.build_document(
            fake([
                ent(0x190, "HATCH", pattern_name="", solid_fill=False, paths=square, pattern_angle=0.0,
                    pattern_scale=1.0, pattern_lines=lines),
                ent(0x191, "HATCH", pattern_name="ANSI37", solid_fill=False, paths=square, pattern_angle=30.0,
                    pattern_scale=2.0, pattern_lines=[]),
                ent(0x192, "HATCH", pattern_name="", solid_fill=True, paths=square),
                ent(0x193, "HATCH", pattern_name="", solid_fill=False, paths=square, pattern_lines=[]),
            ])
        )
        user, named, solid, bare = list(doc.modelspace())
        # The stored lines, as they are: not scaled or turned a second time.
        (line,) = user.pattern.lines
        self.assertEqual((user.dxf.pattern_type, user.dxf.pattern_name), (0, "_USER"))
        self.assertAlmostEqual(line.angle, 45.0)
        self.assertAlmostEqual(line.offset.y, 0.0883883)
        self.assertEqual((named.dxf.pattern_name, named.dxf.pattern_scale, named.dxf.pattern_angle), ("ANSI37", 2.0, 30.0))
        self.assertEqual([h.dxf.hatch_style for h in (user, named, solid, bare)], [0, 0, 0, 0])
        self.assertEqual(bare.dxf.pattern_name, "ANSI31")
        self.assertEqual(notes["facts"], {"hatch pattern with no lines and no name ezdxf knows: drawn as ANSI31": 1})

    def test_an_mtext_keeps_its_line_spacing_style_and_flow(self):
        doc, _ = dwg_read.build_document(
            fake([ent(0x1A0, "MTEXT", insert=(0, 0, 0), raw_text="A\\PB", char_height=2.5, rect_width=0.0,
                      line_spacing_style=2, line_spacing_factor=1.5, drawing_direction=5)])
        )
        (m,) = list(doc.modelspace())
        self.assertEqual((m.dxf.line_spacing_style, m.dxf.line_spacing_factor, m.dxf.flow_direction), (2, 1.5, 5))
        self.assertFalse(m.dxf.hasattr("width"))

    def test_a_spline_fit_polyline_keeps_its_frame_out_of_the_bones(self):
        import cad  # noqa: PLC0415

        # Two control points (16) and three fitted vertices (8), as the reader
        # gives a spline-fit 2D polyline.
        pts = [(0, 0), (5, 9), (10, 0), (20, 0), (30, 0)]
        doc, _ = dwg_read.build_document(
            fake([ent(0x1B0, "POLYLINE_2D", points=pts, flags=4, curve_type=6, vertex_flags=[16, 16, 8, 8, 8])])
        )
        (pl,) = list(doc.modelspace())
        self.assertEqual((pl.dxf.flags & 4, pl.dxf.smooth_type), (4, 6))
        self.assertEqual([v.dxf.flags for v in pl.vertices], [16, 16, 8, 8, 8])
        # The bones draw the fitted vertices only: two segments, not four.
        index = cad.dwg_registry(doc, "ezdwg")
        self.assertEqual(len(index["segments"]), 2)

    def test_an_lwpolyline_keeps_its_linetype_generation(self):
        doc, _ = dwg_read.build_document(
            fake([ent(0x1C0, "LWPOLYLINE", points=[(0, 0), (5, 0), (5, 5)], closed=True, flags=129)])
        )
        (pl,) = list(doc.modelspace())
        self.assertEqual(pl.dxf.flags, 129)

    def test_a_block_cycle_is_cut_and_counted(self):
        doc, notes = dwg_read.build_document(
            fake(
                [ent(0x170, "INSERT", owner=0x90, insert=(0, 0, 0)), ent(0x171, "INSERT", owner=0x91, insert=(0, 0, 0)),
                 ent(0x172, "INSERT", insert=(0, 0, 0))],
                blocks=[(0x90, "A", None), (0x91, "B", None)],
                inserts={0x170: 0x91, 0x171: 0x90, 0x172: 0x90},
            )
        )
        inside = sum(len(list(doc.blocks.get(n))) for n in ("A", "B"))
        self.assertEqual(inside, 1)
        self.assertEqual(not_converted(notes), {("INSERT", "closes a cycle of blocks"): 1})
        self.assertEqual((notes["converted"], notes["gap"]), (2, 0))

    def test_a_file_whose_objects_cannot_be_listed_or_read_is_refused(self):
        with self.assertRaisesRegex(dwg_read.DwgRefused, "object list could not be read"):
            dwg_read.build_document(fake([line(0x180)], inventory=False))
        with self.assertRaisesRegex(dwg_read.DwgRefused, "decoded none of the 2 drawing objects"):
            dwg_read.build_document(fake([], extra=[(0x181, "LINE"), (0x182, "ARC")]))
        # An empty drawing is an empty document, not a refusal.
        doc, notes = dwg_read.build_document(fake([]))
        self.assertEqual((len(list(doc.modelspace())), notes["objects"]), (0, 0))


class CapabilityTests(unittest.TestCase):
    def test_the_one_rule_is_our_reader_function(self):
        self.assertTrue(dwg_read.reads_dwg(NS(raw=NS(decode_entity_proxy_graphics=lambda p, h: []))))
        self.assertFalse(dwg_read.reads_dwg(NS(raw=NS())))
        self.assertFalse(dwg_read.reads_dwg(NS()))

    def test_an_ezdwg_without_it_refuses_every_dwg_and_says_so(self):
        import cad  # noqa: PLC0415

        official = NS(raw=NS(), read=mock.Mock(side_effect=AssertionError("must not read")))
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "drawing.dwg")
            with open(src, "wb") as f:
                f.write(b"AC1032" + b"\x00" * 600)
            err = io.StringIO()
            with mock.patch.dict(sys.modules, {"ezdwg": official}), contextlib.redirect_stderr(err):
                self.assertEqual(cad.open_cad(src, tmp), (None, None, None))
                self.assertEqual(dwg_read.reader_state(), "missing")
        self.assertIn("(ezdwg: this ezdwg has no full reader", err.getvalue())

    @unittest.skipUnless(HAVE_EZDWG_MODULE and not HAVE_EZDWG, "needs an official ezdwg (CI's)")
    def test_the_official_ezdwg_refuses_the_sample_with_its_reason(self):
        import cad  # noqa: PLC0415

        err = io.StringIO()
        with tempfile.TemporaryDirectory() as tmp, contextlib.redirect_stderr(err):
            self.assertEqual(cad.open_cad(SAMPLE, tmp), (None, None, None))
        self.assertEqual(dwg_read.reader_state(), "missing")
        self.assertIn("(ezdwg: this ezdwg has no full reader", err.getvalue())

    def test_a_rust_panic_in_ezdwg_is_a_clean_failure_of_the_file(self):
        import cad  # noqa: PLC0415

        class PanicException(BaseException):
            pass

        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "drawing.dwg")
            with open(src, "wb") as f:
                f.write(b"AC1027" + b"\x00" * 600)
            err = io.StringIO()
            with mock.patch.object(dwg_read, "read", side_effect=PanicException("index out of bounds")), \
                    contextlib.redirect_stderr(err):
                self.assertEqual(cad.open_cad(src, tmp), (None, None, None))
        self.assertIn("(ezdwg: PanicException: index out of bounds)", err.getvalue())
        self.assertNotIn(tmp, err.getvalue())


@unittest.skipUnless(HAVE_EZDXF and HAVE_EZDWG and HAVE_MPL,
                     "needs our ezdwg build (CI has the official ezdwg): runs on the bench and in the parser image")
class SampleTests(unittest.TestCase):
    """The public sample through the real reader and the real render child."""

    def render(self):
        import cad  # noqa: PLC0415

        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(cad.dwg_render_worker(SAMPLE, tmp, 50), 0)
            self.assertTrue(os.path.isfile(os.path.join(tmp, "model.png")))
            with open(os.path.join(tmp, "index.json"), encoding="utf-8") as f:
                return json.load(f)

    def test_the_sample_reads_whole_with_its_skips_counted(self):
        index = self.render()
        self.assertEqual((index["converter"], index["version"], index["render_error"]), ("ezdwg", "AC1032", None))
        d = index["dwg"]
        self.assertEqual((d["objects"], d["converted"], d["not_converted_total"], d["gap"]), (345, 321, 24, 0))
        by_type: dict = {}
        for m in d["not_converted"]:
            by_type[m["type"]] = by_type.get(m["type"], 0) + m["count"]
        self.assertEqual(by_type, {"VIEWPORT": 6, "MLINE": 3, "TOLERANCE": 3, "3DSOLID": 2, "ACAD_TABLE": 2, "MESH": 2,
                                   "IMAGE": 1, "PDFUNDERLAY": 1, "RAY": 1, "REGION": 1, "SHAPE": 1, "XLINE": 1})
        self.assertEqual(index["counts"]["MULTILEADER"], 15)
        self.assertEqual(index["counts"]["WIPEOUT"], 1)
        self.assertEqual(index["counts"]["ATTRIB"], 4)

    def test_multileaders_take_their_saved_picture_and_their_text_is_indexed(self):
        index = self.render()
        self.assertEqual(index["dwg"]["facts"]["MULTILEADER with its saved picture"], 15)
        self.assertEqual(index["dwg"]["facts"]["MULTILEADER records not read for a saved picture"], 0)
        doc, _ = dwg_read.read(SAMPLE)
        labels = [e for e in doc.modelspace() if e.dxftype() == "MULTILEADER"]
        self.assertTrue(all(e.proxy_graphic for e in labels))
        from ezdxf.tools.text import plain_mtext  # noqa: PLC0415

        texts = {t["text"] for t in index["texts"]}
        wanted = {" ".join(plain_mtext(e.context.mtext.default_content).split()) for e in labels if e.context.mtext}
        self.assertTrue(wanted)
        self.assertLessEqual(wanted, texts)

    def test_a_multileader_with_no_saved_picture_is_drawn_by_ezdxf_and_counted(self):
        with mock.patch.object(ezdwg.raw, "decode_entity_proxy_graphics", side_effect=lambda p, hs: [(h, None) for h in hs]):
            index = self.render()
        self.assertEqual(index["dwg"]["facts"]["MULTILEADER with no saved picture (drawn by ezdxf)"], 15)
        self.assertEqual(index["counts"]["MULTILEADER"], 15)
        self.assertIsNone(index["render_error"])

    def test_the_crop_child_reads_the_same_document(self):
        import cad  # noqa: PLC0415

        with tempfile.TemporaryDirectory() as tmp:
            spec = os.path.join(tmp, "spec.json")
            with open(spec, "w", encoding="utf-8") as f:
                json.dump({"items": [{"id": "sheet", "kind": "view", "edge": 480}], "overview": False}, f)
            out = os.path.join(tmp, "out")
            os.mkdir(out)
            self.assertEqual(cad.dwg_crop_worker(SAMPLE, out, spec), 0)
            with open(os.path.join(out, "index.json"), encoding="utf-8") as f:
                self.assertEqual(json.load(f)["converter"], "ezdwg")

    def test_damaged_bytes_are_refused_cleanly(self):
        import cad  # noqa: PLC0415

        with open(SAMPLE, "rb") as f:
            whole = f.read()
        with tempfile.TemporaryDirectory() as tmp:
            for name, data in (("cut", whole[: len(whole) // 3]), ("magic", b"AC1032" + os.urandom(4096))):
                src = os.path.join(tmp, f"{name}.dwg")
                with open(src, "wb") as f:
                    f.write(data)
                err = io.StringIO()
                with contextlib.redirect_stderr(err):
                    got = cad.open_cad(src, tmp)
                if got[0] is None:
                    self.assertIn("no converter produced a parseable DXF (ezdwg:", err.getvalue(), name)
                else:
                    # A cut file the reader still reads: what it lost is counted.
                    self.assertEqual(got[1], "ezdwg")
                    self.assertGreaterEqual(got[2]["objects"], got[2]["converted"])


if __name__ == "__main__":
    unittest.main()
