"""Tests for the DWG bones: the pure network and circuit rules, and the
registry on synthetic DXF files this test builds with ezdxf (never a real
drawing: the repo is public).

Run (stdlib unittest; the ezdxf cases skip when ezdxf is not installed):
    python3 -m venv /tmp/dwgvenv && /tmp/dwgvenv/bin/pip install "ezdxf==1.4.5"
    /tmp/dwgvenv/bin/python -m unittest discover -s infra/media-sidecar/tests -v
"""

from __future__ import annotations

import json
import math
import os
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import dwg_bones  # noqa: E402

try:
    import ezdxf  # noqa: F401

    HAVE_EZDXF = True
except Exception:  # pragma: no cover - the venv case
    HAVE_EZDXF = False
    if os.environ.get("MEDIA_TESTS_REQUIRE_EZDXF"):
        raise  # CI: the registry cases must run, never skip


def seg(x1, y1, x2, y2, layer="PIPE", handle="", curved=False, length=None):
    return {
        "x1": float(x1), "y1": float(y1), "x2": float(x2), "y2": float(y2),
        "length": float(length if length is not None else math.hypot(x2 - x1, y2 - y1)),
        "curved": curved, "layer": layer, "handle": handle, "type": "LINE", "part": 0,
    }


def kinds(net):
    out = {}
    for n in net["nodes"]:
        if n["degree"]:
            out[n["kind"]] = out.get(n["kind"], 0) + 1
    return out


def node_at(net, x, y):
    for i, n in enumerate(net["nodes"]):
        if abs(n["x"] - x) < 1e-6 and abs(n["y"] - y) < 1e-6:
            return i, n
    raise AssertionError(f"no node at ({x}, {y})")


