"""Tests for the DGN converter (dgn_read.py): element trees made by hand,
and V7 drawings this test writes with ezdgn's own V7 writer (never a real
drawing: the repo is public).

Run (stdlib unittest; the cases skip when ezdxf or ezdgn is not installed):
    python3 -m venv /tmp/dgnvenv
    /tmp/dgnvenv/bin/pip install "ezdxf==1.4.5" "matplotlib==3.11.2" "ezdgn==0.3.2"
    /tmp/dgnvenv/bin/python -m unittest discover -s server/parser/cad/tests -v
"""

from __future__ import annotations

import json
import math
import os
import sys
import tempfile
import unittest

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


def facts(**kw):
    base = {"format": "V8", "models": 1, "dimension": 2, "unit": "mm", "other_model_elements": 0}
    base.update(kw)
    return base


def valve(x, y, tag=None):
    """A bow-tie valve cell in design coordinates, as DGN stores it."""
    kids = [line(x - 2, y - 1, x + 2, y + 1), line(x - 2, y + 1, x + 2, y - 1)]
    if tag:
        kids.append(text(tag, x - 2, y + 2))
    return cell("VALVE", x, y, kids)


@unittest.skipUnless(HAVE_EZDXF, "ezdxf not installed")
class BuildDocumentTests(unittest.TestCase):
    def build(self, top, **kw):
        return dgn_read.build_document(top, facts(**kw))

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
        _, info = self.build(top, other_model_elements=4)
        got = {(m["kind"], m["type"]): (m["count"], m["name"]) for m in info["not_converted"]}
        self.assertEqual(got[("UNKNOWN", 33)], (2, "dimension"))
        self.assertEqual(got[("UNKNOWN", 37)], (1, "tag"))
        self.assertEqual(got[("UNKNOWN", 99)], (1, None))
        self.assertEqual(got[("BSPLINE_CURVE", 27)], (1, None))
        self.assertEqual(got[("UNKNOWN", 26)], (1, "bspline_knot"))
        self.assertEqual(got[("BSPLINE_POLE", 21)], (1, None))
        self.assertEqual(got[("OTHER_MODEL", None)], (4, None))
        self.assertEqual(info["converted"], 1)
        self.assertEqual(info["elements"], info["converted"] + info["not_converted_total"])
        self.assertEqual(info["not_converted_total"], 11)

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
            Node("TEXT", "L", 17, {"text": "3D", "o": (0.0, 0.0, 0.0), "h": 1.0, "w": 1.0, "rot": None}),
        ]
        doc, info = self.build(top)
        self.assertEqual(len(doc.modelspace()), 0)
        self.assertEqual(info["not_converted_total"], 4)

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
