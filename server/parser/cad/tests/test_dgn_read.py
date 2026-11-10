"""Tests for the DGN converter (dgn_read.py): element trees made by hand,
and V7 drawings this test writes with ezdgn's own V7 writer (never a real
drawing: the repo is public).

Run (stdlib unittest; the cases skip when ezdxf or ezdgn is not installed):
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
except Exception:  # pragma: no cover - ezdgn is not in every venv yet
    HAVE_EZDGN = False

try:
    import matplotlib  # noqa: F401

    HAVE_MPL = True
except Exception:  # pragma: no cover
    HAVE_MPL = False


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


def v8_el(kind, level, data, z=(0.0, 0.0), etype=3, parent=None, kids=(), raw=None):
    rng = ((0.0, 0.0, z[0]), (1.0, 1.0, z[1]))
    return NS(kind=kind, level=level, data=data, common=NS(range_master=rng),
              raw=raw or NS(element_type=etype), parent_index=parent, child_indices=tuple(kids))


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
        return NS(models=(v8_model("Model", 3, model_3d), v8_model("Sheet", 2, sheet),
                          v8_model("Layout", 3, [])), levels=levels)

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
        self.assertEqual(info["text_turn_unknown"], 1)
        self.assertIn("3D model", info["note"])

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
        source.models = (v8_model("Empty", 2, []),) + source.models[1:2]
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
        source = NS(models=(v8_model("Model", 2, els),), levels=[NS(level_id=1, name="Work")])
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
        source = NS(models=(v8_model("Model", 2, els),), levels=[])
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
        source = NS(models=(v8_model("Frame", 2, frame), v8_model("Plan", 2, drawing)), levels=[])
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
        source = NS(models=(v8_model("Model", 2, first), v8_model("Sheet", 2, sheet)), levels=[])
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
        source = NS(models=(v8_model("Model", 2, els),), levels=levels)
        doc, info = self.build(source)
        changed = sorted((c["level"], c["layer"]) for c in info["levels_changed"])
        self.assertEqual(changed, [("12", "12"), ("12", "12"), ("Circuit Q9/Z-1", "Circuit Q9_Z-1")])
        self.assertEqual(info["levels_changed_total"], 3)
        self.assertIn("`levels_changed`", info["note"])
        index = cad.dwg_registry(doc, "ezdgn")
        self.assertEqual([c["circuit"] for c in index["circuits"]], ["Q9_Z-1"])


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
