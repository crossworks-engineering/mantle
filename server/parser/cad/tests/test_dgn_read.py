"""Tests for the DGN converter (dgn_read.py): element trees made by hand,
and V7 drawings this test writes with ezdgn's own V7 writer (never a real
drawing: the repo is public).

Run (stdlib unittest; the cases skip when ezdxf, ezdgn or matplotlib is
missing, unless PARSER_TESTS_REQUIRE_CAD is set):
    python3 -m venv /tmp/dgnvenv
    /tmp/dgnvenv/bin/pip install "ezdxf==1.4.5" "matplotlib==3.11.2" "ezdgn==0.3.2"
    /tmp/dgnvenv/bin/python -m unittest discover -s server/parser/cad/tests -v
"""

from __future__ import annotations

import contextlib
import io
import json
import math
import os
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import dgn_read  # noqa: E402
from dgn_read import Node  # noqa: E402

try:
    import ezdxf  # noqa: F401

    HAVE_EZDXF = True
except Exception:  # pragma: no cover - the venv case
    HAVE_EZDXF = False
    if os.environ.get("PARSER_TESTS_REQUIRE_CAD"):
        raise

try:
    import ezdgn  # noqa: F401

    HAVE_EZDGN = True
except Exception:  # pragma: no cover - the venv case
    HAVE_EZDGN = False
    if os.environ.get("PARSER_TESTS_REQUIRE_CAD"):
        raise

try:
    import matplotlib  # noqa: F401

    HAVE_MPL = True
except Exception:  # pragma: no cover - the venv case
    HAVE_MPL = False
    if os.environ.get("PARSER_TESTS_REQUIRE_CAD"):
        raise


def line(x1, y1, x2, y2, layer="PIPE"):
    return Node("LINE", layer, 3, {"pts": [(x1, y1, 0.0), (x2, y2, 0.0)]})


def text(s, x, y, layer="NOTES", h=2.5, rot=0.0):
    return Node("TEXT", layer, 17, {"text": s, "o": (x, y, 0.0), "h": h, "w": h, "rot": rot})


def cell(name, x, y, kids, layer="SYMBOLS"):
    return Node("CELL", layer, 2, {"name": name, "o": (x, y, 0.0), "rot": 0.0}, kids)


def model(top, name="Default", dimension=2, **kw):
    out = {"name": name, "dimension": dimension, "unit": "mm", "top": top,
           "records": None, "not_flat": 0, "wild_z": 0}
    out.update(kw)
    return out


def valve(x, y, tag=None):
    """A bow-tie valve cell in design coordinates, as DGN stores it."""
    kids = [line(x - 2, y - 1, x + 2, y + 1), line(x - 2, y + 1, x + 2, y - 1)]
    if tag:
        kids.append(text(tag, x - 2, y + 2))
    return cell("VALVE", x, y, kids)