class NetworkTests(unittest.TestCase):
    def test_three_ends_meeting_are_a_tee(self):
        net = dwg_bones.build_network(
            [seg(0, 0, 10, 0), seg(10, 0, 20, 0), seg(10, 0, 10, 10)]
        )
        _, tee = node_at(net, 10, 0)
        self.assertEqual(tee["degree"], 3)
        self.assertEqual(tee["kind"], "tee")
        self.assertEqual(kinds(net), {"tee": 1, "end": 3})
        self.assertEqual(net["runs"], 1)

    def test_branch_ending_on_a_header_interior_splits_it_into_a_tee(self):
        # One LINE for the header, the branch drawn up to its middle.
        net = dwg_bones.build_network([seg(0, 0, 20, 0, handle="H"), seg(10, 0, 10, 10)])
        _, tee = node_at(net, 10, 0)
        self.assertEqual(tee["kind"], "tee")
        header = [p for p in net["pieces"] if p["seg"] == 0]
        self.assertEqual(len(header), 2)
        self.assertAlmostEqual(sum(p["length"] for p in header), 20.0)
        self.assertEqual(net["runs"], 1)

    def test_a_crossing_without_a_shared_end_is_not_a_join(self):
        net = dwg_bones.build_network([seg(0, 0, 10, 10), seg(0, 10, 10, 0)])
        self.assertEqual(kinds(net), {"end": 4})
        self.assertEqual(net["runs"], 2)
        self.assertEqual(len(net["pieces"]), 2)

    def test_snap_tolerance_is_relative_to_the_extent(self):
        # Extent diagonal ~1000 -> tol 0.2: a 0.1 gap snaps, a 1.0 gap does not.
        base = [seg(0, 0, 600, 0), seg(0, 800, 600, 800)]
        snapped = dwg_bones.build_network(base + [seg(600.1, 0, 600.1, 400)])
        self.assertAlmostEqual(snapped["tol"], 1000 * dwg_bones.SNAP_REL, places=3)
        self.assertEqual(kinds(snapped).get("joint"), 1)
        apart = dwg_bones.build_network(base + [seg(601, 0, 601, 400)])
        self.assertNotIn("joint", kinds(apart))

    def test_a_stray_far_entity_does_not_loosen_the_tolerance(self):
        drawing = [seg(i, 0, i, 10) for i in range(0, 1000, 5)]
        net_a = dwg_bones.build_network(drawing)
        net_b = dwg_bones.build_network(drawing + [seg(1e9, 1e9, 1e9 + 1, 1e9)])
        self.assertAlmostEqual(net_a["tol"], net_b["tol"], delta=net_a["tol"] * 0.05)

    def test_a_valve_block_bridges_two_pipe_ends(self):
        box = {"minx": 10, "miny": -1, "maxx": 12, "maxy": 1, "block": "VALVE", "handle": "V1"}
        # The far line sets a 200-unit extent, so the 2.8-unit valve box is
        # well under the 5% size guard.
        net = dwg_bones.build_network(
            [seg(0, 0, 10, 0), seg(12, 0, 22, 0), seg(0, 200, 22, 200)], [box]
        )
        a = node_at(net, 10, 0)[1]
        b = node_at(net, 12, 0)[1]
        self.assertEqual((a["kind"], b["kind"]), ("block", "block"))
        self.assertEqual(a["block"], 0)
        self.assertEqual(len(net["bridges"]), 1)
        # The two pipes are one run through the valve; the far line is its own.
        self.assertEqual(net["runs"], 2)

    def test_one_end_at_a_block_stays_an_end_with_the_block_named(self):
        box = {"minx": 10, "miny": -1, "maxx": 12, "maxy": 1, "block": "CAP", "handle": "C1"}
        net = dwg_bones.build_network([seg(0, 0, 10, 0), seg(0, 200, 30, 200)], [box])
        end = node_at(net, 10, 0)[1]
        self.assertEqual(end["kind"], "end")
        self.assertEqual(end["block"], 0)

    def test_a_sheet_sized_block_never_bridges(self):
        border = {"minx": -5, "miny": -5, "maxx": 100, "maxy": 100, "block": "BORDER", "handle": "B"}
        net = dwg_bones.build_network([seg(0, 0, 10, 0), seg(12, 0, 22, 0), seg(0, 90, 90, 90)], [border])
        self.assertEqual(net["bridges"], [])
        self.assertEqual(net["runs"], 3)

    def test_a_line_drawn_twice_is_one_connection(self):
        net = dwg_bones.build_network([seg(0, 0, 10, 0), seg(0, 0, 10, 0)])
        self.assertEqual(kinds(net), {"end": 2})
        self.assertEqual(len(net["pieces"]), 2)

    def test_an_arc_is_never_split_by_a_tee(self):
        # A branch ending on the arc's chord midpoint is not on the arc.
        arc = seg(0, 0, 10, 0, curved=True, length=15.7)
        net = dwg_bones.build_network([arc, seg(5, 0, 5, -10)])
        self.assertNotIn("tee", kinds(net))

    def test_arc_length_from_bulge(self):
        # Bulge 1 is a half circle: chord 2 -> length pi.
        self.assertAlmostEqual(dwg_bones._arc_length(2.0, 1.0), math.pi)
        self.assertEqual(dwg_bones._arc_length(3.0, 0.0), 3.0)

    def test_coord_never_returns_nan(self):
        self.assertIsNone(dwg_bones.coord(float("nan")))
        self.assertIsNone(dwg_bones.coord(float("inf")))
        self.assertIsNone(dwg_bones.coord("x"))
        self.assertEqual(dwg_bones.coord(1.26), 1.3)


