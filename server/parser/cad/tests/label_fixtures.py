"""Made-up drawings for the label tests (where a redraw sets each text).

Every drawing here is built with ezdxf from numbers chosen by hand: no
customer file and nothing drawn from one. Each text comes with what a
person works out on paper for it: the point on its first line's baseline
(`ax`, `ay`), the side it runs to (`align`), its turn as it reads
(`rotation`) and its lines. test_label_layout.py holds the parser to those;
the same rows, written by `python label_fixtures.py` (then `pnpm format`),
are the fixture of the redraw builder's test
(packages/tools/src/drawing-redraw/label-fixtures.json), and a test here
fails when that file is stale.

The paper rules, for a text of height h turned 0 (up is +y):
  LEFT, CENTER, RIGHT          the point is on the baseline
  MIDDLE, MIDDLE_x             the baseline is h/2 under the point
  TOP_x                        the baseline is h under the point
  BOTTOM_x                     the baseline is h/3 over the point (descender)
  FIT, ALIGNED                 set from the middle of the two points
  MTEXT top / middle / bottom  first baseline h under the top of a block
                               that is h + (lines - 1) * gap high, with
                               gap = h * 5/3 * line spacing factor
A text turned by an angle moves "under" with it. A mirrored text (normal
0,0,-1) is set as it reads: its side swaps.
"""

from __future__ import annotations

import json
import math
import os

import ezdxf
from ezdxf.enums import TextEntityAlignment as A

GAP = 5.0 / 3.0


def _want(text, ax, ay, align, rotation=0.0, lines=None, gap=None, underline=False):
    return {
        "text": text,
        "ax": ax,
        "ay": ay,
        "align": align,
        "rotation": rotation,
        "lines": lines,
        "gap": gap,
        "underline": underline,
    }