@unittest.skipUnless(HAVE_EZDXF, "ezdxf not installed")
class BuildDocumentTests(unittest.TestCase):
    def build(self, top):
        return dgn_read.build_document([model(top)], {"format": "V8"})

    def test_a_cell_is_a_block_less_its_origin_and_an_insert_at_it(self):
        doc, info = self.build([valve(100.0, 50.0)])
        inserts = list(doc.modelspace().query("INSERT"))
        self.assertEqual(len(inserts), 1)
        self.assertEqual(inserts[0].dxf.name, "VALVE")
        self.assertEqual(tuple(inserts[0].dxf.insert)[:2], (100.0, 50.0))
        starts = sorted(tuple(e.dxf.start)[:2] for e in doc.blocks.get("VALVE"))
        self.assertEqual(starts, [(-2.0, -1.0), (-2.0, 1.0)])
        self.assertEqual(info["converted"], 3)
        self.assertEqual(info["elements"], 3)

    def test_the_same_cell_twice_shares_one_block_a_variant_gets_its_own(self):
        turned = cell("VALVE", 0.0, 0.0, [line(-1, -2, 1, 2), line(1, -2, -1, 2)])
        doc, _ = self.build([valve(10.0, 10.0), valve(40.0, 10.0), turned])
        names = sorted(e.dxf.name for e in doc.modelspace().query("INSERT"))
        self.assertEqual(names, ["VALVE", "VALVE", "VALVE#2"])

    def test_cell_texts_are_attribs_of_the_top_insert_where_they_stand(self):
        outer = cell("PUMP", 0.0, 0.0, [line(0, 0, 5, 0), valve(20.0, 0.0, tag="V-1"), text("P-1", 1, 1)])
        doc, info = self.build([outer])
        ref = next(iter(doc.modelspace().query("INSERT")))
        values = sorted((a.dxf.text, tuple(a.dxf.insert)[:2]) for a in ref.attribs)
        self.assertEqual(values, [("P-1", (1.0, 1.0)), ("V-1", (18.0, 2.0))])
        # No text inside a block: the registry reads attribs, not block text.
        for block in doc.blocks:
            if not block.name.startswith("*"):
                self.assertFalse(list(block.query("TEXT")))
        self.assertEqual(info["not_converted_total"], 0)

    def test_two_cells_with_one_geometry_and_other_tags_share_a_block(self):
        doc, _ = self.build([valve(0.0, 0.0, tag="V-1"), valve(50.0, 0.0, tag="V-2")])
        names = [e.dxf.name for e in doc.modelspace().query("INSERT")]
        self.assertEqual(names, ["VALVE", "VALVE"])

    def test_a_shared_cell_is_an_insert_with_no_geometry_and_is_counted(self):
        shared = Node("SHARED_CELL_INSTANCE", "SYMBOLS", 35, {"name": "GATE", "o": (5.0, 6.0, 0.0)})
        doc, info = self.build([shared])
        ref = next(iter(doc.modelspace().query("INSERT")))
        self.assertEqual((ref.dxf.name, tuple(ref.dxf.insert)[:2]), ("GATE", (5.0, 6.0)))
        self.assertEqual(len(doc.blocks.get("GATE")), 0)
        self.assertEqual(info["shared_cells_not_expanded"], 1)

    def test_every_element_not_converted_is_counted_by_kind_and_type(self):
        spline = Node("BSPLINE_CURVE", "L", 27, {}, [Node("UNKNOWN", "L", 26), Node("BSPLINE_POLE", "L", 21)])
        top = [
            line(0, 0, 10, 0),
            Node("UNKNOWN", "DIM", 33), Node("UNKNOWN", "DIM", 33),
            Node("UNKNOWN", "L", 37), Node("UNKNOWN", "L", 99), spline,
        ]
        _, info = self.build(top)
        got = {(m["kind"], m["type"]): (m["count"], m["name"]) for m in info["not_converted"]}
        self.assertEqual(got[("UNKNOWN", 33)], (2, "dimension"))
        self.assertEqual(got[("UNKNOWN", 37)], (1, "tag"))
        self.assertEqual(got[("UNKNOWN", 99)], (1, None))
        self.assertEqual(got[("BSPLINE_CURVE", 27)], (1, None))
        self.assertEqual(got[("UNKNOWN", 26)], (1, "bspline_knot"))
        self.assertEqual(got[("BSPLINE_POLE", 21)], (1, None))
        self.assertEqual(info["converted"], 1)
        self.assertEqual(info["elements"], info["converted"] + info["not_converted_total"])
        self.assertEqual(info["not_converted_total"], 7)

    def test_a_raster_frame_with_almost_nothing_else_is_stated_as_a_scan(self):
        top = [Node("UNKNOWN", "0", 94)] + [text("T", i, 0) for i in range(4)]
        _, info = self.build(top)
        self.assertTrue(info["raster_only"])
        self.assertEqual(info["raster_frames"], 1)
        self.assertIn("scanned image", info["note"])
        _, vector = self.build([Node("UNKNOWN", "0", 94)] + [line(i, 0, i, 1) for i in range(60)])
        self.assertFalse(vector["raster_only"])
        self.assertEqual(vector["raster_frames"], 1)

    def test_complex_shape_components_are_drawn(self):
        arc = Node("ARC", "L", 16, {"c": (5.0, 0.0, 0.0), "a": 5.0, "b": 5.0, "rot": 0.0,
                                     "start": 0.0, "sweep": 180.0})
        shape = Node("COMPLEX_SHAPE", "L", 14, {}, [line(0, 0, 10, 0), arc])
        doc, info = self.build([shape])
        self.assertEqual(sorted(e.dxftype() for e in doc.modelspace()), ["ARC", "LINE"])
        self.assertEqual(info["converted"], 3)

    def test_a_negative_sweep_is_the_same_arc_counter_clockwise(self):
        arc = Node("ARC", "L", 16, {"c": (0.0, 0.0, 0.0), "a": 2.0, "b": 2.0, "rot": 10.0,
                                     "start": 90.0, "sweep": -45.0})
        doc, _ = self.build([arc])
        e = next(iter(doc.modelspace()))
        self.assertAlmostEqual(e.dxf.start_angle, 55.0)
        self.assertAlmostEqual(e.dxf.end_angle, 100.0)

    def test_an_elliptical_arc_keeps_its_end_points(self):
        # b > a: DXF turns the long axis to the major one.
        g = {"c": (1.0, 2.0, 0.0), "a": 2.0, "b": 5.0, "rot": 30.0, "start": 20.0, "sweep": 100.0}
        doc, _ = self.build([Node("ARC", "L", 16, g)])
        e = next(iter(doc.modelspace()))
        self.assertEqual(e.dxftype(), "ELLIPSE")

        def dgn_point(t):
            r, t = math.radians(g["rot"]), math.radians(t)
            lx, ly = g["a"] * math.cos(t), g["b"] * math.sin(t)
            return (1.0 + lx * math.cos(r) - ly * math.sin(r), 2.0 + lx * math.sin(r) + ly * math.cos(r))

        for got, t in ((e.start_point, 20.0), (e.end_point, 120.0)):
            want = dgn_point(t)
            self.assertAlmostEqual(got[0], want[0], places=6)
            self.assertAlmostEqual(got[1], want[1], places=6)

    def quat_arc(self, q, start=0.0, sweep=90.0, a=3.0, b=3.0, kind="ARC"):
        axes = dgn_read.quat_axes(q)
        g = {"c": (1.0, 2.0, 5.0), "a": a, "b": b, "axes": axes, "start": start, "sweep": sweep}
        return Node(kind, "L", 16 if kind == "ARC" else 15, g), axes

    def assert_ends(self, e, g_axes, a, b, start, sweep):
        xa, ya = g_axes
        for got, t in ((e.start_point, start), (e.end_point, start + sweep)):
            t = math.radians(t)
            want = [(1.0, 2.0, 5.0)[k] + a * math.cos(t) * xa[k] + b * math.sin(t) * ya[k] for k in range(3)]
            for k in range(3):
                self.assertAlmostEqual(got[k], want[k], places=6)

    def test_a_3d_arc_turned_in_the_plan_is_a_plain_arc(self):
        h = math.radians(15.0)
        n, _ = self.quat_arc((math.cos(h), 0.0, 0.0, math.sin(h)), start=10.0, sweep=50.0)
        doc, _ = self.build([n])
        e = next(iter(doc.modelspace()))
        self.assertEqual(e.dxftype(), "ARC")
        # The rows rule: a quaternion turn of +30 degrees about Z puts the
        # local X axis at -30 degrees.
        self.assertAlmostEqual(e.dxf.start_angle % 360.0, 340.0)
        self.assertAlmostEqual(e.dxf.end_angle % 360.0, 30.0)

    def test_a_tilted_3d_arc_keeps_its_true_end_points(self):
        h = math.radians(30.0)
        for b in (3.0, 2.0, 4.0):
            n, axes = self.quat_arc((math.cos(h), math.sin(h), 0.0, 0.0), start=20.0, sweep=100.0, b=b)
            doc, _ = self.build([n])
            e = next(iter(doc.modelspace()))
            self.assertEqual(e.dxftype(), "ELLIPSE")
            self.assert_ends(e, axes, 3.0, b, 20.0, 100.0)

    def test_a_mirrored_3d_arc_keeps_its_end_points(self):
        n, axes = self.quat_arc((0.0, 1.0, 0.0, 0.0), start=10.0, sweep=60.0, b=2.0)
        doc, _ = self.build([n])
        e = next(iter(doc.modelspace()))
        # The ellipse runs the other way round: the same two end points.
        got = sorted([tuple(round(v, 6) for v in e.start_point), tuple(round(v, 6) for v in e.end_point)])
        xa, ya = axes
        want = sorted(
            tuple(round((1.0, 2.0, 5.0)[k] + 3.0 * math.cos(math.radians(t)) * xa[k]
                        + 2.0 * math.sin(math.radians(t)) * ya[k], 6) for k in range(3))
            for t in (10.0, 70.0)
        )
        self.assertEqual(got, want)

    def test_a_3d_text_with_no_decoded_turn_is_drawn_unturned_and_counted(self):
        g = {"text": "T-1", "o": (4.0, 5.0, 0.0), "h": 2.0, "w": 2.0, "rot": None}
        doc, info = self.build([Node("TEXT", "L", 17, g)])
        e = next(iter(doc.modelspace()))
        self.assertEqual((e.dxf.text, e.dxf.rotation), ("T-1", 0.0))
        self.assertEqual((info["text_turn_unknown"], info["converted"]), (1, 1))

    def test_a_curve_drops_its_two_slope_points_at_each_end(self):
        pts = [(float(i), float(i * i % 7), 0.0) for i in range(7)]
        doc, _ = self.build([Node("CURVE", "L", 11, {"pts": pts})])
        e = next(iter(doc.modelspace()))
        self.assertEqual(e.dxftype(), "SPLINE")
        self.assertEqual([tuple(p)[:2] for p in e.fit_points], [p[:2] for p in pts[2:-2]])

    def test_bad_geometry_is_counted_not_drawn(self):
        top = [
            Node("ARC", "L", 16, {"c": (0.0, 0.0, 0.0), "a": 0.0, "b": 0.0, "rot": 0.0, "start": 0.0, "sweep": 90.0}),
            Node("LINE", "L", 3, {"pts": [(0.0, 0.0, 0.0)]}),
            Node("TEXT", "L", 17, {"text": None, "o": (0.0, 0.0, 0.0), "h": 1.0, "w": 1.0, "rot": 0.0}),
        ]
        doc, info = self.build(top)
        self.assertEqual(len(doc.modelspace()), 0)
        self.assertEqual(info["not_converted_total"], 3)

    def test_mirrored_text_keeps_a_positive_height_and_a_mirror_flag(self):
        n = Node("TEXT", "L", 17, {"text": "AB", "o": (0.0, 0.0, 0.0), "h": -2.0, "w": 2.0, "rot": 0.0})
        doc, info = self.build([n])
        e = next(iter(doc.modelspace()))
        self.assertEqual((e.dxf.height, e.dxf.text_generation_flag), (2.0, 4))
        self.assertEqual(info["not_converted_total"], 0)

    def test_a_last_caret_survives_into_the_registry(self):
        import cad  # noqa: PLC0415

        doc, _ = self.build([text("R^", 0, 0), text("X^2", 0, 5), cell("C", 9, 9, [line(0, 0, 1, 1), text("Q^", 9, 9)])])
        index = cad.dwg_registry(doc, "ezdgn")
        self.assertEqual(sorted(t["text"] for t in index["texts"]), ["Q^", "R^", "X^2"])

    def test_level_names_with_dxf_bad_characters_become_layers(self):
        n = line(0, 0, 1, 1, layer=dgn_read._layer('A/B:"C"'))
        doc, _ = self.build([n])
        self.assertEqual(next(iter(doc.modelspace())).dxf.layer, "A_B__C_")
        self.assertIn("A_B__C_", doc.layers)
        self.assertEqual(dgn_read._layer(""), "0")

    def test_the_registry_and_bones_read_a_dgn_made_document(self):
        import cad  # noqa: PLC0415

        top = [line(0, 0, 50, 0), line(50, 0, 100, 0), valve(50.0, 0.0, tag="V-7"), text("NOTE 1", 0, 20)]
        doc, info = self.build(top)
        index = cad.dwg_registry(doc, "ezdgn")
        self.assertIsNone(index["geometry_error"])
        self.assertEqual(sorted(t["text"] for t in index["texts"]), ["NOTE 1", "V-7"])
        self.assertEqual([i["block"] for i in index["inserts"]], ["VALVE"])
        self.assertEqual(index["blocks"][0]["attribs"], {"TEXT1": "V-7"})
        self.assertGreaterEqual(len(index["segments"]), 2)
        json.dumps(index, allow_nan=False)

    # ── audit 1 ──

    def test_cell_names_that_differ_only_by_case_do_not_fail_the_file(self):
        # M2: ezdxf block names ignore case.
        small = cell("Valve", 0.0, 0.0, [line(0, 0, 1, 1)])
        big = cell("VALVE", 10.0, 0.0, [line(10, 0, 15, 5)])
        doc, info = self.build([small, big])
        names = sorted(e.dxf.name for e in doc.modelspace().query("INSERT"))
        self.assertEqual(names, ["VALVE#2", "Valve"])
        rows = {r["name"]: (r["placements"], r["blocks"]) for r in info["cells"]}
        self.assertEqual(rows, {"Valve": (1, ["Valve"]), "VALVE": (1, ["VALVE#2"])})
        # A name like a variant name, in other case: still its own block.
        top = [cell("A#2", 0.0, 0.0, [line(0, 0, 1, 1)]), cell("a", 0.0, 0.0, [line(0, 0, 2, 2)]),
               cell("a", 0.0, 0.0, [line(0, 0, 3, 3)])]
        doc, info = self.build(top)
        names = sorted(e.dxf.name for e in doc.modelspace().query("INSERT"))
        self.assertEqual(names, ["A#2", "a", "a#3"])

    def test_how_many_of_a_cell_counts_every_placement(self):
        # M5: a plain cell is not a shared definition, so two geometries
        # under one name keep two blocks; `cells` holds the true count.
        def gate(x, turned=False):
            kids = [line(x - 1, -2, x + 1, 2), line(x + 1, -2, x - 1, 2)] if turned else \
                   [line(x - 2, -1, x + 2, 1), line(x - 2, 1, x + 2, -1)]
            return cell("GATE", x, 0.0, kids)

        outer = cell("SKID", 0.0, 50.0, [line(0, 50, 9, 50), gate(5.0)])
        doc, info = self.build([gate(0.0), gate(10.0), gate(20.0, True), gate(30.0, True), outer])
        row = next(r for r in info["cells"] if r["name"] == "GATE")
        self.assertEqual((row["placements"], row["variants"], row["blocks"]), (5, 2, ["GATE", "GATE#2"]))
        self.assertEqual(info["cell_names"], 2)
        self.assertIn("`cells` gives the true count", info["note"])
        import cad  # noqa: PLC0415

        index = cad.dwg_registry(doc, "ezdgn")
        got = sorted(i["block"] for i in index["inserts"])
        self.assertEqual(got, ["GATE", "GATE", "GATE#2", "GATE#2", "SKID"])

    def test_wild_coordinates_are_counted_not_drawn(self):
        # L4: a finite but wild X or Y, a NaN and an inf never reach the
        # extents.
        top = [line(0, 0, 9e17, 1), line(0, 0, float("nan"), 1), text("T", float("inf"), 0),
               cell("C", 2e9, 0.0, [line(0, 0, 1, 1)]), line(0, 0, 1, 1)]
        doc, info = self.build(top)
        self.assertEqual([e.dxftype() for e in doc.modelspace()], ["LINE"])
        self.assertEqual((info["converted"], info["not_converted_total"]), (1, 5))

    def test_point_string_shape_two_point_string_and_a_text_with_a_line_break(self):
        import cad  # noqa: PLC0415

        top = [
            Node("POINT_STRING", "L", 22, {"pts": [(0.0, 0.0, 0.0), (1.0, 1.0, 0.0), (2.0, 0.0, 0.0)]}),
            Node("SHAPE", "L", 6, {"pts": [(0.0, 0.0, 0.0), (4.0, 0.0, 0.0), (4.0, 4.0, 0.0), (0.0, 0.0, 0.0)]}),
            Node("LINE_STRING", "L", 4, {"pts": [(0.0, 9.0, 0.0), (5.0, 9.0, 0.0)]}),
            text("FIRST\nSECOND", 0, 20),
        ]
        doc, info = self.build(top)
        kinds = sorted(e.dxftype() for e in doc.modelspace())
        self.assertEqual(kinds, ["LINE", "LWPOLYLINE", "POINT", "POINT", "POINT", "TEXT"])
        shape = next(iter(doc.modelspace().query("LWPOLYLINE")))
        self.assertTrue(shape.closed)
        self.assertEqual(len(shape), 3)  # the closing vertex is dropped
        index = cad.dwg_registry(doc, "ezdgn")
        self.assertEqual([t["text"] for t in index["texts"]], ["FIRST SECOND"])
        self.assertEqual(info["not_converted_total"], 0)

    def test_cells_nested_three_deep_take_each_offset_once(self):
        inner = cell("C", 120.0, 0.0, [line(120, 0, 121, 1)])
        middle = cell("B", 110.0, 0.0, [inner])
        outer = cell("A", 100.0, 0.0, [line(100, 0, 101, 0), middle])
        doc, _ = self.build([outer])
        ref = next(iter(doc.modelspace().query("INSERT")))
        self.assertEqual((ref.dxf.name, tuple(ref.dxf.insert)[:2]), ("A", (100.0, 0.0)))
        b_ref = next(iter(doc.blocks.get("A").query("INSERT")))
        self.assertEqual((b_ref.dxf.name, tuple(b_ref.dxf.insert)[:2]), ("B", (10.0, 0.0)))
        c_ref = next(iter(doc.blocks.get("B").query("INSERT")))
        self.assertEqual((c_ref.dxf.name, tuple(c_ref.dxf.insert)[:2]), ("C", (10.0, 0.0)))
        c_line = next(iter(doc.blocks.get("C")))
        self.assertEqual((tuple(c_line.dxf.start)[:2], tuple(c_line.dxf.end)[:2]), ((0.0, 0.0), (1.0, 1.0)))

    def test_children_under_a_leaf_kind_are_counted(self):
        # M3: a line or a shared cell instance has no components of its own.
        lone = line(0, 0, 1, 1)
        lone.kids = [text("UNDER", 0, 0)]
        shared = Node("SHARED_CELL_INSTANCE", "S", 35, {"name": "N", "o": (0.0, 0.0, 0.0)}, [line(0, 0, 2, 2)])
        doc, info = self.build([lone, shared])
        self.assertEqual(sorted(e.dxftype() for e in doc.modelspace()), ["INSERT", "LINE"])
        self.assertEqual((info["converted"], info["not_converted_total"], info["elements"]), (2, 2, 4))

    def test_a_dropped_3d_text_is_not_counted_as_turned(self):
        # L9: counted once, as not converted.
        g = {"text": "T", "o": (0.0, 0.0, 0.0), "h": 0.0, "w": 1.0, "rot": None}
        _, info = self.build([Node("TEXT", "L", 17, g)])
        self.assertEqual((info["text_turn_unknown"], info["not_converted_total"]), (0, 1))

    def test_a_3d_arc_with_no_turn_is_counted_not_drawn_flat(self):
        # L1: no rotation and no quaternion.
        g = {"c": (0.0, 0.0, 0.0), "a": 2.0, "b": 2.0, "rot": None, "start": 0.0, "sweep": 90.0}
        doc, info = self.build([Node("ARC", "L", 16, g)])
        self.assertEqual(len(doc.modelspace()), 0)
        self.assertEqual(info["not_converted_total"], 1)

    def test_a_full_tilted_3d_ellipse_with_b_over_a_keeps_its_axes(self):
        h = math.radians(30.0)
        n, (xa, ya) = self.quat_arc((math.cos(h), math.sin(h), 0.0, 0.0), a=3.0, b=5.0, kind="ELLIPSE")
        doc, _ = self.build([n])
        e = next(iter(doc.modelspace()))
        self.assertEqual(e.dxftype(), "ELLIPSE")
        tool = e.construction_tool()
        # DGN t = 0 and t = 90 degrees: c + a X and c + b Y.
        got = list(tool.vertices([1.5 * math.pi, 0.0]))
        for p, (k, axis) in zip(got, ((3.0, xa), (5.0, ya))):
            for j in range(3):
                self.assertAlmostEqual(p[j], (1.0, 2.0, 5.0)[j] + k * axis[j], places=6)

    def test_layer_names_change_only_where_ezdxf_refuses(self):
        # M1: the converter's rule is ezdxf's own rule, no more.
        from ezdxf.lldxf import validator  # noqa: PLC0415

        for code in range(0x3000):
            c = chr(code)
            refused = not validator.is_valid_layer_name(f"A{c}B")
            self.assertEqual(dgn_read._clean_name(f"A{c}B") != f"A{c}B", refused, hex(code))
        self.assertEqual(dgn_read._clean_name("A|B C\tD"), "A|B C\tD")

    def test_layer_names_that_differ_only_by_case_stay_apart_in_the_registry(self):
        # L8: one layer table entry, two layer names on the entities.
        import cad  # noqa: PLC0415

        doc, _ = self.build([line(0, 0, 1, 1, layer="Pipe"), line(0, 0, 2, 2, layer="PIPE")])
        index = cad.dwg_registry(doc, "ezdgn")
        self.assertEqual(sorted(layer["name"] for layer in index["layers"]), ["PIPE", "Pipe"])

    def test_open_cad_names_the_part_that_failed(self):
        # L7: a converter fault is not blamed on ezdgn; no ezdgn is a clean
        # refusal.
        import cad  # noqa: PLC0415

        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "drawing.dgn")
            with open(src, "wb") as f:
                f.write(dgn_read.CFB_MAGIC + b"\x00" * 600)
            err = io.StringIO()
            with mock.patch.dict(sys.modules, {"ezdgn": None}), contextlib.redirect_stderr(err):
                self.assertEqual(cad.open_cad(src, tmp), (None, None, None))
            self.assertIn("(ezdgn:", err.getvalue())
            err = io.StringIO()
            with mock.patch.object(dgn_read, "load", return_value=([model([line(0, 0, 1, 1)])], {"format": "V8"})), \
                    mock.patch.object(dgn_read, "build_document", side_effect=ValueError("boom")), \
                    contextlib.redirect_stderr(err):
                self.assertEqual(cad.open_cad(src, tmp), (None, None, None))
            self.assertIn("(DGN converter:", err.getvalue())

    def test_open_cad_reads_a_dxf_as_before(self):
        import cad  # noqa: PLC0415
        import ezdxf  # noqa: PLC0415

        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "drawing.dxf")
            d = ezdxf.new("R2010")
            d.modelspace().add_line((0, 0), (1, 1))
            d.saveas(src)
            doc, converter, notes = cad.open_cad(src, tmp)
            self.assertEqual((converter, notes), ("none", None))
            self.assertEqual([e.dxftype() for e in doc.modelspace()], ["LINE"])

    # ── audit 2 ──

    def test_dwg_bytes_take_the_dwg_chain_as_before(self):
        # DWG magic never reaches ezdgn: dwg2dxf converts it, as before.
        import cad  # noqa: PLC0415

        def dwg2dxf(args, **_kw):
            d = ezdxf.new("R2010")
            d.modelspace().add_line((0, 0), (2, 2))
            d.saveas(args[2])
            return mock.Mock(returncode=0)

        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "drawing.dwg")
            with open(src, "wb") as f:
                f.write(b"AC1032" + b"\x00" * 600)
            with mock.patch.object(dgn_read, "load", side_effect=AssertionError("DGN path")), \
                    mock.patch.object(cad.subprocess, "run", side_effect=dwg2dxf) as run:
                doc, converter, notes = cad.open_cad(src, tmp)
            self.assertEqual((converter, notes), ("dwg2dxf", None))
            self.assertEqual(run.call_args[0][0][0], "dwg2dxf")
            self.assertEqual([e.dxftype() for e in doc.modelspace()], ["LINE"])

    def test_a_rust_panic_in_ezdgn_is_a_clean_failure_of_the_file(self):
        # N3: pyo3's PanicException is a BaseException, not an Exception.
        import cad  # noqa: PLC0415

        class PanicException(BaseException):
            pass

        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "drawing.dgn")
            with open(src, "wb") as f:
                f.write(dgn_read.CFB_MAGIC + b"\x00" * 600)
            err = io.StringIO()
            with mock.patch.object(dgn_read, "load", side_effect=PanicException("index out of bounds")), \
                    contextlib.redirect_stderr(err):
                self.assertEqual(cad.open_cad(src, tmp), (None, None, None))
            self.assertIn("(ezdgn: PanicException: index out of bounds)", err.getvalue())
            for stop in (SystemExit(3), KeyboardInterrupt()):
                with mock.patch.object(dgn_read, "load", side_effect=stop), self.assertRaises(type(stop)):
                    cad.open_cad(src, tmp)

    def test_model_gaps_of_opposite_sign_do_not_cancel(self):
        # N2: one model counts a record twice (a converter fault, -1), the
        # other is exact; then two faulty models (-1 each) give 2, not -2.
        twice = line(0, 0, 1, 1)
        twice.i = 0
        one = model([twice, line(0, 0, 2, 2)], records=[("LINE", 3)])
        exact = model([line(0, 0, 3, 3)], name="Other", records=[("LINE", 3)])
        exact["top"][0].i = 0
        _, info = dgn_read.build_document([one, exact], {"format": "V8"})
        self.assertEqual([m.get("gap") for m in info["models"]], [-1, 0])
        self.assertEqual(info["gap"], 1)
        _, info = dgn_read.build_document([one, dict(one, name="Again")], {"format": "V8"})
        self.assertEqual(info["gap"], 2)
        self.assertIn("differs from ezdgn's record count by 2", info["note"])

    def test_a_wild_text_width_is_the_plain_width(self):
        # N5: a width past WILD does not blow up the text box.
        g = {"text": "T-1", "o": (0.0, 0.0, 0.0), "h": 2.0, "w": 1e300, "rot": 0.0}
        doc, info = self.build([Node("TEXT", "L", 17, g)])
        t = next(iter(doc.modelspace()))
        self.assertEqual((t.dxf.width, t.dxf.text_generation_flag), (1.0, 0))
        g = dict(g, w=-4.0)
        doc, _ = self.build([Node("TEXT", "L", 17, g)])
        t = next(iter(doc.modelspace()))
        self.assertEqual((t.dxf.width, t.dxf.text_generation_flag), (2.0, 2))

    def test_a_cell_with_no_name_is_an_anonymous_block_ezdxf_takes(self):
        doc, info = self.build([cell("", 5.0, 0.0, [line(5, 0, 6, 1)]), cell("  ", 9.0, 0.0, [line(9, 0, 9, 2)])])
        names = sorted(e.dxf.name for e in doc.modelspace().query("INSERT"))
        self.assertEqual(len(names), 2)
        for name in names:
            self.assertTrue(name.startswith("*U"), name)
            self.assertEqual(len(doc.blocks.get(name)), 1)
        self.assertEqual(info["not_converted_total"], 0)

    def test_block_names_change_only_where_ezdxf_refuses(self):
        # The block name rule is ezdxf's own rule, as for layers.
        from ezdxf.lldxf import validator  # noqa: PLC0415

        for code in range(0x3000):
            c = chr(code)
            refused = not validator.is_valid_block_name(f"A{c}B")
            self.assertEqual(dgn_read._clean_name(f"A{c}B") != f"A{c}B", refused, hex(code))
        walker = dgn_read._Ops()
        name = walker.block_name("V/1:" + "X" * 300)
        doc = ezdxf.new("R2010")
        doc.blocks.new(name)  # a long name is taken as it is
        self.assertEqual(name, "V_1_" + "X" * 300)


