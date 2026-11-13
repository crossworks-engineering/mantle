"""Where a redraw sets each text: the registry's ax, ay, align, rotation,
lines, gap and underline, held to what a person works out on paper for the
made-up drawings of label_fixtures.py (every TEXT justification, every
MTEXT attachment point, attributes on turned, scaled and mirrored inserts,
a nested block, text codes, a mirrored text, a small PFD and a small P&ID).
"""

from __future__ import annotations

import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

import cad  # noqa: E402
import label_fixtures  # noqa: E402


class LabelLayoutTests(unittest.TestCase):
    def check(self, name: str) -> None:
        doc, want = label_fixtures.FIXTURES[name]()
        texts = cad.dwg_registry(doc, "dxf")["texts"]
        self.assertEqual([t["text"] for t in texts], [w["text"] for w in want])
        for t, w in zip(texts, want):
            with self.subTest(drawing=name, text=w["text"]):
                self.assertTrue(label_fixtures.close(t["ax"], w["ax"]), (t["ax"], w["ax"]))
                self.assertTrue(label_fixtures.close(t["ay"], w["ay"]), (t["ay"], w["ay"]))
                self.assertEqual(t["align"], w["align"])
                turn = (t["rotation"] - w["rotation"]) % 360.0
                self.assertTrue(min(turn, 360.0 - turn) < 0.01, (t["rotation"], w["rotation"]))
                self.assertEqual(t["lines"], w["lines"])
                if w["gap"] is None:
                    self.assertIsNone(t["gap"])
                else:
                    self.assertTrue(label_fixtures.close(t["gap"], w["gap"]), (t["gap"], w["gap"]))
                self.assertEqual(t["underline"], w["underline"])

    def test_every_text_justification(self):
        self.check("justify")

    def test_every_mtext_attachment_point(self):
        self.check("mtexts")

    def test_attributes_on_turned_scaled_and_mirrored_inserts(self):
        self.check("blocks")

    def test_a_small_pfd(self):
        self.check("mini_pfd")

    def test_a_small_pid(self):
        self.check("mini_pid")

    def test_the_insert_point_stays_in_x_and_y(self):
        # X and Y stay the insert (the network's label match reads them), in
        # world units: a mirrored text's is on its own side of the sheet.
        doc, _ = label_fixtures.blocks()
        by_text = {t["text"]: t for t in cad.dwg_registry(doc, "dxf")["texts"]}
        self.assertEqual((by_text["flipped"]["x"], by_text["flipped"]["y"]), (300.0, 200.0))
        self.assertEqual((by_text["plain"]["x"], by_text["plain"]["y"]), (105.0, 100.0))
        # A block attribute's value reads as its text does: no codes.
        self.assertEqual(by_text["E-11001"]["underline"], True)

    def test_an_anchor_keeps_four_decimals(self):
        # A drawing in metres: a text 0.002 high must not move by a rounding
        # of its point to one decimal.
        import ezdxf

        doc = ezdxf.new("R2010")
        doc.modelspace().add_text("small", height=0.002).set_placement((12.3456, 7.8912))
        t = cad.dwg_registry(doc, "dxf")["texts"][0]
        self.assertEqual((t["ax"], t["ay"]), (12.3456, 7.8912))
        self.assertEqual((t["x"], t["y"]), (12.3, 7.9))

    def test_plain_line_reads_the_codes_and_nothing_else(self):
        plain = cad.plain_line
        self.assertEqual(plain("%%UE-1%%u %%O2%%o %%kx%%K"), "E-1 2 x")
        self.assertEqual(plain("45%%D %%C20 %%P1 100%%%"), "45\u00b0 \u00d820 \u00b11 100%")
        self.assertEqual(plain("%%176 %%065 %%007"), "\u00b0 A ")
        # One or two digits are a character too, when no digit follows.
        self.assertEqual(plain("m%%94h %%42 %%9"), "m^h * ")
        self.assertEqual(plain("%%0945"), "^5")
        # A caret is a caret, and a lone percent is a percent.
        self.assertEqual(plain("X^2 m^3/h 50% %d %%x"), "X^2 m^3/h 50% %d %%x")
        # A unicode escape is its character, never a control character.
        self.assertEqual(plain("5\\U+00B5m \\U+0000x\\U+000Ay"), "5\u00b5m xy")

    def test_a_block_value_reads_as_its_text(self):
        import ezdxf

        doc = ezdxf.new("R2010")
        block = doc.blocks.new("B")
        block.add_attdef("SIZE", (0, 0), dxfattribs={"height": 1.0})
        doc.modelspace().add_blockref("B", (0, 0)).add_auto_attribs({"SIZE": "%%c5\\U+00B5m"})
        index = cad.dwg_registry(doc, "dxf")
        self.assertEqual(index["texts"][0]["text"], "\u00d85\u00b5m")
        self.assertEqual(index["blocks"][0]["attribs"], {"SIZE": "\u00d85\u00b5m"})

    def test_an_mtext_with_a_style_the_file_does_not_hold_keeps_its_layout(self):
        import ezdxf

        doc = ezdxf.new("R2010")
        doc.modelspace().add_mtext(
            "one two",
            dxfattribs={"insert": (10, 20), "char_height": 2.0, "attachment_point": 5, "width": 0.001, "style": "NOPE"},
        )
        t = cad.dwg_registry(doc, "dxf")["texts"][0]
        # The usual font measures it: the size, turn, wrap and anchor stay
        # (two lines from the middle: the first baseline is 2 - 8/3 under).
        self.assertEqual((t["height"], t["rotation"], t["width"]), (2.0, 0.0, 0.001))
        self.assertEqual((t["ax"], t["ay"], t["align"], t["lines"]), (10.0, 20.6667, "center", "one\ntwo"))

    def test_a_mirrored_text_that_is_also_turned(self):
        # In its own plane (normal 0,0,-1) it stands at -300 and runs up at
        # 30 degrees. Seen from the front it stands at +300 and runs up and
        # to the LEFT (150 degrees), so as it reads it runs down to the
        # right (330 degrees) and ENDS at the point.
        import ezdxf

        doc = ezdxf.new("R2010")
        doc.modelspace().add_text(
            "flipped", height=2.0, rotation=30, dxfattribs={"insert": (-300, 200), "extrusion": (0, 0, -1)}
        )
        t = cad.dwg_registry(doc, "dxf")["texts"][0]
        self.assertEqual((t["ax"], t["ay"], t["align"], t["rotation"]), (300.0, 200.0, "right", 330.0))

    def test_wrap_lines(self):
        wrap = cad.wrap_lines
        self.assertEqual(wrap(["one two three"], 0, len), ["one two three"])
        self.assertEqual(wrap(["one two three"], 7, len), ["one two", "three"])
        self.assertEqual(wrap(["one two three"], 3, len), ["one", "two", "three"])
        # A word longer than the box stays whole, on its own line.
        self.assertEqual(wrap(["a longerword b"], 4, len), ["a", "longerword", "b"])
        # An empty line in the middle stays; at the end it goes.
        self.assertEqual(wrap(["a", "", "b", "", ""], 0, len), ["a", "", "b"])
        self.assertEqual(wrap(["  spaced   out  "], 0, len), ["spaced out"])

    def test_the_builder_fixture_is_current(self):
        # packages/tools/src/drawing-redraw/label-fixtures.json is these
        # drawings' rows: write it again with `python label_fixtures.py`.
        if not os.path.exists(label_fixtures.JSON_PATH):
            self.skipTest("the builder's fixture is not on this box (the parser image holds no tools package)")
        with open(label_fixtures.JSON_PATH, encoding="utf-8") as f:
            kept = json.load(f)
        now = json.loads(json.dumps(label_fixtures.rows_for_builder(cad)))
        self.assertEqual(sorted(kept), sorted(now))
        for name in now:
            self.assertEqual(kept[name]["want"], now[name]["want"], name)
            self.assertEqual(len(kept[name]["texts"]), len(now[name]["texts"]), name)
            for a, b in zip(kept[name]["texts"], now[name]["texts"]):
                self.assertEqual(sorted(a), sorted(b))
                for key in a:
                    if isinstance(a[key], float) and isinstance(b[key], (int, float)):
                        self.assertTrue(label_fixtures.close(a[key], b[key], 1e-4), (name, key, a[key], b[key]))
                    else:
                        self.assertEqual(a[key], b[key], (name, key))


if __name__ == "__main__":
    unittest.main()
