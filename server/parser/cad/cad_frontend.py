"""The ONE ezdxf drawing frontend of the CAD tier: model.png (cad.py), the
crops (dwg_crop.py) and the symbol SVGs (dwg_symbols.py) all draw through
`Frontend` here. It is ezdxf's own, with two changes, both for pattern
hatches only; everything else draws exactly as before.

1. A pattern too fine for its area is drawn as its outline, and counted
   (`outlined`). ezdxf draws a pattern by collecting every dash of every
   pattern line before it hands one to the backend, and its hatching
   timeout only looks at the clock between lines: a hatch whose pattern
   comes to a billion dashes eats the container's memory long before the
   timeout can stop it. So the dashes are estimated first (`dashes`): the
   lines across the boundary's box, at the pattern's own spacing, times
   the dashes on one line, plus the pieces a jagged boundary cuts the
   lines into. Past MAX_DASHES the hatch is drawn as its boundary. And one
   picture holds every dash it draws until it is saved, so many hatches
   below MAX_DASHES can still fill the memory: a pattern hatch that would
   take the Frontend's dashes past DASH_BUDGET is drawn as its boundary
   too. Nothing is dropped silently: the caller puts the count in its
   index, and the digest says the picture is partial. A hatch in a block
   counts once for every time it is drawn.

2. A pattern denser than ezdxf draws (spacing under its
   `min_hatch_line_distance`) falls back to a solid fill, as in ezdxf. But
   ezdxf 1.4.5 fills the boundary as it stands in the hatch's own plane
   (OCS) without turning it to the world: a hatch whose extrusion is
   (0, 0, -1) then lands mirrored in x, far from its sheet. Here the fill
   takes the boundary in world coordinates, as a solid hatch does.
"""

from __future__ import annotations

import math

from ezdxf.addons.drawing import frontend as _ezdxf_frontend
from ezdxf.addons.drawing.properties import Filling
from ezdxf.math import Vec2
from ezdxf.render import hatching

# Dashes of one pattern hatch past which it is drawn as its outline. A
# million dashes draw in seconds and well under a GB; a fine pattern over a
# boundary a kilometre wide is a thousand times that.
MAX_DASHES = 1_000_000
# Dashes of all the pattern hatches one Frontend draws (one picture): each
# is held, a few hundred bytes, until the picture is saved, so a pattern
# hatch that would go past this is drawn as its outline.
DASH_BUDGET = 3_000_000
# ezdxf draws a dash pattern shorter than this as one solid line.
SOLID_PATTERN = 1e-9


def dashes(polygon, loops, min_distance: float) -> float:
    """About how many dashes ezdxf makes for the pattern of `polygon` inside
    `loops` (its boundary paths), at most: per pattern line, the lines
    across the boundary box's diagonal at the line's spacing, times the
    dashes along one diagonal; and since ezdxf cuts a line at every pair of
    boundary crossings, a jagged boundary adds up to (perimeter / spacing +
    edges) pieces, each with its own dashes. A line family too dense for
    ezdxf ends the count: ezdxf stops there too and fills the hatch solid."""
    from ezdxf import path as ezpath  # noqa: PLC0415

    pattern = polygon.pattern
    if pattern is None or not pattern.lines or not loops:
        return 0.0
    box = ezpath.bbox(loops, fast=True)
    if not box.has_data:
        return 0.0
    diag = box.size.magnitude
    # The control polygon is never shorter than the curve it holds.
    perimeter = math.fsum(_polyline_length(p.control_vertices()) for p in loops)
    edges = sum(len(p) for p in loops)
    total = 0.0
    for line in pattern.lines:
        spacing = abs(Vec2.from_deg_angle(line.angle).det(Vec2(line.offset)))
        if spacing < min_distance:
            break
        items = line.dash_length_items
        length = math.fsum(abs(v) for v in items)
        # A dash is > 0, a dot 0, a gap < 0; ezdxf draws the dashes and dots.
        n = sum(v >= 0 for v in items) if length >= SOLID_PATTERN else 0
        across = diag / spacing + 1.0
        along = diag / length * n + n if n else 1.0
        pieces = perimeter / spacing + edges
        total += across * along + pieces * max(1, n)
    return total


def _polyline_length(points) -> float:
    return math.fsum(a.distance(b) for a, b in zip(points, points[1:]))


class Frontend(_ezdxf_frontend.Frontend):
    """ezdxf's Frontend; `outlined` counts the pattern hatches it drew as
    their outline (MAX_DASHES, DASH_BUDGET), `spent` the dashes it drew."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.outlined = 0
        self.spent = 0.0

    def draw_hatch_entity(self, entity, properties, *, loops=None) -> None:
        filling = properties.filling
        if (
            filling is None
            or filling.type != Filling.PATTERN
            or self.config.hatch_policy != _ezdxf_frontend.HatchPolicy.NORMAL
        ):
            super().draw_hatch_entity(entity, properties, loops=loops)
            return
        # ezdxf's own boundary for the pattern (in the hatch's plane).
        pattern_loops = loops if loops is not None else hatching.hatch_boundary_paths(entity, filter_text_boxes=True)
        n = dashes(entity, pattern_loops, self.config.min_hatch_line_distance)
        # Written as `not ... <=`, so a NaN estimate is outlined too.
        if not (n <= MAX_DASHES and self.spent + n <= DASH_BUDGET):
            self.outlined += 1
            self._boundary(entity, properties, loops, outline=True)
            return
        self.spent += n
        try:
            self.draw_hatch_pattern(entity, pattern_loops, properties)
        except hatching.DenseHatchingLinesError:
            # ezdxf drew none of its dashes: it fills the boundary instead.
            self.spent -= n
            self._boundary(entity, properties, loops, outline=False)

    def _boundary(self, entity, properties, loops, *, outline: bool) -> None:
        """The hatch's boundary in world coordinates, as ezdxf draws a solid
        hatch: filled, or its outline only. An MPOLYGON comes with its
        `loops`, and ezdxf draws its outline after its filling anyway."""
        if loops is None:  # a HATCH
            loops = _ezdxf_frontend.closed_loops(
                list(entity.paths.rendering_paths(entity.dxf.hatch_style)),
                entity.ocs(),
                entity.dxf.elevation.z,
            )
        elif outline:
            return
        paths = list(_ezdxf_frontend.ignore_text_boxes(loops))
        if outline:
            for p in paths:
                self.pipeline.draw_path(p, properties)
        elif paths:
            self.pipeline.draw_filled_paths(paths, properties)