# ── a stand-in V8 document ─────────────────────────────────────────────
# ezdgn's V7 writer makes 2D files only, and the repo holds no client file,
# so the 3D and the several-models cases use plain objects in the shape of
# ezdgn 0.3.2's V8Document (models, levels, elements with kind, data,
# common, raw, parent_index, child_indices). What this does not test: that
# ezdgn fills those fields the same way from a real file.

from types import SimpleNamespace as NS  # noqa: E402


def v8_data(**kw):
    base = dict(vertices=(), center=None, origin=None, text=None, height_master=None,
                width_master=None, name=None, rotation_degrees=0.0, orientation=(),
                primary_axis_master=None, secondary_axis_master=None,
                start_angle_degrees=None, sweep_angle_degrees=None)
    base.update(kw)
    return NS(**base)


def pt(x, y, z=0.0):
    return NS(master=(x, y, z))


def v8_el(kind, level, data, z=(0.0, 0.0), etype=3, parent=None, kids=(), raw=None, eid=None, aux=()):
    rng = ((0.0, 0.0, z[0]), (1.0, 1.0, z[1]))
    return NS(kind=kind, level=level, data=data, common=NS(range_master=rng, element_id=eid),
              raw=raw or NS(element_type=etype), parent_index=parent, child_indices=tuple(kids),
              auxiliary_records=tuple(aux))


def v8_line(level, x1, y1, x2, y2, parent=None):
    return v8_el("LINE", level, v8_data(vertices=(pt(x1, y1), pt(x2, y2))), parent=parent)


