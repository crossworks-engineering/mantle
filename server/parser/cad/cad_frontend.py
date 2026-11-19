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
   the dashes on one line. Past MAX_DASHES the hatch is drawn as its
   boundary. Nothing is dropped silently: the caller puts the count in its
   index, and the picture says it is partial.

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
# How a DWG's `partial` list says it (the digest's "Partly read: ...").
OUTLINED = "pattern hatch too fine to draw (drawn as its outline)"


def dashes(polygon, loops, min_distance: float) -> float:
    """About how many dashes ezdxf makes for the pattern of `polygon` inside
    `loops` (its boundary paths): per pattern line, the lines across the
    boundary box's diagonal at the line's spacing, times the dashes along
    one diagonal. A line family too dense for ezdxf ends the count: ezdxf
    stops there too and fills the hatch solid."""
    from ezdxf import path as ezpath  # noqa: PLC0415

    pattern = polygon.pattern
    if pattern is None or not pattern.lines or not loops:
        return 0.0
    box = ezpath.bbox(loops, fast=True)
    if not box.has_data:
        return 0.0
    diag = box.size.magnitude
    total = 0.0
    for line in pattern.lines:
        spacing = abs(Vec2.from_deg_angle(line.angle).det(Vec2(line.offset)))
        if spacing < min_distance:
            break
        across = diag / spacing + 1.0
        items = line.dash_length_items
        length = math.fsum(abs(v) for v in items)
        along = diag / length * len(items) + len(items) if items and length > 0 else 1.0
        total += across * along
    return total


class Frontend(_ezdxf_frontend.Frontend):
    """ezdxf's Frontend; `outlined` counts the pattern hatches it drew as
    their outline (MAX_DASHES)."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.outlined = 0

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
        if dashes(entity, pattern_loops, self.config.min_hatch_line_distance) > MAX_DASHES:
            self.outlined += 1
            self._boundary(entity, properties, loops, outline=True)
            return
        try:
            self.draw_hatch_pattern(entity, pattern_loops, properties)
        except hatching.DenseHatchingLinesError:
            self._boundary(entity, properties, loops, outline=False)

    def _boundary(self, entity, properties, loops, *, outline: bool) -> None:
        """The hatch's boundary in world coordinates, as ezdxf draws a solid
        hatch: filled, or its outline only."""
        if loops is None:  # a HATCH; an MPOLYGON comes with its loops
            loops = _ezdxf_frontend.closed_loops(
                list(entity.paths.rendering_paths(entity.dxf.hatch_style)),
                entity.ocs(),
                entity.dxf.elevation.z,
            )
        paths = list(_ezdxf_frontend.ignore_text_boxes(loops))
        if outline:
            for p in paths:
                self.pipeline.draw_path(p, properties)
        elif paths:
            self.pipeline.draw_filled_paths(paths, properties)