class CircuitTests(unittest.TestCase):
    def test_layer_suffixes(self):
        p = dwg_bones.parse_circuit_layer
        self.assertEqual(p("Circuit 90000-010-01"), ("90000-010-01", "main", "", ""))
        self.assertEqual(p("Circuit 90000-010-01-DL"), ("90000-010-01", "deadleg", "DL", ""))
        self.assertEqual(p("circuit 90000-010-01-b01-dl"), ("90000-010-01", "deadleg", "B01-DL", ""))
        self.assertEqual(p("Circuit 90000-010-01-D03"), ("90000-010-01", "deadleg", "D03", ""))
        self.assertEqual(
            p("Circuit 90000-010-01-IP1"), ("90000-010-01-IP1", "main", "IP1", "90000-010-01")
        )
        self.assertIsNone(p("PIPE"))
        self.assertIsNone(p("Circuits"))
        self.assertIsNone(p("Circuit"))

    def test_rows_count_main_deadleg_and_line_numbers(self):
        main = "Circuit 90000-010-01"
        segs = [
            seg(0, 0, 10, 0, layer=main, handle="A1"),
            seg(10, 0, 20, 0, layer=main, handle="A2"),
            seg(10, 0, 10, 5, layer=main + "-DL", handle="D1"),
            seg(20, 0, 30, 0, layer="Circuit 90000-011-01", handle="B1"),
            seg(0, 100, 50, 100, layer="BORDER", handle="Z1"),
            seg(50, 50, 60, 50, layer=main + "-IP1", handle="I1"),
        ]
        net = dwg_bones.build_network(segs)
        texts = [
            {"text": "DN150", "layer": "ANNO", "x": 5.0, "y": 0.5},
            {"text": "FAR AWAY", "layer": "ANNO", "x": 5.0, "y": 90.0},
        ]
        blocks = [
            # Names its circuit: belongs to it wherever it sits.
            {"block": "LineNumber", "handle": "L1", "x": 500.0, "y": 500.0,
             "attribs": {"LINENO": "N90010", "CIRCUIT": "Circuit 90000-010-01"}},
            # No circuit tag, but on the run.
            {"block": "LineNumber", "handle": "L2", "x": 15.0, "y": 0.4,
             "attribs": {"LINE_NO": "N90011"}},
        ]
        rows = {r["circuit"]: r for r in dwg_bones.circuit_rows(segs, net, texts, blocks)}
        self.assertEqual(set(rows), {"90000-010-01", "90000-010-01-IP1", "90000-011-01"})
        row = rows["90000-010-01"]
        self.assertEqual(row["kind"], "circuit")
        self.assertEqual(row["entities"], 2)
        self.assertEqual(row["segments"], 2)
        self.assertEqual(row["length"], 20.0)
        self.assertEqual(row["deadleg_segments"], 1)
        self.assertEqual(row["deadleg_length"], 5.0)
        self.assertEqual(row["runs"], 1)
        self.assertEqual(row["tees"], 1)
        self.assertEqual(row["ends"], 3)
        self.assertIn("meets Circuit 90000-011-01", row["end_points"])
        self.assertIn("open", row["end_points"])
        self.assertIn("N90010 [L1]", row["line_numbers"])
        self.assertIn("N90011 [L2]", row["line_numbers"])
        self.assertIn("DN150", row["nearby_text"])
        self.assertNotIn("FAR AWAY", row["nearby_text"])
        ip = rows["90000-010-01-IP1"]
        self.assertEqual((ip["kind"], ip["parent"]), ("injection point", "90000-010-01"))

    def test_no_circuit_layers_claims_nothing(self):
        segs = [seg(0, 0, 10, 0), seg(10, 0, 20, 0)]
        self.assertEqual(dwg_bones.circuit_rows(segs, dwg_bones.build_network(segs)), [])
        out = dwg_bones.geometry_index(segs, [], [], [])
        self.assertEqual(out["circuits"], [])
        self.assertEqual(out["geometry"]["circuits"], 0)


class CapTests(unittest.TestCase):
    def test_each_list_has_its_own_cap_bit(self):
        segs = [seg(i, 0, i, 10, handle=f"H{i}") for i in range(200)]
        saved = dwg_bones.MAX_SEGMENT_CHARS
        dwg_bones.MAX_SEGMENT_CHARS = 2_000
        try:
            out = dwg_bones.geometry_index(segs, [], [], [])
        finally:
            dwg_bones.MAX_SEGMENT_CHARS = saved
        self.assertTrue(out["segments_capped"])
        self.assertLess(len(out["segments"]), 200)
        self.assertFalse(out["nodes_capped"])
        self.assertEqual(out["geometry"]["segments"], 200)
        json.dumps(out, allow_nan=False)