def name_linkage(name: str) -> bytes:
    """A name linkage in the layout ezdgn's own decoder reads: a header word
    (length in words less one), the signature, a version, the payload
    length, then the payload."""
    from ezdgn import v8  # noqa: PLC0415

    payload = name.encode("ascii")
    body = (b"\x00\x00" + v8.NAME_LINKAGE_SIGNATURE.to_bytes(2, "little") + b"\x00" * 4
            + len(payload).to_bytes(4, "little") + payload)
    body += b"\x00" * (-len(body) % 2)
    body = (len(body) // 2 - 1).to_bytes(2, "little") + body[2:]
    return body


def v8_model(name, dimension, elements):
    return NS(metadata=NS(name=name, dimension=dimension, master_unit="mm", uor_per_master=1000.0),
              elements=elements)


def v8_doc(models, levels=(), objects=None, skipped=()):
    """A stand-in V8Document. `raw` holds ezdgn's own scan counts: by
    default the graphical objects are the records the models give, as
    ezdgn 0.3.2 makes them (one element a graphical object)."""
    if objects is None:
        objects = sum(len(m.elements) for m in models)
    return NS(models=tuple(models), levels=list(levels),
              raw=NS(graphical_object_count=objects, skipped_models=tuple(skipped)))


@unittest.skipUnless(HAVE_EZDXF, "ezdxf not installed")
class V8StandInTests(unittest.TestCase):
    def doc(self):
        h = math.radians(15.0)
        model_3d = [
            v8_el("LINE", 1, v8_data(vertices=(pt(0, 0, 1.5), pt(50, 0, -1.5))), z=(-1.5, 1.5)),
            v8_el("LINE", 1, v8_data(vertices=(pt(50, 0), pt(100, 0)))),
            v8_el("LINE", 2, v8_data(vertices=(pt(0, 10), pt(100, 10)))),
            v8_el("ARC", 2, v8_data(center=pt(10, 20, 7.0), primary_axis_master=2.0,
                                    secondary_axis_master=2.0, start_angle_degrees=0.0,
                                    sweep_angle_degrees=90.0, rotation_degrees=None,
                                    orientation=(math.cos(h), 0.0, 0.0, math.sin(h))), etype=16),
            v8_el("TEXT", 3, v8_data(text="C-101", origin=pt(5, 12, 0.5), height_master=2.0,
                                     width_master=2.0, rotation_degrees=None,
                                     orientation=(52.0, 5.0, -1.0, 0.0, 0.0, 0.0)), etype=17),
            v8_el("UNKNOWN", 1, v8_data(), z=(9e17, 9e17), etype=26),
        ]
        sheet = [
            v8_el("LINE", 1, v8_data(vertices=(pt(0, 0), pt(420, 0)))),
            v8_el("TEXT", 3, v8_data(text="SHEET NOTE", origin=pt(10, 10), height_master=3.0,
                                     width_master=3.0), etype=17),
        ]
        levels = [NS(level_id=1, name="Circuit C-101"), NS(level_id=2, name="Circuit  C-101-DL"),
                  NS(level_id=3, name="Notes")]
        return v8_doc((v8_model("Model", 3, model_3d), v8_model("Sheet", 2, sheet),
                       v8_model("Layout", 3, [])), levels)

    def build(self, source):
        models, facts = dgn_read._v8_tree(source)
        return dgn_read.build_document(models, facts)

    def test_a_3d_model_is_drawn_in_plan_and_its_z_is_counted(self):
        doc, info = self.build(self.doc())
        msp = doc.modelspace()
        self.assertEqual(sorted(e.dxftype() for e in msp), ["ARC", "LINE", "LINE", "LINE", "TEXT"])
        for e in msp.query("LINE"):
            self.assertEqual((e.dxf.start[2], e.dxf.end[2]), (0.0, 0.0))
        arc = next(iter(msp.query("ARC")))
        self.assertEqual(arc.dxf.center[2], 0.0)
        self.assertAlmostEqual(arc.dxf.start_angle % 360.0, 330.0)
        self.assertEqual(info["dimension"], 3)
        self.assertEqual((info["not_flat"], info["wild_z"]), (1, 1))
        # The text's quaternion (the last four of its six orientation
        # values) is (-1, 0, 0, 0): no turn, and known.
        self.assertEqual(info["text_turn_unknown"], 0)
        self.assertAlmostEqual(next(iter(msp.query("TEXT"))).dxf.rotation, 0.0)
        self.assertIn("3D, drawn in plan", info["note"])

    def test_every_model_is_converted_and_kept_apart_an_empty_one_is_listed(self):
        doc, info = self.build(self.doc())
        listed = [(m["index"], m["name"], m["space"], m["elements"]) for m in info["models"]]
        self.assertEqual(listed, [(0, "Model", "model", 6), (1, "Sheet", "block", 2), (2, "Layout", "empty", 0)])
        sheet = doc.blocks.get(info["models"][1]["block"])
        self.assertEqual(sorted(e.dxftype() for e in sheet), ["LINE", "TEXT"])
        self.assertNotIn("SHEET NOTE", [e.dxf.text for e in doc.modelspace().query("TEXT")])
        self.assertEqual(info["elements"], 8)
        self.assertEqual(info["elements"], info["converted"] + info["not_converted_total"])
        self.assertIn("1 more models", info["note"])

    def test_an_empty_first_model_gives_the_drawing_to_the_next(self):
        source = self.doc()
        source = v8_doc((v8_model("Empty", 2, []),) + source.models[1:2], source.levels)
        doc, info = self.build(source)
        self.assertEqual([m["space"] for m in info["models"]], ["empty", "model"])
        self.assertEqual(sorted(e.dxftype() for e in doc.modelspace()), ["LINE", "TEXT"])

    def test_level_names_stay_exact_and_circuits_come_out(self):
        import cad  # noqa: PLC0415

        doc, _ = self.build(self.doc())
        layers = {e.dxf.layer for e in doc.modelspace()}
        self.assertEqual(layers, {"Circuit C-101", "Circuit  C-101-DL", "Notes"})
        index = cad.dwg_registry(doc, "ezdgn")
        self.assertIsNone(index["geometry_error"])
        self.assertGreaterEqual(len(index["circuits"]), 1)

    def test_shared_cell_instances_and_names_are_counted(self):
        top = [Node("SHARED_CELL_INSTANCE", "S", 35, {"name": n, "o": (float(i), 0.0, 0.0)})
               for i, n in enumerate(["LN", "LN", "LN", "7", "8"])]
        _, info = dgn_read.build_document([model(top)], {"format": "V8"})
        self.assertEqual((info["shared_cells_not_expanded"], info["shared_cell_names"]), (5, 3))

    # ── audit 1 ──

    @unittest.skipUnless(HAVE_EZDGN, "ezdgn not installed")
    def test_every_record_is_counted_once_against_ezdgns_count(self):
        # M3: unreached, repeated and leaf children; a V8 cell, chain and
        # text node through the tree; a cell name from its name linkage.
        cell_raw = NS(element_type=2, attribute_bytes=name_linkage("BOX-A"))
        els = [
            v8_line(1, 0, 0, 1, 0),                                                      # 0
            v8_el("CELL", 1, v8_data(origin=pt(10, 10)), etype=2, kids=(2, 3), raw=cell_raw),  # 1
            v8_line(1, 10, 10, 11, 10, parent=1),                                        # 2
            v8_line(1, 10, 10, 10, 11, parent=1),                                        # 3
            v8_el("COMPLEX_CHAIN", 1, v8_data(), etype=12, kids=(5, 3)),                 # 4: 3 again
            v8_line(1, 20, 0, 21, 0, parent=4),                                          # 5
            v8_line(1, 30, 0, 31, 0, parent=99),                                         # 6: unreached
            v8_el("TEXT_NODE", 1, v8_data(origin=pt(0, 5)), etype=7, kids=(8,)),         # 7
            v8_el("TEXT", 1, v8_data(text="NODE LINE", origin=pt(0, 5), height_master=1.0,
                                     width_master=1.0), etype=17, parent=7),             # 8
            v8_el("LINE", 1, v8_data(vertices=(pt(0, 9), pt(1, 9))), kids=(10,)),        # 9
            v8_el("TEXT", 1, v8_data(text="UNDER", origin=pt(0, 9), height_master=1.0,
                                     width_master=1.0), etype=17, parent=9),             # 10: leaf kid
        ]
        source = v8_doc((v8_model("Model", 2, els),), [NS(level_id=1, name="Work")])
        doc, info = self.build(source)
        self.assertEqual((info["records"], info["elements"], info["gap"]), (11, 11, 0))
        self.assertEqual((info["converted"], info["not_converted_total"]), (9, 2))
        self.assertEqual((info["unreached"], info["repeated"]), (1, 1))
        self.assertIn("1 element records are under no drawn element", info["note"])
        self.assertEqual(len(doc.modelspace().query("LINE")), 3)  # 0, 5 and 9; 3 is in the cell
        ref = next(iter(doc.modelspace().query("INSERT")))
        self.assertEqual((ref.dxf.name, tuple(ref.dxf.insert)[:2]), ("BOX-A", (10.0, 10.0)))
        self.assertEqual(len(doc.blocks.get("BOX-A")), 2)
        self.assertEqual([e.dxf.text for e in doc.modelspace().query("TEXT")], ["NODE LINE"])

    def test_components_past_the_depth_limit_are_counted(self):
        els = [
            v8_el("CELL", 1, v8_data(origin=pt(0, 0)), etype=2, kids=(1,)),
            v8_el("CELL", 1, v8_data(origin=pt(0, 0)), etype=2, kids=(2,), parent=0),
            v8_line(1, 0, 0, 1, 1, parent=1),
        ]
        source = v8_doc((v8_model("Model", 2, els),))
        with mock.patch.object(dgn_read, "MAX_DEPTH", 1):
            _, info = self.build(source)
        self.assertEqual((info["records"], info["elements"], info["unreached"]), (3, 3, 1))
        self.assertEqual(info["not_converted"], [{"kind": "LINE", "type": 3, "name": None, "count": 1}])

    def test_the_model_with_the_most_content_is_the_drawing(self):
        # M4: a model with one raster frame does not take model space, and
        # what the other models hold is stated, per model.
        import cad  # noqa: PLC0415

        frame = [v8_el("UNKNOWN", 1, v8_data(), etype=94),
                 v8_el("TEXT", 1, v8_data(text="FRAME NOTE", origin=pt(0, 0), height_master=1.0,
                                          width_master=1.0), etype=17)]
        drawing = [v8_line(1, 0, 0, 10, 0), v8_line(1, 10, 0, 10, 10), v8_line(1, 10, 10, 0, 10),
                   v8_el("TEXT", 1, v8_data(text="PLAN NOTE", origin=pt(1, 1), height_master=1.0,
                                            width_master=1.0), etype=17)]
        source = v8_doc((v8_model("Frame", 2, frame), v8_model("Plan", 2, drawing)))
        doc, info = self.build(source)
        spaces = [(m["space"], m["elements"], m["texts"]) for m in info["models"]]
        self.assertEqual(spaces, [("block", 2, 1), ("model", 4, 1)])
        index = cad.dwg_registry(doc, "ezdgn")
        self.assertEqual([t["text"] for t in index["texts"]], ["PLAN NOTE"])
        self.assertIn("their 2 elements, of them 1 texts, are not in the registry", info["note"])

    def test_a_cell_named_like_a_model_block_keeps_both(self):
        first = [v8_line(1, 0, 0, 1, 1), v8_line(1, 0, 0, 2, 2),
                 v8_el("CELL", 1, v8_data(origin=pt(0, 0), name="MODEL 1 Sheet"), etype=2, kids=(3,)),
                 v8_line(1, 0, 0, 3, 3, parent=2)]
        sheet = [v8_line(1, 0, 0, 5, 5)]
        source = v8_doc((v8_model("Model", 2, first), v8_model("Sheet", 2, sheet)))
        doc, info = self.build(source)
        self.assertEqual(next(iter(doc.modelspace().query("INSERT"))).dxf.name, "MODEL 1 Sheet")
        self.assertEqual(info["models"][1]["block"], "MODEL 1 Sheet#2")
        end = next(iter(doc.blocks.get("MODEL 1 Sheet#2"))).dxf.end
        self.assertEqual(tuple(end)[:2], (5.0, 5.0))

    def test_a_renamed_circuit_level_is_listed_with_its_layer(self):
        # M1: "/" is refused in a layer name. The circuit row carries the
        # layer's name (the stated limit), and the index lists the level.
        import cad  # noqa: PLC0415

        els = [v8_line(1, 0, 0, 50, 0), v8_line(1, 50, 0, 100, 0), v8_line(2, 0, 9, 1, 9), v8_line(12, 0, 8, 1, 8)]
        levels = [NS(level_id=1, name="Circuit Q9/Z-1"), NS(level_id=2, name="12")]
        source = v8_doc((v8_model("Model", 2, els),), levels)
        doc, info = self.build(source)
        changed = sorted((c["level"], c["layer"]) for c in info["levels_changed"])
        self.assertEqual(changed, [("12", "12"), ("12", "12"), ("Circuit Q9/Z-1", "Circuit Q9_Z-1")])
        self.assertEqual(info["levels_changed_total"], 3)
        self.assertIn("1 levels are renamed", info["note"])
        self.assertIn("2 levels share one layer name", info["note"])
        index = cad.dwg_registry(doc, "ezdgn")
        self.assertEqual([c["circuit"] for c in index["circuits"]], ["Q9_Z-1"])

    # ── audit 2 ──

    def test_skipped_models_and_ezdgns_object_count_are_stated(self):
        # N1: a model ezdgn skips, and graphical objects ezdgn found but
        # gave no element record for, never pass without a word.
        els = [v8_line(1, 0, 0, 1, 1), v8_line(1, 0, 0, 2, 2)]
        source = v8_doc((v8_model("Model", 2, els),), objects=5, skipped=("/Dgn-Md/#000002/Dgn~Mh",))
        _, info = self.build(source)
        self.assertEqual((info["records"], info["ezdgn_objects"], info["reader_gap"]), (2, 5, 3))
        self.assertEqual(info["skipped_models"], ["/Dgn-Md/#000002/Dgn~Mh"])
        self.assertIn("ezdgn found 5 graphical objects in the file but gave 2 element records: 3 are"
                      " not read", info["note"])
        self.assertIn("lists 1 more models whose content is not in the file", info["note"])
        # Counts that agree and nothing skipped: no word.
        _, info = self.build(v8_doc((v8_model("Model", 2, els),)))
        self.assertEqual((info["reader_gap"], info["skipped_models"], info["note"]), (0, [], None))

    def test_a_cell_in_a_model_kept_apart_is_not_counted_in_the_drawing(self):
        # N6: `placements` is the drawing's count; other models apart.
        def gate(x, parent_at):
            return [v8_el("CELL", 1, v8_data(origin=pt(x, 0), name="GATE"), etype=2, kids=(parent_at + 1,)),
                    v8_line(1, x, 0, x + 1, 1, parent=parent_at)]

        drawing = gate(0, 0) + gate(10, 2) + [v8_line(1, 0, 5, 9, 5)]
        sheet = gate(0, 0)
        _, info = self.build(v8_doc((v8_model("Model", 2, drawing), v8_model("Sheet", 2, sheet))))
        row = next(r for r in info["cells"] if r["name"] == "GATE")
        self.assertEqual((row["placements"], row["other_models"]), (2, 1))

    def test_a_3d_model_kept_apart_still_gets_the_3d_note(self):
        # N7: the drawing is 2D; a model kept apart is 3D and not flat.
        drawing = [v8_line(1, 0, 0, 1, 1), v8_line(1, 0, 0, 2, 2)]
        solid = [v8_el("LINE", 1, v8_data(vertices=(pt(0, 0, 0.0), pt(1, 0, 5.0))), z=(0.0, 5.0))]
        _, info = self.build(v8_doc((v8_model("Model", 2, drawing), v8_model("Solid", 3, solid))))
        self.assertEqual((info["dimension"], info["not_flat"]), (2, 1))
        self.assertIn("3D, drawn in plan (top view): 1 elements are not flat in Z", info["note"])

    def test_a_level_named_only_spaces_shows_by_its_number(self):
        # N8: like a level with no name; leading and trailing spaces of a
        # real name stay.
        els = [v8_line(7, 0, 0, 1, 1), v8_line(8, 0, 0, 2, 2)]
        levels = [NS(level_id=7, name="   "), NS(level_id=8, name=" Pipe ")]
        doc, info = self.build(v8_doc((v8_model("Model", 2, els),), levels))
        self.assertEqual(sorted(e.dxf.layer for e in doc.modelspace()), [" Pipe ", "7"])
        self.assertEqual(info["levels_changed"], [])

    def test_a_3d_arc_with_a_rotation_and_a_quaternion_takes_the_quaternion(self):
        # L1: ezdgn 0.3.2 gives a 3D arc the quaternion and no rotation (all
        # 3D arcs of the private test set); were both given, the quaternion
        # holds the whole turn and wins.
        h = math.radians(15.0)
        arc = v8_el("ARC", 1, v8_data(center=pt(10, 20), primary_axis_master=2.0, secondary_axis_master=2.0,
                                      start_angle_degrees=0.0, sweep_angle_degrees=90.0, rotation_degrees=80.0,
                                      orientation=(math.cos(h), 0.0, 0.0, math.sin(h))), etype=16)
        doc, _ = self.build(v8_doc((v8_model("Model", 3, [arc]),)))
        e = next(iter(doc.modelspace()))
        self.assertAlmostEqual(e.dxf.start_angle % 360.0, 330.0)  # as without the rotation

    def test_nan_inf_and_wild_points_from_ezdgn_are_counted_not_drawn(self):
        els = [v8_line(1, 0, 0, float("nan"), 1), v8_line(1, float("inf"), 0, 1, 1), v8_line(1, 0, 0, 5e9, 1),
               v8_el("TEXT", 1, v8_data(text="T", origin=pt(0, -3e9), height_master=1.0, width_master=1.0),
                     etype=17),
               v8_line(1, 0, 0, 1, 1)]
        doc, info = self.build(v8_doc((v8_model("Model", 2, els),)))
        self.assertEqual([e.dxftype() for e in doc.modelspace()], ["LINE"])
        self.assertEqual((info["converted"], info["not_converted_total"], info["gap"]), (1, 4, 0))

    def test_a_3d_text_turns_by_the_quaternion_it_stores(self):
        # Six orientation values: two of size, then the quaternion (w, x,
        # y, z). ezdgn 0.3.2 gives them too, so this needs no data reader.
        h = math.radians(15.0)
        turned = v8_el("TEXT", 1, v8_data(text="T", origin=pt(0, 0), height_master=1.0, width_master=1.0,
                                          rotation_degrees=None,
                                          orientation=(2.0, 3.0, math.cos(h), 0.0, 0.0, math.sin(h))), etype=17)
        q = math.sqrt(0.5)
        tilted = v8_el("TEXT", 1, v8_data(text="U", origin=pt(0, 0), height_master=1.0, width_master=1.0,
                                          rotation_degrees=None, orientation=(2.0, 3.0, q, q, 0.0, 0.0)), etype=17)
        doc, info = self.build(v8_doc((v8_model("Model", 3, [turned, tilted]),)))
        rot = {e.dxf.text: e.dxf.rotation for e in doc.modelspace().query("TEXT")}
        # The row rule, as for a 3D arc: a half angle of 15 degrees about
        # Z is a turn of -30 degrees.
        self.assertAlmostEqual(rot["T"], -30.0)
        self.assertEqual(rot["U"], 0.0)  # tilted out of the plan: unturned, counted
        self.assertEqual(info["text_turn_unknown"], 1)


# ── the data reader: item data, tags and shared cell definitions ─────────
# An ezdgn build with the data reader gives these; ezdgn 0.3.2 does not.
# Stand-ins in the shape of that build's API (tag sets, definitions with
# `matches`, auxiliary records with entries); the item decoder is patched.
# Names and values are made up.

RNG = (0.0, 0.0, 0.0, 10.0, 10.0, 0.0)
IDENT = (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)


class V8Doc:
    """A stand-in V8Document with tag sets; counts how often they are read
    (ezdgn decodes every set on each read)."""

    def __init__(self, models, tag_sets=()):
        self.models = tuple(models)
        self.levels = []
        self.raw = NS(graphical_object_count=sum(len(m.elements) for m in models), skipped_models=())
        self._sets = tuple(tag_sets)
        self.tag_set_reads = 0

    @property
    def tag_sets(self):
        self.tag_set_reads += 1
        return self._sets


def tag_set(eid, *defs):
    return NS(element_id=eid, definitions=tuple(NS(tag_id=i, name=n) for i, n in defs))


def v8_tag(value, set_eid=None, tag_id=None, host=None, origin=None, parent=None):
    return v8_el("TAG", 1, v8_data(value=value, tag_set_element_id=set_eid, tag_id=tag_id,
                                   host_element_id=host, origin=origin), etype=37, parent=parent)


def v8_inst(name, x, y, rng=RNG, m=IDENT, eid=None, aux=(), parent=None):
    return v8_el("SHARED_CELL_INSTANCE", 1, v8_data(name=name, origin=pt(x, y), transform=tuple(rng) + tuple(m)),
                 etype=35, eid=eid, aux=aux, parent=parent)


def v8_def(name, components, rng=RNG):
    """A definition as ezdgn gives it: the header (index 0) and its
    components (parent 0), in its own space."""
    header = v8_el("SHARED_CELL_DEFINITION", 1, v8_data(), etype=34, kids=range(1, len(components) + 1))
    d = NS(name=name, range_values=tuple(rng), elements=(header, *components))
    d.matches = lambda e: e.data.name == name and tuple(e.data.transform[:6]) == tuple(rng)
    return d


def item_aux(*items):
    """One auxiliary record: an entry per item (None: one that does not
    decode), and one entry of another type."""
    entries = [NS(type_id=0x56FF0000, item=it) for it in items] + [NS(type_id=0x57050000, item=None)]
    return (NS(entries=tuple(entries)),)


def fake_decode(entry):
    return entry.item


THING = NS(class_name="Thing", schema_reference="Things.01.00",
           properties=(("ALPHA", "A-1"), ("BETA", ""), ("GAMMA", "7")))


def two_build_doc(dimension: int):
    """One stand-in of every kind the converter reads, item data and a tag
    element included (0.3.2 gives a tag as UNKNOWN, type 37)."""
    h = math.radians(20.0)
    els = [
        v8_line(1, 0, 0, 50, 0),
        v8_el("LINE_STRING", 1, v8_data(vertices=(pt(0, 0), pt(10, 5), pt(20, 0)))),
        v8_el("ARC", 2, v8_data(center=pt(10, 20, 1.0), primary_axis_master=2.0, secondary_axis_master=2.0,
                                start_angle_degrees=0.0, sweep_angle_degrees=90.0,
                                **({"rotation_degrees": None, "orientation": (math.cos(h), 0.0, 0.0, math.sin(h))}
                                   if dimension == 3 else {"rotation_degrees": 30.0})), etype=16),
        v8_el("TEXT", 3, v8_data(text="NOTE 1", origin=pt(5, 12), height_master=2.0, width_master=2.0,
                                 **({"rotation_degrees": None,
                                     "orientation": (2.0, 3.0, math.cos(h), 0.0, 0.0, math.sin(h))}
                                    if dimension == 3 else {"rotation_degrees": 15.0})), etype=17),
        v8_el("CELL", 1, v8_data(name="BOX", origin=pt(100, 100)), etype=2, kids=(5, 6)),
        v8_line(1, 99, 99, 101, 101, parent=4),
        v8_el("TEXT", 3, v8_data(text="IN BOX", origin=pt(100, 102), height_master=1.0, width_master=1.0),
              etype=17, parent=4),
        v8_inst("GLYPH", 50, 60, eid=7, aux=item_aux(THING)),
        v8_el("UNKNOWN", 1, v8_data(), etype=37),
    ]
    return v8_doc((v8_model("Model", dimension, els),), [NS(level_id=1, name="Pipe"), NS(level_id=3, name="Notes")])


def _entity_row(e, text_turn: bool):
    a = {k: v for k, v in e.dxfattribs().items() if k not in ("handle", "owner")}
    if not text_turn and e.dxftype() in ("TEXT", "ATTRIB"):
        a.pop("rotation", None)
    row = [e.dxftype(), sorted((k, repr(v)) for k, v in a.items())]
    if e.dxftype() == "INSERT":
        row.append([_entity_row(x, text_turn) for x in e.attribs])
    return row


def doc_digest(doc, text_turn: bool = True) -> str:
    """Every entity of every block and of model space, by its DXF attributes."""
    import hashlib  # noqa: PLC0415

    h = hashlib.sha256()
    for block in doc.blocks:
        h.update(repr((block.name, [_entity_row(e, text_turn) for e in block])).encode())
    h.update(repr([_entity_row(e, text_turn) for e in doc.modelspace()]).encode())
    return h.hexdigest()


def output_depth(doc) -> int:
    """How deep the inserts of model space go, block in block."""
    def depth(name, seen=()):
        if name in seen:
            return 99
        block = doc.blocks.get(name)
        inner = [depth(e.dxf.name, (*seen, name)) for e in block.query("INSERT")] if block else []
        return 1 + max(inner, default=0)
    return max((depth(e.dxf.name) for e in doc.modelspace().query("INSERT")), default=0)


def facts_digest(info: dict, *leave_out: str) -> str:
    import hashlib  # noqa: PLC0415

    kept = {k: v for k, v in info.items() if k not in leave_out}
    return hashlib.sha256(json.dumps(kept, sort_keys=True, default=str).encode()).hexdigest()


# From the converter of v0.600.0 on these stand-ins, with this ezdxf. They
# pin the two-build claim (with ezdgn 0.3.2 a 2D file converts as before,
# and a 3D file differs only in its 3D texts' turn). An ezdxf bump changes
# the repr of the DXF attributes, so they hold for that version only; how
# to rebuild them: tests/two_build_digests.py.
TWO_BUILD_EZDXF = "1.4.5"
MAIN_2D_DOC = "8370ec24de6359223ae335e90b8a0f090d1fc82c9f3a66bb50a6149725fb2fcc"
MAIN_2D_FACTS = "c64b4a4ecac9be6218e388eaf8db11dec5fdd67f20f860477c93f0ad6e1b7f42"
MAIN_3D_DOC = "ce9ed879f8a1e1e81b82fed2bcb554ca27c95b45622e2c669d8868cc3f9ef4d9"
MAIN_3D_DOC_NO_TEXT_TURN = "dc6c37434096d2b4fd7fc7ea819840d923107e962e49bcde5ca7428bff5c0e55"
MAIN_3D_FACTS_NO_TURN_COUNT = "607969395de6bf99aafb0471b0e4cddfc4b36ccafd363b76072ded26a42a1d0b"


@unittest.skipUnless(HAVE_EZDXF and HAVE_EZDGN, "ezdxf or ezdgn not installed")
class DataReaderTests(unittest.TestCase):
    def build(self, doc, defs=()):
        with mock.patch("ezdgn.v8.decode_item_instance", fake_decode, create=True):
            models, facts = dgn_read._v8_tree(doc, tuple(defs))
            return dgn_read.build_document(models, facts)

    def insert(self, doc, name):
        return next(e for e in doc.modelspace().query("INSERT") if e.dxf.name == name)

    def test_item_data_values_are_hidden_attributes_named_by_their_property(self):
        import cad  # noqa: PLC0415

        inst = v8_inst("GLYPH", 50, 60, eid=7, aux=item_aux(THING, None))
        doc, info = self.build(V8Doc([v8_model("Model", 2, [inst])]))
        ref = self.insert(doc, "GLYPH")
        self.assertEqual({a.dxf.tag: a.dxf.text for a in ref.attribs}, {"ALPHA": "A-1", "GAMMA": "7"})
        self.assertTrue(all(a.is_invisible for a in ref.attribs))
        self.assertEqual(tuple(ref.attribs[0].dxf.insert)[:2], (50.0, 60.0))
        self.assertEqual(info["item_data"], {
            "instances": 1, "properties": 3, "no_data": 1, "attributes": 2, "dropped": 0, "not_read": 0,
            "in_definitions": 0,
            "classes": [{"class": "Thing", "schema": "Things.01.00", "instances": 1}]})
        self.assertEqual(cad.dwg_registry(doc, "ezdgn")["blocks"][0]["attribs"], {"ALPHA": "A-1", "GAMMA": "7"})

    def test_tags_take_their_name_from_the_set_and_land_where_they_belong(self):
        sets = [tag_set(900, (1, "TAGA"), (2, "TAG B"))]
        els = [
            v8_tag("V-1", 900, 1, host=7, origin=pt(52, 61)),  # before its host
            v8_inst("GLYPH", 50, 60, eid=7),
            v8_tag(42, 900, 2, host=7),  # an integer, no origin: at the insert
            v8_tag("LOST", 901, 1, host=7),  # a set that is not in the file
            v8_tag("FREE", 900, 1, origin=pt(5, 6)),  # no host: a hidden text
            v8_tag("NOWHERE", 900, 1),  # no host, no origin: counted only
            v8_tag(None, 900, 1, origin=pt(1, 1)),  # a value ezdgn does not decode
            v8_el("CELL", 1, v8_data(name="BOX", origin=pt(100, 100)), etype=2, kids=(8, 9)),
            v8_line(1, 99, 99, 101, 101, parent=7),
            v8_tag("IN-CELL", 900, 1, origin=pt(100, 102), parent=7),
        ]
        source = V8Doc([v8_model("Model", 2, els)], sets)
        doc, info = self.build(source)
        glyph = self.insert(doc, "GLYPH")
        self.assertEqual({a.dxf.tag: a.dxf.text for a in glyph.attribs}, {"TAGA": "V-1", "TAG_B": "42", "TAG": "LOST"})
        self.assertTrue(all(a.is_invisible for a in glyph.attribs))
        at = {a.dxf.tag: tuple(a.dxf.insert)[:2] for a in glyph.attribs}
        self.assertEqual((at["TAGA"], at["TAG_B"]), ((52.0, 61.0), (50.0, 60.0)))
        box = self.insert(doc, "BOX")
        self.assertEqual({a.dxf.tag: a.dxf.text for a in box.attribs}, {"TAGA": "IN-CELL"})
        free = list(doc.modelspace().query("TEXT"))
        self.assertEqual([(t.dxf.text, t.dxf.invisible) for t in free], [("FREE", 1)])
        self.assertEqual(info["tags"], {"tag_sets": 1, "tags": 7, "with_value": 6, "with_definition": 6,
                                        "attached": 4, "as_text": 1, "not_placed": 2, "dropped": 0,
                                        "in_definitions": 0})
        self.assertEqual((info["gap"], info["records"], info["elements"]), (0, 10, 10))
        self.assertEqual([(m["kind"], m["count"]) for m in info["not_converted"]], [("TAG", 2)])
        self.assertEqual(source.tag_set_reads, 1)  # once a file, not once a tag

    def test_a_shared_cell_is_its_definition_placed_by_the_instance_matrix(self):
        import cad  # noqa: PLC0415

        glyph = v8_def("GLYPH", [v8_line(1, 0, 0, 10, 0, parent=0),
                             v8_el("TEXT", 1, v8_data(text="T1", origin=pt(0, 5), height_master=2.0,
                                                      width_master=2.0), etype=17, parent=0)])
        # Turned 90 degrees, scale 2 (the 3x3 matrix by rows).
        inst = v8_inst("GLYPH", 100, 200, m=(0.0, -2.0, 0.0, 2.0, 0.0, 0.0, 0.0, 0.0, 2.0))
        doc, info = self.build(V8Doc([v8_model("Model", 2, [inst])]), [glyph])
        ref = self.insert(doc, "GLYPH")
        self.assertEqual((ref.dxf.rotation, ref.dxf.xscale, ref.dxf.yscale), (90.0, 2.0, 2.0))
        self.assertEqual([e.dxftype() for e in doc.blocks.get("GLYPH")], ["LINE"])
        line_ = next(e for e in ref.virtual_entities() if e.dxftype() == "LINE")
        for got, want in ((line_.dxf.start, (100, 200)), (line_.dxf.end, (100, 220))):
            self.assertAlmostEqual(got[0], want[0])
            self.assertAlmostEqual(got[1], want[1])
        (t1,) = ref.attribs
        self.assertEqual((t1.dxf.text, t1.is_invisible), ("T1", False))
        self.assertAlmostEqual(t1.dxf.insert[0], 90.0)
        self.assertAlmostEqual(t1.dxf.insert[1], 200.0)
        self.assertAlmostEqual(t1.dxf.rotation, 90.0)
        self.assertAlmostEqual(t1.dxf.height, 4.0)
        sc = info["shared_cells"]
        self.assertEqual((sc["expanded"], sc["not_expanded"], sc["definitions_built"], sc["components_converted"],
                          sc["texts_placed"]), (1, 0, 1, 2, 1))
        # The definition's components are not records of the model.
        self.assertEqual((info["elements"], info["converted"], info["gap"], info["models"][0]["texts"]), (1, 1, 0, 0))
        self.assertEqual(info["shared_cells_not_expanded"], 0)
        self.assertIn("T1", [t["text"] for t in cad.dwg_registry(doc, "ezdgn")["texts"]])

    def test_a_mirrored_instance_has_a_negative_y_scale_and_its_texts_turn_over(self):
        glyph = v8_def("GLYPH", [v8_line(1, 0, 0, 10, 0, parent=0),
                             v8_el("TEXT", 1, v8_data(text="T1", origin=pt(1, 1), height_master=2.0,
                                                      width_master=2.0), etype=17, parent=0)])
        inst = v8_inst("GLYPH", 0, 0, m=(-1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0))
        doc, _ = self.build(V8Doc([v8_model("Model", 2, [inst])]), [glyph])
        ref = self.insert(doc, "GLYPH")
        self.assertEqual((ref.dxf.rotation, ref.dxf.xscale, ref.dxf.yscale), (180.0, 1.0, -1.0))
        line_ = next(e for e in ref.virtual_entities() if e.dxftype() == "LINE")
        self.assertAlmostEqual(line_.dxf.end[0], -10.0)
        self.assertAlmostEqual(line_.dxf.end[1], 0.0)
        (t1,) = ref.attribs
        self.assertEqual(t1.dxf.text_generation_flag, 4)
        self.assertAlmostEqual(t1.dxf.insert[0], -1.0)
        self.assertAlmostEqual(t1.dxf.insert[1], 1.0)

    def test_an_instance_finds_its_definition_by_name_and_range(self):
        short = v8_def("GLYPH", [v8_line(1, 0, 0, 10, 0, parent=0)])
        long_ = v8_def("GLYPH", [v8_line(1, 0, 0, 20, 0, parent=0)], rng=(0.0, 0.0, 0.0, 20.0, 10.0, 0.0))
        inst = v8_inst("GLYPH", 0, 0, rng=(0.0, 0.0, 0.0, 20.0, 10.0, 0.0))
        doc, info = self.build(V8Doc([v8_model("Model", 2, [inst])]), [short, long_])
        (line_,) = list(doc.blocks.get(self.insert(doc, "GLYPH").dxf.name))
        self.assertAlmostEqual(line_.dxf.end[0], 20.0)
        self.assertEqual(info["shared_cells"]["definitions"], 2)

    def test_instances_not_expanded_are_counted_by_reason(self):
        glyph = v8_def("GLYPH", [v8_line(1, 0, 0, 10, 0, parent=0)])
        shear = (1.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)
        lift = (1.0, 0.0, 0.5, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)  # definition Z moves the plan
        main = v8_model("Model", 2, [v8_inst("GLYPH", 0, 0, m=shear), v8_inst("GLYPH", 0, 0, m=lift),
                                     v8_inst("OTHER", 0, 0), v8_inst("GLYPH", 9, 9)])
        sheet = v8_model("Sheet", 2, [v8_inst("GLYPH", 0, 0)])
        sheet.metadata.uor_per_master = 10.0  # another unit scale than the first model's
        doc, info = self.build(V8Doc([main, sheet]), [glyph])
        sc = info["shared_cells"]
        self.assertEqual((sc["not_in_plan"], sc["no_definition"], sc["other_unit_scale"], sc["expanded"]),
                         (2, 1, 1, 1))
        self.assertEqual(info["shared_cells_not_expanded"], 4)
        self.assertIn("4 shared cell instances are not expanded", info["note"])

    def test_nested_definitions_are_inserts_and_a_loop_or_depth_stops(self):
        inner = v8_def("INNER", [v8_line(1, 0, 0, 1, 0, parent=0)])
        outer = v8_def("OUTER", [v8_inst("INNER", 5, 0, parent=0)])
        loop = v8_def("LOOP", [v8_inst("LOOP", 1, 0, parent=0)])
        doc, info = self.build(V8Doc([v8_model("Model", 2, [v8_inst("OUTER", 0, 0), v8_inst("LOOP", 0, 0)])]),
                               [inner, outer, loop])
        (nested,) = list(doc.blocks.get("OUTER"))
        self.assertEqual((nested.dxftype(), nested.dxf.name, tuple(nested.dxf.insert)[:2]), ("INSERT", "INNER", (5.0, 0.0)))
        self.assertEqual([e.dxftype() for e in doc.blocks.get("INNER")], ["LINE"])
        sc = info["shared_cells"]
        # LOOP inside LOOP: built once, and its own instance inside it is a
        # counted cycle, never a loop.
        self.assertEqual((sc["expanded"], sc["nested_cycle"], sc["definitions_built"]), (2, 1, 3))
        # D1 > D2 > D3 > D4 > D5 (no definition), built from the bottom: D4
        # is 1 deep, D3 2; D2 may not insert D3 (2 deep is the limit), so it
        # is 1 deep, and D1 is 2.
        chain = [v8_def(f"D{k}", [v8_inst(f"D{k + 1}", 0, 0, parent=0)]) for k in range(1, 5)]
        with mock.patch.object(dgn_read, "MAX_SC_DEPTH", 2):
            doc, info = self.build(V8Doc([v8_model("Model", 2, [v8_inst("D1", 0, 0)])]), chain)
        sc = info["shared_cells"]
        self.assertEqual((sc["nested_depth_limit"], sc["nested_no_definition"], sc["definitions_built"]), (1, 1, 4))
        # An instance not expanded is still an insert, of an empty block.
        self.assertLessEqual(output_depth(doc), 2 + 1)

    def test_attributes_past_the_budget_are_dropped_and_counted(self):
        many = NS(class_name="Thing", schema_reference="", properties=tuple((f"P{k}", "v") for k in range(5)))
        inst = v8_inst("GLYPH", 0, 0, aux=item_aux(many))
        with mock.patch.object(dgn_read, "MAX_ADDED_ATTRIBS", 2):
            doc, info = self.build(V8Doc([v8_model("Model", 2, [inst])]))
        self.assertEqual(len(self.insert(doc, "GLYPH").attribs), 2)
        self.assertEqual((info["item_data"]["attributes"], info["data_dropped"]), (2, 3))
        self.assertIn("3 attributes or texts past 2 a file are dropped", info["note"])

    def test_without_the_data_reader_nothing_new_is_read(self):
        # ezdgn 0.3.2: no definitions argument. The same elements give the
        # document they gave before: an empty insert, no new facts.
        inst = v8_inst("GLYPH", 50, 60, eid=7, aux=item_aux(THING))
        doc, info = dgn_read.build_document(*dgn_read._v8_tree(v8_doc((v8_model("Model", 2, [inst]),))))
        self.assertEqual(len(self.insert(doc, "GLYPH").attribs), 0)
        self.assertEqual(info["shared_cells_not_expanded"], 1)
        for key in ("shared_cells", "tags", "item_data", "data_dropped"):
            self.assertNotIn(key, info)

    def test_with_ezdgn_032_a_2d_file_is_as_before_and_3d_differs_only_in_text_turn(self):
        # The two-build check. The digests are of the document and facts the
        # converter of v0.600.0 (before the data reader) gave for these two
        # stand-ins: a 2D one must give the same, a 3D one the same but for
        # the rotation of its 3D texts and the count of turns not known.
        # The real files are checked on the bench (docs/parser.md).
        if ezdxf.__version__ != TWO_BUILD_EZDXF:
            self.skipTest(f"digests are for ezdxf {TWO_BUILD_EZDXF}: rebuild them (tests/two_build_digests.py)")
        d2, i2 = dgn_read.build_document(*dgn_read._v8_tree(two_build_doc(2)))
        d3, i3 = dgn_read.build_document(*dgn_read._v8_tree(two_build_doc(3)))
        self.assertEqual(doc_digest(d2), MAIN_2D_DOC)
        self.assertEqual(facts_digest(i2), MAIN_2D_FACTS)
        self.assertEqual(doc_digest(d3, text_turn=False), MAIN_3D_DOC_NO_TEXT_TURN)
        self.assertNotEqual(doc_digest(d3), MAIN_3D_DOC)  # its texts turn now
        self.assertEqual(facts_digest(i3, "text_turn_unknown"), MAIN_3D_FACTS_NO_TURN_COUNT)
        self.assertEqual(i3["text_turn_unknown"], 0)

    def test_load_reads_the_data_only_with_an_ezdgn_that_has_it(self):
        source = V8Doc([v8_model("Model", 2, [v8_line(1, 0, 0, 1, 0)])])

        def fake_ezdgn(**extra):
            return NS(detect_format=lambda p: NS(is_v7=False, dimension=2), open_document=lambda p: source,
                      __version__="0.3.2", **extra)

        def broken(path):
            raise ValueError("no")

        cases = ((fake_ezdgn(), False, None),
                 (fake_ezdgn(read_v8_shared_cell_definitions=lambda p: ()), True, None),
                 (fake_ezdgn(read_v8_shared_cell_definitions=broken), True, "ValueError"))
        for module, data, error in cases:
            with mock.patch.dict(sys.modules, {"ezdgn": module}):
                models, facts = dgn_read.load("drawing.dgn")
            self.assertEqual("definitions" in facts, data)
            self.assertEqual(facts.get("definitions_error"), error)
        _, info = dgn_read.build_document(models, facts)
        self.assertIn("could not read the shared cell definitions", info["note"])


def line_def(name, *kids_extra):
    return v8_def(name, [v8_line(1, 0, 0, 10, 0, parent=0), *kids_extra])


@unittest.skipUnless(HAVE_EZDXF and HAVE_EZDGN, "ezdxf or ezdgn not installed")
class SharedCellBoundsTests(unittest.TestCase):
    """The definitions are built once, before the models, from the bottom
    up; the output is bounded by weight, reach and depth."""

    build = DataReaderTests.build
    insert = DataReaderTests.insert

    def test_instances_in_reverse_order_give_the_same_bounded_nesting(self):
        chain = [v8_def(f"D{k}", [v8_inst(f"D{k + 1}", 0, 0, parent=0)]) for k in range(1, 10)]
        chain.append(line_def("D10"))
        forward = [v8_inst(f"D{k}", 0, 0) for k in range(1, 11)]
        results = []
        for insts in (forward, list(reversed(forward))):
            doc, info = self.build(V8Doc([v8_model("Model", 2, insts)]), chain)
            sc = info["shared_cells"]
            results.append((sc["expanded"], sc["nested_depth_limit"], sc["definitions_built"]))
            # D10 to D3 are 1 to 8 deep; D2 may not insert D3, D1 inserts D2.
            self.assertLessEqual(output_depth(doc), dgn_read.MAX_SC_DEPTH + 1)
        self.assertEqual(results, [(10, 1, 10), (10, 1, 10)])

    def test_a_deep_chain_ends_with_a_count_not_a_recursion_error(self):
        n = 500
        chain = [v8_def(f"D{k}", [v8_inst(f"D{k + 1}", 0, 0, parent=0)]) for k in range(1, n)]
        chain.append(line_def(f"D{n}"))
        doc, info = self.build(V8Doc([v8_model("Model", 2, [v8_inst("D1", 0, 0)])]), chain)
        sc = info["shared_cells"]
        self.assertEqual(sc["definitions_built"], n)
        # Counted from the bottom, every eighth definition is 8 deep, and the
        # one above it may not insert it.
        self.assertEqual(sc["nested_depth_limit"], (n - 1) // dgn_read.MAX_SC_DEPTH)
        self.assertLessEqual(output_depth(doc), dgn_read.MAX_SC_DEPTH + 1)

    def test_fan_out_is_weighed_and_the_file_total_holds(self):
        d3 = line_def("D3")  # weight 1
        d2 = v8_def("D2", [v8_inst("D3", k, 0, parent=0) for k in range(10)])  # 10 x (1 + 1) = 20
        d1 = v8_def("D1", [v8_inst("D2", k, 0, parent=0) for k in range(10)])  # 10 x (1 + 20) = 210
        insts = [v8_inst("D1", 0, 0)] + [v8_inst("D2", 0, 10 * k) for k in range(6)]
        with mock.patch.object(dgn_read, "MAX_EXPANDED_WEIGHT", 100):
            doc, info = self.build(V8Doc([v8_model("Model", 2, insts)]), [d1, d2, d3])
        sc = info["shared_cells"]
        # D1 would take 210 alone; five D2 take 100; the sixth would pass it.
        self.assertEqual((sc["too_large"], sc["expanded"], sc["weight"]), (2, 5, 100))
        self.assertIn("2 shared cell instances are not expanded: they would take the file past 100", info["note"])
        self.assertEqual(info["shared_cells_not_expanded"], 2)

    def test_a_cycle_between_definitions_ends_with_a_count(self):
        a = v8_def("A", [v8_inst("B", 1, 0, parent=0)])
        b = v8_def("B", [v8_inst("A", 2, 0, parent=0)])
        doc, info = self.build(V8Doc([v8_model("Model", 2, [v8_inst("A", 0, 0)])]), [a, b])
        sc = info["shared_cells"]
        self.assertEqual((sc["definitions_built"], sc["nested_cycle"], sc["expanded"]), (2, 1, 1))
        self.assertLess(output_depth(doc), 99)

    def test_an_instance_that_reaches_past_wild_is_not_expanded(self):
        big = (1e9, 0.0, 0.0, 0.0, 1e9, 0.0, 0.0, 0.0, 1.0)  # 10 units of definition: 1e10
        insts = [v8_inst("GLYPH", 0, 0, m=big), v8_inst("GLYPH", 0, 0)]
        _, info = self.build(V8Doc([v8_model("Model", 2, insts)]), [line_def("GLYPH")])
        self.assertEqual((info["shared_cells"]["too_large"], info["shared_cells"]["expanded"]), (1, 1))

    def test_the_matrix_is_read_by_rows_and_a_transpose_fails(self):
        # The bench rule (origin + M p, M by rows; docs/parser.md has the
        # counts). A turn of 30 degrees with X scale 2 and Y scale 3: not
        # symmetric, so its transpose is a shear, and a transposed reading
        # would not expand it at all.
        c, s_ = math.cos(math.radians(30)), math.sin(math.radians(30))
        m = (2 * c, -3 * s_, 0.0, 2 * s_, 3 * c, 0.0, 0.0, 0.0, 1.0)
        glyph = v8_def("GLYPH", [v8_line(1, 0, 0, 10, 0, parent=0), v8_line(1, 0, 0, 0, 5, parent=0)])
        doc, info = self.build(V8Doc([v8_model("Model", 2, [v8_inst("GLYPH", 100, 50, m=m)])]), [glyph])
        ref = self.insert(doc, "GLYPH")
        ends = sorted((round(e.dxf.end[0], 4), round(e.dxf.end[1], 4)) for e in ref.virtual_entities())
        self.assertEqual(ends, [(92.5, 62.9904), (117.3205, 60.0)])
        self.assertIsNone(dgn_read._plan((m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8])))

    def test_tags_and_item_data_inside_a_definition_are_counted_apart(self):
        sets = [tag_set(900, (1, "TAGA"))]
        glyph = line_def("GLYPH", v8_tag("IN-DEF", 900, 1, origin=pt(1, 1), parent=0),
                         v8_inst("INNER", 5, 0, aux=item_aux(THING), parent=0))
        _, info = self.build(V8Doc([v8_model("Model", 2, [v8_inst("GLYPH", 0, 0)])], sets),
                             [glyph, line_def("INNER")])
        self.assertEqual((info["tags"]["in_definitions"], info["tags"]["tags"]), (1, 0))
        self.assertEqual((info["item_data"]["in_definitions"], info["item_data"]["instances"]), (1, 0))

    def test_a_definition_record_under_no_header_is_counted(self):
        glyph = line_def("GLYPH")
        orphan = v8_line(1, 0, 0, 1, 1, parent=7)  # its parent is no record
        glyph.elements = (*glyph.elements, orphan)
        _, info = self.build(V8Doc([v8_model("Model", 2, [v8_inst("GLYPH", 0, 0)])]), [glyph])
        self.assertEqual(info["shared_cells"]["components_unreached"], 1)

    def test_a_tag_whose_host_is_not_drawn_is_counted_not_placed(self):
        lost = v8_el("SHARED_CELL_INSTANCE", 1, v8_data(name="GLYPH", origin=None, transform=RNG + IDENT),
                     etype=35, eid=7)
        els = [lost, v8_tag("V-1", 900, 1, host=7, origin=pt(1, 1))]
        _, info = self.build(V8Doc([v8_model("Model", 2, els)], [tag_set(900, (1, "TAGA"))]))
        self.assertEqual((info["tags"]["tags"], info["tags"]["not_placed"], info["tags"]["attached"]), (1, 1, 0))
        self.assertEqual((info["gap"], info["unreached"]), (0, 0))

    def test_a_zero_false_or_bytes_value_is_a_value(self):
        thing = NS(class_name="Thing", schema_reference="",
                   properties=(("ZERO", 0), ("NO", False), ("RAW", b"B-2"), ("NONE", None), ("EMPTY", "")))
        doc, info = self.build(V8Doc([v8_model("Model", 2, [v8_inst("GLYPH", 0, 0, aux=item_aux(thing))])]))
        self.assertEqual({a.dxf.tag: a.dxf.text for a in self.insert(doc, "GLYPH").attribs},
                         {"ZERO": "0", "NO": "False", "RAW": "B-2"})
        self.assertEqual(info["item_data"]["attributes"], 3)

    def test_item_data_is_not_decoded_once_the_files_budget_is_spent(self):
        calls = []

        def counting(entry):
            calls.append(1)
            return entry.item

        insts = [v8_inst("GLYPH", 10 * k, 0, aux=item_aux(THING)) for k in range(5)]  # 2 values each
        with mock.patch.object(dgn_read, "MAX_ADDED_ATTRIBS", 3), \
                mock.patch("ezdgn.v8.decode_item_instance", counting, create=True):
            models, facts = dgn_read._v8_tree(V8Doc([v8_model("Model", 2, insts)]), ())
            _, info = dgn_read.build_document(models, facts)
        # 3 values: the first instance takes 2, the second 2 more; then no
        # entry is decoded, only counted.
        self.assertEqual(len(calls), 2)
        self.assertEqual((info["item_data"]["instances"], info["item_data"]["not_read"]), (2, 3))
        self.assertIn("3 item data entries are not read", info["note"])

    def test_tag_sets_by_id_is_read_once_when_the_build_has_it(self):
        class ById(V8Doc):
            reads = 0

            @property
            def tag_sets(self):
                raise AssertionError("tag_sets_by_id is the one read")

            def tag_sets_by_id(self):
                ById.reads += 1
                return {s.element_id: s for s in self._sets}

        els = [v8_inst("GLYPH", 0, 0, eid=7), v8_tag("V-1", 900, 1, host=7), v8_tag("V-2", 900, 1, host=7)]
        doc, info = self.build(ById([v8_model("Model", 2, els)], [tag_set(900, (1, "TAGA"))]))
        self.assertEqual([a.dxf.tag for a in self.insert(doc, "GLYPH").attribs], ["TAGA", "TAGA"])
        self.assertEqual((ById.reads, info["tags"]["attached"]), (1, 2))

    def test_a_tag_is_cleaned_of_control_characters(self):
        self.assertEqual(dgn_read._attrib_tag("A\x00B C\x85D"), "A_B_C_D")
        self.assertEqual(dgn_read._attrib_tag(b"LINE NO"), "LINE_NO")

    def test_one_attribute_ezdxf_refuses_is_counted_and_the_file_converts(self):
        import ezdxf.entities  # noqa: PLC0415

        real = ezdxf.entities.Insert.add_attrib

        def picky(self_, tag, text_, *a, **k):
            if tag == "BETA":
                raise ezdxf.DXFValueError("refused")
            return real(self_, tag, text_, *a, **k)

        thing = NS(class_name="Thing", schema_reference="",
                   properties=(("ALPHA", "1"), ("BETA", "2"), ("GAMMA", "3")))
        with mock.patch.object(ezdxf.entities.Insert, "add_attrib", picky):
            doc, info = self.build(V8Doc([v8_model("Model", 2, [v8_inst("GLYPH", 0, 0, aux=item_aux(thing)),
                                                                 v8_line(1, 0, 0, 5, 5)])]))
        # The one refused leaves out itself only: the next one is still there.
        self.assertEqual([a.dxf.tag for a in self.insert(doc, "GLYPH").attribs], ["ALPHA", "GAMMA"])
        self.assertEqual(info["entities_refused"], 1)
        self.assertIn("1 entities or attributes are left out", info["note"])
        self.assertEqual(len(list(doc.modelspace().query("LINE"))), 1)

    def test_two_properties_of_one_name_are_both_kept_and_counted(self):
        import cad  # noqa: PLC0415

        thing = NS(class_name="Thing", schema_reference="", properties=(("ALPHA", "1"), ("ALPHA", "2")))
        doc, info = self.build(V8Doc([v8_model("Model", 2, [v8_inst("GLYPH", 0, 0, aux=item_aux(thing))])]))
        self.assertEqual(info["data_same_tag"], 1)
        reg = cad.dwg_registry(doc, "ezdgn")
        self.assertEqual(reg["blocks"][0]["attribs"], {"ALPHA": "1"})
        self.assertEqual(sorted(t["text"] for t in reg["texts"]), ["1", "2"])


@unittest.skipUnless(HAVE_EZDXF and HAVE_EZDGN, "ezdxf or ezdgn not installed")
class DataReadFailureTests(unittest.TestCase):
    """One guard: a failed read of the data reads the file the 0.3.2 way."""

    def load(self, source, defs=(), decode=fake_decode):
        module = NS(detect_format=lambda p: NS(is_v7=False, dimension=2), open_document=lambda p: source,
                    read_v8_shared_cell_definitions=lambda p: tuple(defs), __version__="0.3.2",
                    v8=NS(decode_item_instance=decode))
        with mock.patch.dict(sys.modules, {"ezdgn": module}):
            return dgn_read.build_document(*dgn_read.load("drawing.dgn"))

    def plain(self, source):
        return dgn_read.build_document(*dgn_read._v8_tree(source))

    def els(self):
        return [v8_line(1, 0, 0, 10, 0), v8_inst("GLYPH", 50, 60, eid=7, aux=item_aux(THING)),
                v8_tag("V-1", 900, 1, host=7)]

    def check(self, source, error, **kw):
        doc, info = self.load(source, **kw)
        self.assertEqual(info["data_error"], error)
        self.assertNotIn("shared_cells", info)
        self.assertIn("The DGN data reader failed on this file", info["note"])
        want, _ = self.plain(source)
        self.assertEqual(doc_digest(doc), doc_digest(want))

    def test_tag_sets_that_raise(self):
        class Broken(V8Doc):
            @property
            def tag_sets(self):
                raise RuntimeError("bad set")

        self.check(Broken([v8_model("Model", 2, self.els())]), "RuntimeError")

    def test_an_item_that_does_not_decode(self):
        def decode(entry):
            raise ValueError("bad item")

        self.check(V8Doc([v8_model("Model", 2, self.els())]), "ValueError", decode=decode)

    def test_auxiliary_records_that_raise(self):
        class Aux(NS):
            @property
            def auxiliary_records(self):
                raise OSError("bad record")

        inst = v8_inst("GLYPH", 50, 60, eid=7)
        broken = Aux(**{k: v for k, v in vars(inst).items() if k != "auxiliary_records"})
        self.check(V8Doc([v8_model("Model", 2, [v8_line(1, 0, 0, 10, 0), broken])]), "OSError")

    def test_a_matches_that_raises(self):
        glyph = line_def("GLYPH")

        def matches(e):
            raise KeyError("bad range")

        glyph.matches = matches
        self.check(V8Doc([v8_model("Model", 2, self.els())]), "KeyError", defs=[glyph])

    def test_a_definition_element_that_is_not_one(self):
        glyph = line_def("GLYPH")
        glyph.elements = (*glyph.elements, NS(kind="LINE"))  # no data, no level
        self.check(V8Doc([v8_model("Model", 2, self.els())]), "AttributeError", defs=[glyph])

    def test_a_3d_text_with_no_orientation_is_drawn_unturned(self):
        self.assertIsNone(dgn_read._text_turn(None))
        t = v8_el("TEXT", 1, v8_data(text="T", origin=pt(0, 0), height_master=1.0, width_master=1.0,
                                     rotation_degrees=None, orientation=None), etype=17)
        _, info = self.plain(V8Doc([v8_model("Model", 3, [t])]))
        self.assertEqual((info["converted"], info["text_turn_unknown"]), (1, 1))


@unittest.skipUnless(HAVE_EZDXF, "ezdxf not installed")
class RegistryHiddenValuesTests(unittest.TestCase):
    def test_a_dgns_hidden_values_never_push_a_drawn_text_out(self):
        import cad  # noqa: PLC0415
        import ezdxf  # noqa: PLC0415

        doc = ezdxf.new("R2010")
        doc.blocks.new("B")
        msp = doc.modelspace()
        ref = msp.add_blockref("B", (0, 0))
        for k in range(20_000):
            ref.add_attrib(f"P{k}", f"v{k}", dxfattribs={"flags": 1})
        msp.add_text("DRAWN NOTE")
        dgn = cad.dwg_registry(doc, "ezdgn")
        self.assertEqual(dgn["texts"][0]["text"], "DRAWN NOTE")
        self.assertEqual((len(dgn["texts"]), dgn["capped"]), (20_000, True))
        # A DWG's registry is what it was: model-space order, one cap.
        dwg = cad.dwg_registry(doc, "dwg2dxf")
        self.assertNotIn("DRAWN NOTE", [t["text"] for t in dwg["texts"]])
        self.assertEqual((len(dwg["texts"]), dwg["capped"]), (20_000, True))


def write_v7(path: str, three_d: bool = False) -> None:
    """A small V7 2D drawing on levels 1 to 4, written by ezdgn itself."""
    doc = ezdgn.new()
    msp = doc.modelspace()
    msp.add_line((0, 0), (100, 0), dgnattribs={"level": 1})
    msp.add_line_string([(0, 10), (50, 10), (50, 40)], dgnattribs={"level": 1})
    msp.add_shape([(10, 50), (30, 50), (30, 70), (10, 70)], dgnattribs={"level": 2})
    msp.add_arc((60, 60), 10, start_angle=0, sweep_angle=90, dgnattribs={"level": 3})
    msp.add_arc((60, 90), 10, start_angle=90, sweep_angle=-60, dgnattribs={"level": 3})
    msp.add_circle((90, 60), 5, dgnattribs={"level": 3})
    msp.add_ellipse((90, 90), 8, 4, rotation=30, dgnattribs={"level": 3})
    msp.add_text("PUMP P-101", (5, 80), height=3, dgnattribs={"level": 4})
    msp.add_text("LINE 25-01", (5, 90), height=2.5, rotation=90, dgnattribs={"level": 4})
    data = doc.to_bytes()
    if three_d:
        data = bytes([0xC8]) + data[1:]
    with open(path, "wb") as f:
        f.write(data)


@unittest.skipUnless(HAVE_EZDXF and HAVE_EZDGN, "ezdxf or ezdgn not installed")
class V7FileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.src = os.path.join(self.tmp.name, "drawing.dgn")
        write_v7(self.src)

    def tearDown(self):
        self.tmp.cleanup()

    def test_open_cad_reads_a_v7_file_with_ezdgn(self):
        import cad  # noqa: PLC0415

        doc, converter, notes = cad.open_cad(self.src, self.tmp.name)
        self.assertEqual(converter, "ezdgn")
        self.assertEqual(notes["format"], "V7 2D")
        self.assertEqual(notes["text_encoding"], "latin-1")
        self.assertEqual((notes["records"], notes["gap"], notes["unreached"]), (9, 0, 0))
        self.assertEqual(notes["not_converted_total"], 0)
        self.assertEqual(notes["converted"], 9)
        kinds = sorted(e.dxftype() for e in doc.modelspace())
        self.assertEqual(kinds, ["ARC", "ARC", "CIRCLE", "ELLIPSE", "LINE", "LWPOLYLINE", "LWPOLYLINE", "TEXT", "TEXT"])
        index = cad.dwg_registry(doc, converter)
        self.assertEqual(sorted(t["text"] for t in index["texts"]), ["LINE 25-01", "PUMP P-101"])
        self.assertEqual(sorted(layer["name"] for layer in index["layers"]), ["1", "2", "3", "4"])
        self.assertIsNone(index["geometry_error"])
        rotated = [e for e in doc.modelspace().query("TEXT") if e.dxf.text.startswith("LINE")][0]
        self.assertAlmostEqual(rotated.dxf.rotation, 90.0, places=3)
        self.assertAlmostEqual(rotated.dxf.height, 2.5, places=3)
        # Nothing written into the job's folder.
        self.assertEqual(os.listdir(self.tmp.name), ["drawing.dgn"])

    def test_a_negative_v7_sweep_reads_as_the_same_arc(self):
        import cad  # noqa: PLC0415

        doc, _, _ = cad.open_cad(self.src, self.tmp.name)
        arcs = sorted((round(e.dxf.start_angle, 3), round(e.dxf.end_angle, 3))
                      for e in doc.modelspace().query("ARC"))
        self.assertEqual(arcs, [(0.0, 90.0), (30.0, 90.0)])

    def test_a_v7_3d_file_gets_the_curated_refusal(self):
        import cad  # noqa: PLC0415

        src = os.path.join(self.tmp.name, "solid.dgn")
        write_v7(src, three_d=True)
        doc, converter, notes = cad.open_cad(src, self.tmp.name)
        self.assertEqual((doc, converter, notes), (None, None, None))

    def test_a_broken_dgn_is_refused_not_read_as_dxf(self):
        import cad  # noqa: PLC0415

        src = os.path.join(self.tmp.name, "broken.dgn")
        with open(src, "wb") as f:
            f.write(dgn_read.CFB_MAGIC + b"\x00" * 600)
        self.assertEqual(cad.open_cad(src, self.tmp.name), (None, None, None))

    @unittest.skipUnless(HAVE_MPL, "matplotlib not installed")
    def test_dwg_render_writes_the_index_with_the_dgn_facts_and_a_picture(self):
        import cad  # noqa: PLC0415

        out = os.path.join(self.tmp.name, "out")
        os.mkdir(out)
        self.assertEqual(cad.dwg_render_worker(self.src, out, 100), 0)
        with open(os.path.join(out, "index.json"), encoding="utf-8") as f:
            index = json.load(f)
        self.assertEqual(index["converter"], "ezdgn")
        self.assertEqual(index["dgn"]["format"], "V7 2D")
        self.assertIsNone(index["render_error"])
        self.assertTrue(os.path.isfile(os.path.join(out, "model.png")))


class SignatureTests(unittest.TestCase):
    def test_dgn_signatures(self):
        self.assertTrue(dgn_read.is_dgn(dgn_read.CFB_MAGIC))
        self.assertTrue(dgn_read.is_dgn(b"\x08\x09\xfe\x02\x00\x00\x00\x00"))
        self.assertTrue(dgn_read.is_dgn(b"\xc8\x09\xfe\x02\x00\x00\x00\x00"))
        self.assertFalse(dgn_read.is_dgn(b"AC1032\x00\x00"))
        self.assertFalse(dgn_read.is_dgn(b"  0\nSECTION"))


if __name__ == "__main__":
    unittest.main()