def justify():
    """Every TEXT justification, flat and turned 90."""
    doc = ezdxf.new("R2010")
    msp = doc.modelspace()
    want = []
    h = 2.0
    # name: (side, how far the baseline is under the point)
    rules = {
        "LEFT": ("left", 0.0),
        "CENTER": ("center", 0.0),
        "RIGHT": ("right", 0.0),
        "MIDDLE": ("center", h / 2),
        "BOTTOM_LEFT": ("left", -h / 3),
        "BOTTOM_CENTER": ("center", -h / 3),
        "BOTTOM_RIGHT": ("right", -h / 3),
        "MIDDLE_LEFT": ("left", h / 2),
        "MIDDLE_CENTER": ("center", h / 2),
        "MIDDLE_RIGHT": ("right", h / 2),
        "TOP_LEFT": ("left", h),
        "TOP_CENTER": ("center", h),
        "TOP_RIGHT": ("right", h),
    }
    for i, (name, (side, under)) in enumerate(rules.items()):
        x, y = 10.0 + 40.0 * (i % 5), 10.0 + 20.0 * (i // 5)
        msp.add_text(f"flat {name}", height=h).set_placement((x, y), align=A[name])
        want.append(_want(f"flat {name}", x, y - under, side))
        # Turned 90: the text runs up, so "under" is to the right (+x).
        x2 = x + 300.0
        msp.add_text(f"up {name}", height=h, rotation=90).set_placement((x2, y), align=A[name])
        want.append(_want(f"up {name}", x2 + under, y, side, 90.0))
    msp.add_text("fit", height=h).set_placement((0, 100), (30, 100), align=A.FIT)
    want.append(_want("fit", 15.0, 100.0, "center"))
    msp.add_text("aligned", height=h).set_placement((50, 100), (50, 120), align=A.ALIGNED)
    want.append(_want("aligned", 50.0, 110.0, "center", 90.0))
    return doc, want


def mtexts():
    """Every MTEXT attachment point: one line, three lines, a wider line gap,
    a wrap, and a turn."""
    doc = ezdxf.new("R2010")
    msp = doc.modelspace()
    want = []
    h = 2.0
    sides = ("left", "center", "right")
    for ap in range(1, 10):
        side, row = sides[(ap - 1) % 3], (ap - 1) // 3
        x, y = 20.0 + 60.0 * ((ap - 1) % 3), 200.0 - 40.0 * row
        # One line: the block is h high.
        msp.add_mtext(f"one {ap}", dxfattribs={"insert": (x, y), "char_height": h, "attachment_point": ap})
        want.append(_want(f"one {ap}", x, y - (h, h / 2, 0.0)[row], side))
        # Three lines: the block is h + 2 gaps high.
        gap = h * GAP
        block = h + 2 * gap
        first = (h, h - block / 2, h - block)[row]
        x3 = x + 300.0
        msp.add_mtext(
            f"three {ap}\\Psecond\\Pthird",
            dxfattribs={"insert": (x3, y), "char_height": h, "attachment_point": ap},
        )
        want.append(
            _want(f"three {ap} second third", x3, y - first, side, lines=f"three {ap}\nsecond\nthird", gap=gap)
        )
    # A wider line gap (factor 1.5), from the bottom left: two lines.
    gap = h * GAP * 1.5
    msp.add_mtext(
        "wide\\Pgap",
        dxfattribs={"insert": (20, 300), "char_height": h, "attachment_point": 7, "line_spacing_factor": 1.5},
    )
    want.append(_want("wide gap", 20.0, 300.0 + gap, "left", lines="wide\ngap", gap=gap))
    # A box narrower than any word: one word a line, whatever the font.
    msp.add_mtext(
        "AA BB CC",
        dxfattribs={"insert": (100, 300), "char_height": h, "attachment_point": 1, "width": 0.001},
    )
    want.append(_want("AA BB CC", 100.0, 300.0 - h, "left", lines="AA\nBB\nCC", gap=h * GAP))
    # A box far wider than the text: no wrap.
    msp.add_mtext(
        "stays on one line",
        dxfattribs={"insert": (200, 300), "char_height": h, "attachment_point": 1, "width": 5000.0},
    )
    want.append(_want("stays on one line", 200.0, 300.0 - h, "left"))
    # Turned 90 from its top centre: the first baseline is h to the right.
    msp.add_mtext(
        "turned",
        dxfattribs={"insert": (300, 300), "char_height": h, "attachment_point": 2, "rotation": 90},
    )
    want.append(_want("turned", 300.0 + h, 300.0, "center", 90.0))
    # Format codes go; an empty line in the middle stays (a gap).
    msp.add_mtext(
        "{\\fArial|b1;Bold} tag\\P\\Pafter the gap",
        dxfattribs={"insert": (400, 300), "char_height": h, "attachment_point": 1},
    )
    want.append(
        _want("Bold tag after the gap", 400.0, 300.0 - h, "left", lines="Bold tag\n\nafter the gap", gap=h * GAP)
    )
    return doc, want


def blocks():
    """Attributes on plain, turned, scaled and mirrored inserts, a nested
    block, text codes and a mirrored text."""
    doc = ezdxf.new("R2010")
    msp = doc.modelspace()
    want = []
    tag = doc.blocks.new("TAG")
    tag.add_circle((0, 0), 4)
    # A bubble's tag, from its middle; and a note at its right, on the baseline.
    tag.add_attdef("NO", (0, 0), dxfattribs={"height": 1.0}).set_placement((0, 0), align=A.MIDDLE_CENTER)
    tag.add_attdef("NOTE", (5, 0), dxfattribs={"height": 1.0})

    def place(at, values, **attribs):
        ref = msp.add_blockref("TAG", at, dxfattribs=attribs)
        ref.add_auto_attribs(values)

    place((100, 100), {"NO": "FIC-101", "NOTE": "plain"})
    want.append(_want("FIC-101", 100.0, 99.5, "center"))
    want.append(_want("plain", 105.0, 100.0, "left"))
    # Turned 90: the note is 5 over the insert and runs up.
    place((200, 100), {"NO": "TI-202", "NOTE": "turned"}, rotation=90)
    want.append(_want("TI-202", 200.5, 100.0, "center", 90.0))
    want.append(_want("turned", 200.0, 105.0, "left", 90.0))
    # Twice the size: heights and offsets double.
    place((300, 100), {"NO": "PI-303", "NOTE": "big"}, xscale=2, yscale=2)
    want.append(_want("PI-303", 300.0, 99.0, "center"))
    want.append(_want("big", 310.0, 100.0, "left"))
    # Mirrored in x: the note is 5 to the LEFT and ends at that point.
    place((400, 100), {"NO": "LT-404", "NOTE": "mirrored"}, xscale=-1)
    want.append(_want("LT-404", 400.0, 99.5, "center"))
    want.append(_want("mirrored", 395.0, 100.0, "right"))
    # A nested block: its inner text is part of the symbol, not a label; the
    # outer insert's own attribute is a label.
    outer = doc.blocks.new("OUTER")
    outer.add_blockref("TAG", (0, 0))
    outer.add_text("inner", height=1.0).set_placement((0, 6))
    outer.add_attdef("NAME", (0, -6), dxfattribs={"height": 1.5}).set_placement((0, -6), align=A.TOP_CENTER)
    msp.add_blockref("OUTER", (500, 100)).add_auto_attribs({"NAME": "V-505"})
    want.append(_want("V-505", 500.0, 92.5, "center"))
    # Text codes: underline, degree, diameter, plus-minus, a unicode escape.
    msp.add_text("%%uE-11001%%u", height=2.0).set_placement((100, 200), align=A.CENTER)
    want.append(_want("E-11001", 100.0, 200.0, "center", underline=True))
    msp.add_text("45%%d %%c20 %%p0.5 \\U+00B5m", height=2.0).set_placement((200, 200))
    want.append(_want("45° Ø20 ±0.5 µm", 200.0, 200.0, "left"))
    # A mirrored text (normal 0,0,-1): at -300 in its own plane it stands at
    # +300 and runs to the left, so as a person reads it, it ENDS at 300.
    msp.add_text("flipped", height=2.0, dxfattribs={"insert": (-300, 200), "extrusion": (0, 0, -1)})
    want.append(_want("flipped", 300.0, 200.0, "right"))
    return doc, want


def mini_pfd():
    """A small made-up process flow sheet: underlined equipment tags from
    their centre, stream numbers in diamonds from their middle, and a
    stream table with numbers set from the right."""
    doc = ezdxf.new("R2010")
    msp = doc.modelspace()
    want = []
    msp.add_lwpolyline([(0, 0), (420, 0), (420, 297), (0, 297)], close=True)
    for i, name in enumerate(("V-1", "E-2", "P-3A/B")):
        x = 80.0 + 110.0 * i
        msp.add_circle((x, 180), 15)
        msp.add_text(f"%%u{name}%%u", height=3.5).set_placement((x, 205), align=A.CENTER)
        want.append(_want(name, x, 205.0, "center", underline=True))
        msp.add_mtext(
            f"DUTY {i + 1}.5 MW\\PNOTE {i + 1}",
            dxfattribs={"insert": (x, 160), "char_height": 2.5, "attachment_point": 2},
        )
        want.append(
            _want(f"DUTY {i + 1}.5 MW NOTE {i + 1}", x, 157.5, "center", lines=f"DUTY {i + 1}.5 MW\nNOTE {i + 1}", gap=2.5 * GAP)
        )
        msp.add_line((x + 15, 180), (x + 95, 180))
        msp.add_text(str(i + 1), height=2.5).set_placement((x + 55, 180), align=A.MIDDLE)
        want.append(_want(str(i + 1), x + 55.0, 178.75, "center"))
    # The stream table: a name from the left, numbers from the right.
    for r, (name, values) in enumerate((("FLOW kg/h", ("1250", "980", "10")), ("TEMP C", ("45.5", "120", "7.25")))):
        y = 60.0 - 8.0 * r
        msp.add_text(name, height=2.5).set_placement((40, y))
        want.append(_want(name, 40.0, y, "left"))
        for c, v in enumerate(values):
            x = 140.0 + 40.0 * c
            msp.add_text(v, height=2.5).set_placement((x, y), align=A.RIGHT)
            want.append(_want(v, x, y, "right"))
    msp.add_text("PROCESS FLOW DIAGRAM", height=5.0).set_placement((400, 12), align=A.BOTTOM_RIGHT)
    want.append(_want("PROCESS FLOW DIAGRAM", 400.0, 12.0 + 5.0 / 3.0, "right"))
    return doc, want


def mini_pid():
    """A small made-up P&ID: instrument bubbles with two attributes from
    their middle, line numbers along pipes (one turned 90), a valve tag
    under a mirrored valve, and a note."""
    doc = ezdxf.new("R2010")
    msp = doc.modelspace()
    want = []
    bubble = doc.blocks.new("BUBBLE")
    bubble.add_circle((0, 0), 6)
    bubble.add_line((-6, 0), (6, 0))
    bubble.add_attdef("FUNC", (0, 2.5), dxfattribs={"height": 2.0}).set_placement((0, 2.5), align=A.MIDDLE_CENTER)
    bubble.add_attdef("LOOP", (0, -2.5), dxfattribs={"height": 2.0}).set_placement((0, -2.5), align=A.MIDDLE_CENTER)
    valve = doc.blocks.new("VALVE")
    valve.add_lwpolyline([(-4, -2), (-4, 2), (4, -2), (4, 2)], close=True)
    valve.add_attdef("TAG", (-4, -5), dxfattribs={"height": 1.8})
    msp.add_line((20, 100), (300, 100))
    msp.add_line((160, 100), (160, 220))
    for i, (func, loop) in enumerate((("FIC", "101"), ("PT", "102"), ("TI", "103"))):
        x = 60.0 + 80.0 * i
        msp.add_blockref("BUBBLE", (x, 130)).add_auto_attribs({"FUNC": func, "LOOP": loop})
        want.append(_want(func, x, 131.5, "center"))
        want.append(_want(loop, x, 126.5, "center"))
    msp.add_text('2"-P-1001-A1A', height=2.0).set_placement((90, 102), align=A.BOTTOM_CENTER)
    want.append(_want('2"-P-1001-A1A', 90.0, 102.0 + 2.0 / 3.0, "center"))
    # Along the riser: runs up, set from its centre, to the left of the pipe.
    msp.add_text('3"-P-1002-A1A', height=2.0, rotation=90).set_placement((158, 160), align=A.BOTTOM_CENTER)
    want.append(_want('3"-P-1002-A1A', 158.0 - 2.0 / 3.0, 160.0, "center", 90.0))
    msp.add_blockref("VALVE", (120, 100)).add_auto_attribs({"TAG": "HV-1"})
    want.append(_want("HV-1", 116.0, 95.0, "left"))
    # The same valve mirrored: its tag ends 4 to the right of the insert.
    msp.add_blockref("VALVE", (240, 100), dxfattribs={"xscale": -1}).add_auto_attribs({"TAG": "HV-2"})
    want.append(_want("HV-2", 244.0, 95.0, "right"))
    msp.add_mtext(
        "NOTES:\\P1. ALL VENTS TO SAFE LOCATION.",
        dxfattribs={"insert": (20, 60), "char_height": 2.0, "attachment_point": 7},
    )
    want.append(
        _want(
            "NOTES: 1. ALL VENTS TO SAFE LOCATION.",
            20.0,
            60.0 + 2.0 * GAP,
            "left",
            lines="NOTES:\n1. ALL VENTS TO SAFE LOCATION.",
            gap=2.0 * GAP,
        )
    )
    msp.add_text("PIPING AND INSTRUMENT DIAGRAM", height=4.0).set_placement((290, 10), align=A.RIGHT)
    want.append(_want("PIPING AND INSTRUMENT DIAGRAM", 290.0, 10.0, "right"))
    return doc, want


def numbered_pfd():
    """A small made-up process flow sheet on numbered layers, as a drawing
    that came from MicroStation has them: the border and the title block's
    box on one level (loose lines; the bottom line in two pieces, split
    where the title block meets it), the title texts on another, the process
    on a third, its tags on a fourth, and a stream table UNDER the border on
    a fifth. The sheet is 420 x 297 at 0,0; the table runs from y -20 down
    to -65, so the border spans only 82% of the line work's height."""
    doc = ezdxf.new("R2010")
    msp = doc.modelspace()
    want = []
    border = {"layer": "Level 56"}
    for a, b in (
        ((0, 297), (420, 297)),
        ((0, 0), (0, 297)),
        ((420, 0), (420, 297)),
        ((0, 0), (300, 0)),
        ((300, 0), (420, 0)),
        ((300, 0), (300, 40)),
        ((300, 40), (420, 40)),
    ):
        msp.add_line(a, b, dxfattribs=border)
    title = {"layer": "Level 59"}
    msp.add_text("PROCESS FLOW DIAGRAM", height=4.0, dxfattribs=title).set_placement((360, 25), align=A.CENTER)
    want.append(_want("PROCESS FLOW DIAGRAM", 360.0, 25.0, "center"))
    msp.add_text("SHEET 1", height=2.5, dxfattribs=title).set_placement((310, 8))
    want.append(_want("SHEET 1", 310.0, 8.0, "left"))
    process = {"layer": "Level 1"}
    for i, name in enumerate(("C-101", "E-102", "V-103", "P-104", "E-105", "D-106")):
        x = 50.0 + 60.0 * i
        y = 200.0 if i % 2 == 0 else 120.0
        msp.add_circle((x, y), 12, dxfattribs=process)
        msp.add_line((x, y + 12), (x, y + 30), dxfattribs=process)
        msp.add_line((x + 12, y), (x + 40, y), dxfattribs=process)
        msp.add_text(f"%%u{name}%%u", height=3.5, dxfattribs={"layer": "Level 4"}).set_placement(
            (x, y - 20), align=A.CENTER
        )
        want.append(_want(name, x, y - 20.0, "center", underline=True))
    table = {"layer": "Level 33"}
    for r in range(4):
        msp.add_line((20, -20 - 15 * r), (400, -20 - 15 * r), dxfattribs=table)
    for c in range(5):
        msp.add_line((20 + 95 * c, -20), (20 + 95 * c, -65), dxfattribs=table)
    for r, (name, values) in enumerate((("STREAM No", ("1", "2", "3")), ("FLOW kg/h", ("1250", "980", "10")))):
        y = -30.0 - 15.0 * r
        msp.add_text(name, height=2.5, dxfattribs=table).set_placement((25, y))
        want.append(_want(name, 25.0, y, "left"))
        for c, v in enumerate(values):
            x = 205.0 + 95.0 * c
            msp.add_text(v, height=2.5, dxfattribs=table).set_placement((x, y), align=A.RIGHT)
            want.append(_want(v, x, y, "right"))
    return doc, want


FIXTURES = {
    "justify": justify,
    "mtexts": mtexts,
    "blocks": blocks,
    "mini_pfd": mini_pfd,
    "mini_pid": mini_pid,
    "numbered_pfd": numbered_pfd,
}
# Drawings whose line work (the Shapes tab) is in the builder's fixture too.
WITH_SHAPES = ("numbered_pfd",)

# The builder's fixture, next to its test.
JSON_PATH = os.path.normpath(
    os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "..", "..", "..", "..",
        "packages", "tools", "src", "drawing-redraw", "label-fixtures.json",
    )
)


def rows_for_builder(cad) -> dict:
    """Each drawing's registry texts (what the Texts tab holds) with what is
    wanted of each, by name, and for the drawings of WITH_SHAPES their line
    work (what the Shapes tab holds): the redraw builder's fixture."""
    out = {}
    for name, make in FIXTURES.items():
        doc, want = make()
        index = cad.dwg_registry(doc, "dxf")
        # No handle in the fixture: a handle is ezdxf's count of what it
        # made, so another ezdxf version would make the file stale.
        texts = [{k: v for k, v in t.items() if k != "block"} for t in index["texts"]]
        out[name] = {"texts": texts, "want": want}
        if name in WITH_SHAPES:
            out[name]["shapes"] = [{k: v for k, v in h.items() if k != "handle"} for h in index["shapes"]]
    return out


def close(a, b, tol=1e-3) -> bool:
    return a is not None and b is not None and math.isclose(a, b, abs_tol=tol)


if __name__ == "__main__":
    import sys

    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    import cad  # noqa: E402

    with open(JSON_PATH, "w", encoding="utf-8") as f:
        json.dump(rows_for_builder(cad), f, indent=1, ensure_ascii=False, sort_keys=True)
        f.write("\n")
    print(JSON_PATH)