@unittest.skipUnless(HAVE_EZDXF, "ezdxf not installed")
class RegistryTests(unittest.TestCase):
    """dwg_registry on DXF files written and read back by the test."""

    @classmethod
    def setUpClass(cls):
        import app  # noqa: PLC0415 - imports nothing heavy at module level

        cls.app = app

    def roundtrip(self, doc):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "synthetic.dxf")
            doc.saveas(path)
            return ezdxf.readfile(path)

    def synthetic(self):
        doc = ezdxf.new("R2013")
        msp = doc.modelspace()
        valve = doc.blocks.new("GATE_VALVE")
        valve.add_line((0, -1), (2, 1))
        valve.add_line((0, 1), (2, -1))
        valve.add_attdef("TAG", (0, 2), dxfattribs={"height": 0.5})
        tag = doc.blocks.new("LineNumber")
        tag.add_line((0, 0), (0.1, 0))
        tag.add_attdef("LINENO", (0, 0))
        tag.add_attdef("CIRCUIT", (0, -1))
        main, dl = "Circuit 90000-020-01", "Circuit 90000-020-01-DL"
        for name in (main, dl, "PIPE"):
            doc.layers.add(name)
        # Main: a header with a branch tee drawn to its middle, a valve, more pipe.
        msp.add_line((0, 0), (100, 0), dxfattribs={"layer": main})
        msp.add_lwpolyline([(100, 0), (100, 50), (150, 50)], dxfattribs={"layer": main})
        msp.add_blockref("GATE_VALVE", (150, 50), dxfattribs={"layer": "VALVES"})
        msp.add_line((152, 50), (200, 50), dxfattribs={"layer": main})
        # Deadleg off the header's interior.
        msp.add_line((40, 0), (40, -30), dxfattribs={"layer": dl})
        # A line crossing the header with no end on it: no join.
        msp.add_line((70, -20), (70, 20), dxfattribs={"layer": "PIPE"})
        # An arc and a bulged polyline: chords with true lengths.
        msp.add_arc((300, 0), 10, 0, 90, dxfattribs={"layer": "PIPE"})
        msp.add_lwpolyline([(400, 0, 1.0), (420, 0, 0.0)], format="xyb", dxfattribs={"layer": "PIPE"})
        # A SPLINE is skipped, and said to be.
        msp.add_spline([(0, 100), (10, 110), (20, 100)])
        ref = msp.add_blockref("LineNumber", (50, 2), dxfattribs={"layer": "TAGS"})
        ref.add_auto_attribs({"LINENO": "N90020-10-6", "CIRCUIT": main})
        msp.add_text("DN150", dxfattribs={"insert": (20, 1), "height": 1})
        return self.roundtrip(doc)

    def test_registry_keeps_its_fields_and_adds_the_bones(self):
        index = self.app.dwg_registry(self.synthetic(), "none")
        # The existing reply is unchanged in shape.
        for key in ("converter", "version", "entities", "capped", "layers", "texts",
                    "blocks", "blocks_capped", "counts", "render_error"):
            self.assertIn(key, index)
        self.assertIsNone(index["geometry_error"])
        self.assertEqual([b["block"] for b in index["blocks"]], ["LineNumber"])
        # No NaN anywhere: the app side parses this with JSON.parse.
        json.dumps(index, allow_nan=False)

        geo = index["geometry"]
        self.assertEqual(geo["skipped"].get("SPLINE"), 1)
        self.assertGreater(geo["snap_tolerance"], 0)
        types = {s["type"] for s in index["segments"]}
        self.assertEqual(types, {"LINE", "LWPOLYLINE", "ARC"})
        arc = next(s for s in index["segments"] if s["type"] == "ARC")
        self.assertEqual(arc["length"], round(10 * math.pi / 2, 1))
        bulged = [s for s in index["segments"] if s["type"] == "LWPOLYLINE" and s["x1"] == 400]
        self.assertEqual(bulged[0]["length"], round(10 * math.pi, 1))

        nodes = {(n["x"], n["y"]): n for n in index["nodes"]}
        self.assertEqual(nodes[(40.0, 0.0)]["kind"], "tee")
        self.assertEqual(nodes[(100.0, 0.0)]["kind"], "joint")
        self.assertEqual(nodes[(150.0, 50.0)]["kind"], "block")
        self.assertEqual(nodes[(150.0, 50.0)]["block"], "GATE_VALVE")
        self.assertEqual(nodes[(152.0, 50.0)]["kind"], "block")
        self.assertNotIn((70.0, 0.0), nodes)  # the crossing

        inserts = {i["block"]: i for i in index["inserts"]}
        self.assertEqual(set(inserts), {"GATE_VALVE", "LineNumber"})
        self.assertEqual(
            (inserts["GATE_VALVE"]["minx"], inserts["GATE_VALVE"]["maxx"]), (150.0, 152.0)
        )
        self.assertEqual(inserts["GATE_VALVE"]["attribs"], 0)
        self.assertEqual(inserts["LineNumber"]["attribs"], 2)

        (row,) = index["circuits"]
        self.assertEqual(row["circuit"], "90000-020-01")
        self.assertEqual(row["entities"], 3)
        self.assertEqual(row["segments"], 5)  # header split in 2 at the tee
        self.assertEqual(row["deadleg_segments"], 1)
        self.assertEqual(row["runs"], 1)  # through the valve
        self.assertEqual(row["tees"], 1)
        self.assertEqual(row["ends"], 3)
        self.assertIn("N90020-10-6", row["line_numbers"])
        self.assertIn("DN150", row["nearby_text"])

    def test_entity_readers_work_in_wcs(self):
        doc = ezdxf.new("R2013")
        msp = doc.modelspace()
        p2 = msp.add_polyline2d([(0, 0), (10, 0), (10, 10)], format="xy")
        p2.vertices[0].dxf.bulge = 1.0
        p3 = msp.add_polyline3d([(0, 0, 0), (3, 4, 9)])
        mirrored = msp.add_lwpolyline([(1, 0), (5, 0)], dxfattribs={"extrusion": (0, 0, -1)})
        closed = msp.add_lwpolyline([(0, 0), (4, 0), (4, 3)], close=True)
        a, b = dwg_bones.entity_segments(p2)
        self.assertAlmostEqual(a["length"], 5 * math.pi)  # half circle on a 10 chord
        self.assertTrue(a["curved"])
        self.assertEqual((b["x2"], b["y2"], b["curved"]), (10.0, 10.0, False))
        (c,) = dwg_bones.entity_segments(p3)
        self.assertAlmostEqual(c["length"], 5.0)  # plan length: model space is 2D here
        (m,) = dwg_bones.entity_segments(mirrored)
        self.assertAlmostEqual(m["x1"], -1.0)  # OCS (0,0,-1) mirrors X
        self.assertEqual([s["part"] for s in dwg_bones.entity_segments(closed)], [0, 1, 2])
        self.assertEqual(dwg_bones.entity_segments(msp.add_circle((0, 0), 1)), [])

    def test_a_drawing_without_circuit_layers_gets_no_circuits(self):
        doc = ezdxf.new("R2013")
        msp = doc.modelspace()
        msp.add_line((0, 0), (10, 0))
        msp.add_line((10, 0), (10, 10))
        index = self.app.dwg_registry(self.roundtrip(doc), "none")
        self.assertEqual(index["circuits"], [])
        self.assertEqual(len(index["segments"]), 2)

    def test_a_large_pid_fits_uncapped(self):
        # About 1,000 LINEs and 800 LWPOLYLINEs: the size of a large real
        # P&ID. Every list must fit inside its budget.
        doc = ezdxf.new("R2013")
        msp = doc.modelspace()
        for i in range(1000):
            x = (i % 50) * 20.0
            y = (i // 50) * 20.0
            msp.add_line((x, y), (x + 15, y), dxfattribs={"layer": f"Circuit 9{i % 20:04d}-010-01"})
        for i in range(800):
            x = (i % 40) * 25.0
            y = 500 + (i // 40) * 25.0
            msp.add_lwpolyline([(x, y), (x + 10, y), (x + 10, y + 10), (x + 20, y + 10)])
        started = time.monotonic()
        index = self.app.dwg_registry(self.roundtrip(doc), "none")
        elapsed = time.monotonic() - started
        self.assertIsNone(index["geometry_error"])
        self.assertEqual(len(index["segments"]), 1000 + 800 * 3)
        for key in ("segments_capped", "nodes_capped", "inserts_capped", "circuits_capped"):
            self.assertFalse(index[key], key)
        self.assertEqual(len(index["circuits"]), 20)
        self.assertLess(elapsed, 60)
        json.dumps(index, allow_nan=False)


if __name__ == "__main__":
    unittest.main()
