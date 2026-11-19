"""The counts behind a drawing read in part (docs/files.md, "Read in part"):
the registry says every text it met and the texts it cut to its length, and
every layer, so the brain says the cut on the file (read_cut) instead of a
silent one. The DGN reader counts the attribute values it cut.

Run (stdlib unittest; the registry cases skip when ezdxf is missing, unless
PARSER_TESTS_REQUIRE_CAD is set):
    python3 -m unittest discover -s server/parser/cad/tests -v

Generated documents only.
"""

from __future__ import annotations

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

try:
    import ezdxf

    HAVE_EZDXF = True
except Exception:  # pragma: no cover - the venv case
    HAVE_EZDXF = False
    if os.environ.get("PARSER_TESTS_REQUIRE_CAD"):
        raise

import dgn_read  # noqa: E402


@unittest.skipUnless(HAVE_EZDXF, "ezdxf is not installed")
class RegistryCounts(unittest.TestCase):
    def test_texts_seen_and_shortened(self):
        import cad  # noqa: PLC0415 - needs ezdxf

        doc = ezdxf.new("R2010")
        msp = doc.modelspace()
        msp.add_text("TAG-1", dxfattribs={"layer": "A"})
        msp.add_text("x" * 600, dxfattribs={"layer": "A"})
        msp.add_text("y" * 513, dxfattribs={"layer": "B"})
        index = cad.dwg_registry(doc, "dxf")
        self.assertEqual(index["texts_seen"], 3)
        self.assertEqual(index["texts_shortened"], 2)
        self.assertEqual(max(len(t["text"]) for t in index["texts"]), 512)
        self.assertGreaterEqual(index["layers_total"], 2)

    def test_a_drawing_within_the_caps_counts_no_cut(self):
        import cad  # noqa: PLC0415 - needs ezdxf

        doc = ezdxf.new("R2010")
        doc.modelspace().add_text("short", dxfattribs={"layer": "A"})
        index = cad.dwg_registry(doc, "dxf")
        self.assertEqual(index["texts_seen"], 1)
        self.assertEqual(index["texts_shortened"], 0)


class DgnValueCount(unittest.TestCase):
    def test_values_past_the_length_are_counted(self):
        dgn_read._VALUES_CUT[0] = 0
        self.assertEqual(dgn_read._attrib_value("v" * 600), "v" * dgn_read.MAX_VALUE_LEN)
        self.assertEqual(dgn_read._attrib_value("short"), "short")
        self.assertEqual(dgn_read.values_cut(), 1)


if __name__ == "__main__":
    unittest.main()
