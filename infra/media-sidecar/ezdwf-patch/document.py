"""High-level DWF drawing model in normalized 2D coordinates."""

from __future__ import annotations

import ast
import os
import re
from collections import Counter
from collections.abc import Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, TypeAlias, cast, overload

from . import _core
from .raw import (
    DEFAULT_LIMITS,
    DwfSource,
    DwfxPackageInfo,
    PackageInfo,
    ParseLimits,
    PathSource,
    Section,
    W2dEntity,
    W2dSourceSpan,
    W2dStream,
    XpsEntity,
    XpsPage,
    _dwfx_from_mapping,
    _load_data,
    _package_from_mapping,
)

RgbaColor: TypeAlias = tuple[int, int, int, int]
Bounds2D: TypeAlias = tuple[float, float, float, float]
Selector: TypeAlias = str | Iterable[str] | None

_SELECTOR = re.compile(r"^\s*(?P<types>[^\[]*?)(?:\[(?P<filters>.*)\])?\s*$")
_CONDITION = re.compile(
    r"^\s*(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*(?P<operator>==|!=)\s*(?P<value>.+?)\s*$"
)
_QUERY_FIELDS = {
    "type",
    "kind",
    "layer",
    "layer_name",
    "layer_number",
    "color_index",
    "visible",
    "viewport",
    "markup",
    "is_markup",
}
_TYPE_ALIASES = {"POLY_BEZIER": "POLYBEZIER"}


@dataclass(frozen=True, slots=True)
class Point2D:
    """A normalized point in the containing sheet's paper coordinate system."""

    x: float
    y: float


@dataclass(frozen=True, slots=True)
class ColoredPoint:
    point: Point2D
    color: RgbaColor


@dataclass(frozen=True, slots=True)
class Image:
    format: str
    identifier: int
    columns: int
    rows: int
    min: Point2D
    max: Point2D
    color_map: tuple[RgbaColor, ...]
    data: bytes


@dataclass(frozen=True, slots=True)
class ImageBrush:
    source: str
    resource_part: str
    content_type: str | None
    data: bytes
    pixel_width: int | None
    pixel_height: int | None
    dpi_x: float | None
    dpi_y: float | None
    physical_size_dip: tuple[float, float] | None
    viewbox: Bounds2D | None
    viewport: Bounds2D | None
    source_viewport: Bounds2D | None
    viewbox_units: str
    viewport_units: str
    tile_mode: str | None
    transform: tuple[float, ...]
    opacity: float


@dataclass(frozen=True, slots=True)
class VisualBrush:
    entities: tuple[Entity, ...]
    viewbox: Bounds2D
    viewport: Bounds2D
    source_viewport: Bounds2D
    viewbox_units: str
    viewport_units: str
    tile_mode: str | None
    transform: tuple[float, ...]
    opacity: float


@dataclass(frozen=True, slots=True)
class SolidBrush:
    color: RgbaColor
    opacity: float


@dataclass(frozen=True, slots=True)
class GradientStop:
    color: RgbaColor | None
    color_value: str
    offset: float


@dataclass(frozen=True, slots=True)
class GradientBrush:
    kind: str
    start_point: Point2D | None
    end_point: Point2D | None
    center: Point2D | None
    gradient_origin: Point2D | None
    x_axis: Point2D | None
    y_axis: Point2D | None
    spread_method: str
    mapping_mode: str
    gradient_stops: tuple[GradientStop, ...]
    opacity: float


@dataclass(frozen=True, slots=True)
class UnsupportedBrush:
    brush_type: str


Brush: TypeAlias = (
    SolidBrush | ImageBrush | VisualBrush | GradientBrush | UnsupportedBrush
)


@dataclass(frozen=True, slots=True)
class PathSegment:
    kind: str
    end: Point2D
    control1: Point2D | None = None
    control2: Point2D | None = None
    control: Point2D | None = None
    center: Point2D | None = None
    x_axis: Point2D | None = None
    y_axis: Point2D | None = None
    start_angle_degrees: float | None = None
    sweep_angle_degrees: float | None = None
    stroked: bool = True
    smooth_join: bool = False


@dataclass(frozen=True, slots=True)
class PathFigure:
    start: Point2D
    segments: tuple[PathSegment, ...]
    closed: bool
    filled: bool


@dataclass(frozen=True, slots=True)
class ClipPath:
    fill_rule: str
    figures: tuple[PathFigure, ...]


@dataclass(frozen=True, slots=True)
class CompositingGroup:
    id: int
    name: str | None
    opacity: float
    clip: ClipPath | None
    opacity_mask: Brush | None


@dataclass(frozen=True, slots=True)
class Style:
    """Resolved W2D rendition state captured for one entity."""

    layer_number: int | None
    layer_name: str | None
    color: RgbaColor | None
    color_index: int | None
    line_pattern: str | None
    line_weight_logical: int | None
    nominal_stroke_width: float | None
    fill: bool
    fill_pattern: str | None
    font_name: str | None
    font_canonical_name: str | None
    font_bold: bool | None
    font_italic: bool | None
    font_underlined: bool | None
    font_height: float | None
    font_rotation_degrees: float | None
    visible: bool
    viewport: str | None
    stroke_color: RgbaColor | None
    fill_color: RgbaColor | None
    opacity: float
    stroke_dash_array: tuple[float, ...]
    stroke_dash_offset: float
    fill_brush: Brush | None
    stroke_brush: Brush | None
    fill_image: ImageBrush | None

    @property
    def layer(self) -> str:
        if self.layer_name is not None:
            return self.layer_name
        if self.layer_number is not None:
            return str(self.layer_number)
        return "0"

    def snapshot(self, *, digits: int = 6) -> dict[str, object]:
        """Return a stable, JSON-serializable style representation."""

        snapshot: dict[str, object] = {
            "layer": self.layer,
            "layer_number": self.layer_number,
            "color": self.color,
            "color_index": self.color_index,
            "line_pattern": self.line_pattern,
            "line_weight_logical": self.line_weight_logical,
            "nominal_stroke_width": _rounded(self.nominal_stroke_width, digits),
            "fill": self.fill,
            "fill_pattern": self.fill_pattern,
            "font_name": self.font_name,
            "font_canonical_name": self.font_canonical_name,
            "font_bold": self.font_bold,
            "font_italic": self.font_italic,
            "font_underlined": self.font_underlined,
            "font_height": _rounded(self.font_height, digits),
            "font_rotation_degrees": _rounded(self.font_rotation_degrees, digits),
            "visible": self.visible,
            "viewport": self.viewport,
        }
        if self.stroke_color != self.color:
            snapshot["stroke_color"] = self.stroke_color
        if self.fill_color is not None and self.fill_color != self.color:
            snapshot["fill_color"] = self.fill_color
        if self.opacity != 1.0:
            snapshot["opacity"] = _rounded(self.opacity, digits)
        if self.stroke_dash_array:
            snapshot["stroke_dash_array"] = tuple(
                _rounded(value, digits) for value in self.stroke_dash_array
            )
            snapshot["stroke_dash_offset"] = _rounded(self.stroke_dash_offset, digits)
        if self.fill_image is not None:
            snapshot["fill_image"] = {
                "source": self.fill_image.source,
                "content_type": self.fill_image.content_type,
                "data_size": len(self.fill_image.data),
                "viewbox": _box_snapshot(self.fill_image.viewbox, digits),
                "viewport": _box_snapshot(self.fill_image.viewport, digits),
                "tile_mode": self.fill_image.tile_mode,
                "opacity": _rounded(self.fill_image.opacity, digits),
            }
        if self.fill_brush is not None:
            snapshot["fill_brush"] = _brush_snapshot(self.fill_brush, digits)
        if self.stroke_brush is not None:
            snapshot["stroke_brush"] = _brush_snapshot(self.stroke_brush, digits)
        return snapshot


@dataclass(frozen=True, slots=True)
class Entity:
    """One normalized entity linked to its raw W2D or XPS record."""

    kind: str
    points: tuple[Point2D, ...]
    center: Point2D | None
    x_axis: Point2D | None
    y_axis: Point2D | None
    start_angle_degrees: float | None
    end_angle_degrees: float | None
    closed: bool
    text: str | None
    bounds: tuple[Point2D, ...] | None
    colored_points: tuple[ColoredPoint, ...]
    contours: tuple[tuple[Point2D, ...], ...]
    image: Image | None
    path: tuple[PathFigure, ...]
    fill_rule: str | None
    clips: tuple[ClipPath, ...]
    local_clips: tuple[ClipPath, ...]
    opacity_masks: tuple[Brush, ...]
    local_opacity_masks: tuple[Brush, ...]
    compositing_groups: tuple[CompositingGroup, ...]
    glyph_outline: tuple[PathFigure, ...] | None
    style: Style
    source: W2dSourceSpan
    resource_href: str
    resource_role: str
    is_markup: bool
    section_index: int
    stream_index: int
    entity_index: int
    raw: W2dEntity | XpsEntity | None = field(repr=False, compare=False)

    def dxftype(self) -> str:
        """Return an ezdxf-style stable uppercase type name."""

        return self.kind

    @property
    def layer(self) -> str:
        return self.style.layer

    def bbox(self) -> Bounds2D | None:
        """Return a conservative paper-space bounding box."""

        points = list(self.points)
        if self.bounds:
            points.extend(self.bounds)
        for contour in self.contours:
            points.extend(contour)
        if self.image is not None:
            points.extend((self.image.min, self.image.max))
        if self.center is not None:
            if self.x_axis is not None and self.y_axis is not None:
                x_radius = (self.x_axis.x**2 + self.y_axis.x**2) ** 0.5
                y_radius = (self.x_axis.y**2 + self.y_axis.y**2) ** 0.5
                points.extend(
                    (
                        Point2D(self.center.x - x_radius, self.center.y - y_radius),
                        Point2D(self.center.x + x_radius, self.center.y + y_radius),
                    )
                )
            else:
                points.append(self.center)
        for figure in self.path:
            points.append(figure.start)
            for segment in figure.segments:
                points.append(segment.end)
                for point in (segment.control1, segment.control2, segment.control):
                    if point is not None:
                        points.append(point)
                if (
                    segment.center is not None
                    and segment.x_axis is not None
                    and segment.y_axis is not None
                ):
                    x_radius = (segment.x_axis.x**2 + segment.y_axis.x**2) ** 0.5
                    y_radius = (segment.x_axis.y**2 + segment.y_axis.y**2) ** 0.5
                    points.extend(
                        (
                            Point2D(
                                segment.center.x - x_radius,
                                segment.center.y - y_radius,
                            ),
                            Point2D(
                                segment.center.x + x_radius,
                                segment.center.y + y_radius,
                            ),
                        )
                    )
        if self.glyph_outline:
            for figure in self.glyph_outline:
                points.append(figure.start)
                for segment in figure.segments:
                    points.append(segment.end)
                    for point in (segment.control1, segment.control2, segment.control):
                        if point is not None:
                            points.append(point)
        return _points_bounds(points)

    def snapshot(self, *, digits: int = 6) -> dict[str, object]:
        """Return deterministic geometry, style, and source data for regression."""

        snapshot: dict[str, object] = {
            "type": self.kind,
            "points": tuple(_point_snapshot(point, digits) for point in self.points),
            "center": _optional_point_snapshot(self.center, digits),
            "x_axis": _optional_point_snapshot(self.x_axis, digits),
            "y_axis": _optional_point_snapshot(self.y_axis, digits),
            "start_angle_degrees": _rounded(self.start_angle_degrees, digits),
            "end_angle_degrees": _rounded(self.end_angle_degrees, digits),
            "closed": self.closed,
            "text": self.text,
            "bounds": (
                tuple(_point_snapshot(point, digits) for point in self.bounds)
                if self.bounds
                else None
            ),
            "style": self.style.snapshot(digits=digits),
            "source": {
                "resource": self.resource_href,
                "offset": self.source.offset,
                "length": self.source.length,
                "opcode": self.source.opcode,
            },
        }
        if self.colored_points:
            snapshot["colored_points"] = tuple(
                {"point": _point_snapshot(item.point, digits), "color": item.color}
                for item in self.colored_points
            )
        if self.contours:
            snapshot["contours"] = tuple(
                tuple(_point_snapshot(point, digits) for point in contour)
                for contour in self.contours
            )
        if self.image is not None:
            snapshot["image"] = {
                "format": self.image.format,
                "identifier": self.image.identifier,
                "columns": self.image.columns,
                "rows": self.image.rows,
                "min": _point_snapshot(self.image.min, digits),
                "max": _point_snapshot(self.image.max, digits),
                "color_map_size": len(self.image.color_map),
                "data_size": len(self.image.data),
            }
        if self.path:
            snapshot["fill_rule"] = self.fill_rule
            snapshot["path"] = tuple(
                {
                    "start": _point_snapshot(figure.start, digits),
                    "closed": figure.closed,
                    "filled": figure.filled,
                    "segments": tuple(
                        _path_segment_snapshot(segment, digits)
                        for segment in figure.segments
                    ),
                }
                for figure in self.path
            )
        if self.clips:
            snapshot["clips"] = tuple(
                {
                    "fill_rule": clip.fill_rule,
                    "figures": tuple(
                        {
                            "start": _point_snapshot(figure.start, digits),
                            "closed": figure.closed,
                            "filled": figure.filled,
                            "segments": tuple(
                                _path_segment_snapshot(segment, digits)
                                for segment in figure.segments
                            ),
                        }
                        for figure in clip.figures
                    ),
                }
                for clip in self.clips
            )
        if self.opacity_masks:
            snapshot["opacity_masks"] = tuple(
                _brush_snapshot(mask, digits) for mask in self.opacity_masks
            )
        if self.is_markup:
            snapshot["is_markup"] = True
        if self.source.compression_depth:
            source = cast(dict[str, object], snapshot["source"])
            source["decoded_offset"] = self.source.decoded_offset
            source["decoded_length"] = self.source.decoded_length
            source["compression_depth"] = self.source.compression_depth
        return snapshot


class EntityQuery(Sequence[Entity]):
    """Immutable, chainable entity selection similar to ``ezdxf`` queries."""

    __slots__ = ("_entities",)

    def __init__(self, entities: Iterable[Entity] = ()) -> None:
        self._entities = tuple(entities)

    def __iter__(self) -> Iterator[Entity]:
        return iter(self._entities)

    def __len__(self) -> int:
        return len(self._entities)

    @overload
    def __getitem__(self, index: int) -> Entity: ...

    @overload
    def __getitem__(self, index: slice) -> EntityQuery: ...

    def __getitem__(self, index: int | slice) -> Entity | EntityQuery:
        value = self._entities[index]
        return EntityQuery(value) if isinstance(index, slice) else value

    @property
    def first(self) -> Entity | None:
        return self._entities[0] if self._entities else None

    def query(
        self,
        selector: Selector = None,
        *,
        layer: str | int | None = None,
        color_index: int | None = None,
        visible: bool | None = None,
        viewport: str | None = None,
        markup: bool | None = None,
    ) -> EntityQuery:
        """Select types and rendition attributes.

        Examples include ``"LINE CIRCLE"`` and
        ``'POLYLINE[layer=="walls", visible==true]'``.
        """

        types, conditions = _parse_selector(selector)
        entities = self._entities
        if types is not None:
            entities = tuple(entity for entity in entities if entity.kind in types)
        for name, operator, expected in conditions:
            entities = tuple(
                entity
                for entity in entities
                if _condition_matches(entity, name, operator, expected)
            )
        if layer is not None:
            entities = tuple(
                entity
                for entity in entities
                if entity.layer == str(layer) or entity.style.layer_number == layer
            )
        if color_index is not None:
            entities = tuple(
                entity for entity in entities if entity.style.color_index == color_index
            )
        if visible is not None:
            entities = tuple(
                entity for entity in entities if entity.style.visible is visible
            )
        if viewport is not None:
            entities = tuple(
                entity for entity in entities if entity.style.viewport == viewport
            )
        if markup is not None:
            entities = tuple(
                entity for entity in entities if entity.is_markup is markup
            )
        return EntityQuery(entities)

    def bbox(self) -> Bounds2D | None:
        bounds = None
        for entity in self._entities:
            bounds = _union_bounds(bounds, entity.bbox())
        return bounds

    def stats(self) -> dict[str, object]:
        by_type = Counter(entity.kind for entity in self._entities)
        by_layer = Counter(entity.layer for entity in self._entities)
        return {
            "entity_count": len(self),
            "visible_count": sum(entity.style.visible for entity in self._entities),
            "by_type": dict(sorted(by_type.items())),
            "by_layer": dict(sorted(by_layer.items())),
        }


@dataclass(frozen=True, slots=True)
class Sheet:
    """One DWF ePlot or DWFx FixedPage sheet in its paper units."""

    name: str
    title: str | None
    plot_order: int | None
    units: str | None
    paper_bounds: Bounds2D | None
    clip: Bounds2D | None
    background_color: tuple[int, int, int] | None
    content_bounds: Bounds2D | None
    entities: EntityQuery
    markup_entities: EntityQuery
    section_index: int
    raw: Section | W2dStream | XpsPage = field(repr=False, compare=False)

    def __iter__(self) -> Iterator[Entity]:
        return iter(self.entities)

    def __len__(self) -> int:
        return len(self.entities)

    def query(self, selector: Selector = None, **filters: object) -> EntityQuery:
        return self.entities.query(selector, **filters)

    @property
    def layers(self) -> tuple[str, ...]:
        return tuple(sorted({entity.layer for entity in self.entities}))

    @property
    def all_entities(self) -> EntityQuery:
        """Primary and markup entities, preserving stream order per group."""

        return EntityQuery((*self.entities, *self.markup_entities))

    def bbox(self) -> Bounds2D | None:
        return self.content_bounds

    def stats(self) -> dict[str, object]:
        return self.entities.stats()

    def snapshot(self, *, digits: int = 6) -> dict[str, object]:
        return {
            "name": self.name,
            "title": self.title,
            "plot_order": self.plot_order,
            "units": self.units,
            "paper_bounds": _box_snapshot(self.paper_bounds, digits),
            "clip": _box_snapshot(self.clip, digits),
            "content_bounds": _box_snapshot(self.content_bounds, digits),
            "background_color": self.background_color,
            "stats": self.stats(),
            "entities": tuple(
                entity.snapshot(digits=digits) for entity in self.entities
            ),
            "markup_entities": tuple(
                entity.snapshot(digits=digits) for entity in self.markup_entities
            ),
        }

    def render_svg(self, **options: object) -> str:
        from .svg import render_svg

        return render_svg(self, **options)

    def save_svg(self, output: str | os.PathLike[str], **options: object) -> Path:
        from .svg import save_svg

        return save_svg(self, output, **options)

    def plot(self, **options: object) -> tuple[Any, Any]:
        """Render this sheet on Matplotlib axes and return ``(figure, axes)``."""

        from .matplotlib import plot

        return plot(self, **options)

    def save_plot(self, output: str | os.PathLike[str], **options: object) -> Path:
        """Render this sheet to a Matplotlib-supported image format."""

        from .matplotlib import save_plot

        return save_plot(self, output, **options)


@dataclass(frozen=True, slots=True)
class Drawing:
    """High-level DWF drawing containing ordered normalized sheets."""

    package: PackageInfo | None
    legacy_stream: W2dStream | None
    dwfx_package: DwfxPackageInfo | None
    sheets: tuple[Sheet, ...]
    source_name: str | None = None

    @property
    def raw(self) -> PackageInfo | W2dStream | DwfxPackageInfo:
        if self.package is not None:
            return self.package
        if self.legacy_stream is not None:
            return self.legacy_stream
        assert self.dwfx_package is not None
        return self.dwfx_package

    @property
    def diagnostics(self):
        return self.raw.diagnostics

    @property
    def is_legacy(self) -> bool:
        return self.legacy_stream is not None

    @property
    def is_dwfx(self) -> bool:
        return self.dwfx_package is not None

    def __iter__(self) -> Iterator[Sheet]:
        return iter(self.sheets)

    def __len__(self) -> int:
        return len(self.sheets)

    def sheet(self, key: int | str = 0) -> Sheet:
        if isinstance(key, int):
            return self.sheets[key]
        matches = tuple(
            sheet for sheet in self.sheets if key in {sheet.name, sheet.title}
        )
        if not matches:
            raise KeyError(f"DWF sheet not found: {key!r}")
        if len(matches) > 1:
            raise KeyError(f"DWF sheet name is ambiguous: {key!r}")
        return matches[0]

    def modelspace(self) -> Sheet:
        """Return the first normalized sheet for API parity with sibling packages."""

        if not self.sheets:
            raise IndexError("DWF drawing contains no ePlot sheets")
        return self.sheets[0]

    def query(self, selector: Selector = None, **filters: object) -> EntityQuery:
        return EntityQuery(
            entity for sheet in self.sheets for entity in sheet.entities
        ).query(selector, **filters)

    def stats(self) -> dict[str, object]:
        entities = EntityQuery(
            entity for sheet in self.sheets for entity in sheet.entities
        )
        return {"sheet_count": len(self.sheets), **entities.stats()}

    def plot(self, **options: object) -> tuple[Any, Any]:
        """Render one drawing sheet and return Matplotlib ``(figure, axes)``."""

        from .matplotlib import plot

        return plot(self, **options)

    def save_plot(self, output: str | os.PathLike[str], **options: object) -> Path:
        """Render one drawing sheet to a Matplotlib-supported image format."""

        from .matplotlib import save_plot

        return save_plot(self, output, **options)


def read(
    source: DwfSource,
    *,
    limits: ParseLimits = DEFAULT_LIMITS,
) -> Drawing:
    """Parse DWF 6, DWFx, or a legacy 2D stream into raw and normalized views."""

    data = _load_data(source, max_file_size=limits.max_file_size)
    # Streamed conversion: the handle keeps the parsed drawing in Rust and
    # hands over one piece at a time (package shell, then per-stream raw
    # entities, then per-sheet normalized entities). Each piece's dict tree
    # is folded into dataclasses and freed before the next converts, so peak
    # memory tracks the largest single piece instead of the whole drawing —
    # a 630 KB / 9-sheet real plot set drops from ~1.27 GB peak RSS to a few
    # hundred MB with byte-identical results.
    handle = _core.read_drawing_handle(data, *limits.as_args())
    source_name = os.fspath(source) if isinstance(source, (str, os.PathLike)) else None
    return _drawing_from_handle(handle, source_name=source_name)


def readfile(
    path: PathSource,
    *,
    limits: ParseLimits = DEFAULT_LIMITS,
) -> Drawing:
    """Read a filesystem path with the high-level normalized model."""

    if not isinstance(path, (str, os.PathLike)):
        raise TypeError("readfile() requires a filesystem path")
    return read(path, limits=limits)


def _drawing_from_mapping(
    result: Mapping[str, Any],
    *,
    source_name: str | None,
) -> Drawing:
    package_value = cast(Mapping[str, Any] | None, result.get("package"))
    package = (
        _package_from_mapping(package_value) if package_value is not None else None
    )
    dwfx_value = cast(Mapping[str, Any] | None, result.get("dwfx_package"))
    dwfx_package = _dwfx_from_mapping(dwfx_value) if dwfx_value is not None else None
    legacy_value = cast(Mapping[str, Any] | None, result.get("legacy_stream"))
    if legacy_value is None:
        legacy_stream = None
    else:
        from .raw import _w2d_stream

        legacy_stream = _w2d_stream(legacy_value)
    drawing_value = cast(Mapping[str, Any], result["drawing"])
    sheets = [
        _sheet_from_mapping(sheet_value, package, legacy_stream, dwfx_package)
        for sheet_value in cast(list[Mapping[str, Any]], drawing_value.get("sheets", []))
    ]
    return Drawing(
        package=package,
        legacy_stream=legacy_stream,
        dwfx_package=dwfx_package,
        sheets=tuple(sheets),
        source_name=source_name,
    )


def _sheet_from_mapping(
    sheet_value: Mapping[str, Any],
    package: PackageInfo | None,
    legacy_stream: W2dStream | None,
    dwfx_package: DwfxPackageInfo | None,
) -> Sheet:
    section_index = int(sheet_value["section_index"])
    raw_section: Section | W2dStream | XpsPage
    if package is not None:
        raw_section = package.manifest.sections[section_index]
    elif dwfx_package is not None:
        raw_section = dwfx_package.pages[section_index]
    else:
        assert legacy_stream is not None
        raw_section = legacy_stream
    entities = tuple(
        _entity_from_mapping(entity_value, package, legacy_stream, dwfx_package)
        for entity_value in cast(
            list[Mapping[str, Any]], sheet_value.get("entities", [])
        )
    )
    markup_entities = tuple(
        _entity_from_mapping(entity_value, package, legacy_stream, dwfx_package)
        for entity_value in cast(
            list[Mapping[str, Any]], sheet_value.get("markup_entities", [])
        )
    )
    return Sheet(
        name=str(sheet_value["name"]),
        title=_optional_str(sheet_value.get("title")),
        plot_order=cast(int | None, sheet_value.get("plot_order")),
        units=_optional_str(sheet_value.get("units")),
        paper_bounds=_optional_box(sheet_value.get("paper_bounds")),
        clip=_optional_box(sheet_value.get("clip")),
        background_color=_optional_rgb(sheet_value.get("background_color")),
        content_bounds=_optional_box(sheet_value.get("content_bounds")),
        entities=EntityQuery(entities),
        markup_entities=EntityQuery(markup_entities),
        section_index=section_index,
        raw=raw_section,
    )


def _drawing_from_handle(
    handle: Any,
    *,
    source_name: str | None,
) -> Drawing:
    """Build a :class:`Drawing` from a ``_core.DrawingHandle``, converting one
    piece at a time so no monolithic dict tree ever exists (see ``read``)."""

    package: PackageInfo | None = None
    legacy_stream: W2dStream | None = None
    dwfx_package: DwfxPackageInfo | None = None
    kind = handle.kind()
    if kind == "package":
        shell = cast(Mapping[str, Any], handle.package_shell())
        package = _package_from_mapping(
            shell, stream_entities_loader=handle.stream_entities
        )
        del shell
    elif kind == "legacy":
        from .raw import _w2d_stream

        legacy_stream = _w2d_stream(cast(Mapping[str, Any], handle.legacy_stream()))
    else:
        dwfx_package = _dwfx_from_mapping(cast(Mapping[str, Any], handle.dwfx_package()))
    sheets = []
    for index in range(handle.sheet_count()):
        sheet_value = cast(Mapping[str, Any], handle.sheet(index))
        sheets.append(
            _sheet_from_mapping(sheet_value, package, legacy_stream, dwfx_package)
        )
        del sheet_value
    return Drawing(
        package=package,
        legacy_stream=legacy_stream,
        dwfx_package=dwfx_package,
        sheets=tuple(sheets),
        source_name=source_name,
    )


def _path_segment_from_mapping(value: Mapping[str, Any]) -> PathSegment:
    return PathSegment(
        kind=str(value["kind"]),
        end=_point(value["end"]),
        control1=_optional_point(value.get("control1")),
        control2=_optional_point(value.get("control2")),
        control=_optional_point(value.get("control")),
        center=_optional_point(value.get("center")),
        x_axis=_optional_point(value.get("x_axis")),
        y_axis=_optional_point(value.get("y_axis")),
        start_angle_degrees=cast(float | None, value.get("start_angle_degrees")),
        sweep_angle_degrees=cast(float | None, value.get("sweep_angle_degrees")),
        stroked=bool(value.get("stroked", True)),
        smooth_join=bool(value.get("smooth_join", False)),
    )


def _path_figure_from_mapping(value: Mapping[str, Any]) -> PathFigure:
    return PathFigure(
        start=_point(value["start"]),
        segments=tuple(
            _path_segment_from_mapping(segment)
            for segment in cast(list[Mapping[str, Any]], value.get("segments", []))
        ),
        closed=bool(value["closed"]),
        filled=bool(value["filled"]),
    )


def _clip_from_mapping(value: Mapping[str, Any]) -> ClipPath:
    return ClipPath(
        fill_rule=str(value["fill_rule"]),
        figures=tuple(
            _path_figure_from_mapping(figure)
            for figure in cast(list[Mapping[str, Any]], value.get("figures", []))
        ),
    )


def _entity_from_mapping(
    value: Mapping[str, Any],
    package: PackageInfo | None,
    legacy_stream: W2dStream | None,
    dwfx_package: DwfxPackageInfo | None,
    *,
    embedded: bool = False,
) -> Entity:
    section_index = int(value["section_index"])
    stream_index = int(value["stream_index"])
    entity_index = int(value["entity_index"])
    if embedded:
        raw = None
    elif package is not None:
        raw = (
            package.manifest.sections[section_index]
            .w2d_streams[stream_index]
            .entities[entity_index]
        )
    elif dwfx_package is not None:
        raw = dwfx_package.pages[section_index].entities[entity_index]
    else:
        assert legacy_stream is not None
        raw = legacy_stream.entities[entity_index]
    style_value = cast(Mapping[str, Any], value["style"])
    source_value = cast(Mapping[str, Any], value["source"])
    image_value = cast(Mapping[str, Any] | None, value.get("image"))
    return Entity(
        kind=str(value["kind"]),
        points=tuple(
            _point(point) for point in cast(list[object], value.get("points", []))
        ),
        center=_optional_point(value.get("center")),
        x_axis=_optional_point(value.get("x_axis")),
        y_axis=_optional_point(value.get("y_axis")),
        start_angle_degrees=cast(float | None, value.get("start_angle_degrees")),
        end_angle_degrees=cast(float | None, value.get("end_angle_degrees")),
        closed=bool(value.get("closed", False)),
        text=_optional_str(value.get("text")),
        bounds=(
            tuple(_point(point) for point in cast(list[object], value["bounds"]))
            if value.get("bounds") is not None
            else None
        ),
        colored_points=tuple(
            ColoredPoint(
                point=_point(item["point"]),
                color=cast(RgbaColor, _optional_rgba(item["color"])),
            )
            for item in cast(list[Mapping[str, Any]], value.get("colored_points", []))
        ),
        contours=tuple(
            tuple(_point(point) for point in contour)
            for contour in cast(list[list[object]], value.get("contours", []))
        ),
        image=(
            Image(
                format=str(image_value["format"]),
                identifier=int(image_value["identifier"]),
                columns=int(image_value["columns"]),
                rows=int(image_value["rows"]),
                min=_point(image_value["min"]),
                max=_point(image_value["max"]),
                color_map=tuple(
                    cast(RgbaColor, _optional_rgba(color))
                    for color in cast(list[object], image_value.get("color_map", []))
                ),
                data=bytes(image_value["data"]),
            )
            if image_value is not None
            else None
        ),
        path=tuple(
            _path_figure_from_mapping(figure)
            for figure in cast(list[Mapping[str, Any]], value.get("path", []))
        ),
        fill_rule=_optional_str(value.get("fill_rule")),
        clips=tuple(
            _clip_from_mapping(clip)
            for clip in cast(list[Mapping[str, Any]], value.get("clips", []))
        ),
        local_clips=tuple(
            _clip_from_mapping(clip)
            for clip in cast(list[Mapping[str, Any]], value.get("local_clips", []))
        ),
        opacity_masks=tuple(
            _brush_from_mapping(mask)
            for mask in cast(list[Mapping[str, Any]], value.get("opacity_masks", []))
        ),
        local_opacity_masks=tuple(
            _brush_from_mapping(mask)
            for mask in cast(
                list[Mapping[str, Any]], value.get("local_opacity_masks", [])
            )
        ),
        compositing_groups=tuple(
            CompositingGroup(
                id=int(group["id"]),
                name=_optional_str(group.get("name")),
                opacity=float(group.get("opacity", 1.0)),
                clip=(
                    _clip_from_mapping(cast(Mapping[str, Any], group["clip"]))
                    if group.get("clip") is not None
                    else None
                ),
                opacity_mask=(
                    _brush_from_mapping(cast(Mapping[str, Any], group["opacity_mask"]))
                    if group.get("opacity_mask") is not None
                    else None
                ),
            )
            for group in cast(
                list[Mapping[str, Any]], value.get("compositing_groups", [])
            )
        ),
        glyph_outline=(
            tuple(
                _path_figure_from_mapping(figure)
                for figure in cast(
                    list[Mapping[str, Any]], value.get("glyph_outline", [])
                )
            )
            if value.get("glyph_outline") is not None
            else None
        ),
        style=_style_from_mapping(style_value),
        source=W2dSourceSpan(
            offset=int(source_value["offset"]),
            length=int(source_value["length"]),
            opcode=str(source_value["opcode"]),
            decoded_offset=cast(int | None, source_value.get("decoded_offset")),
            decoded_length=cast(int | None, source_value.get("decoded_length")),
            compression_depth=int(source_value.get("compression_depth", 0)),
        ),
        resource_href=str(value["resource_href"]),
        resource_role=str(value.get("resource_role", "")),
        is_markup=bool(value.get("is_markup", False)),
        section_index=section_index,
        stream_index=stream_index,
        entity_index=entity_index,
        raw=raw,
    )


def _style_from_mapping(value: Mapping[str, Any]) -> Style:
    fill_value = cast(Mapping[str, Any] | None, value.get("fill_brush"))
    stroke_value = cast(Mapping[str, Any] | None, value.get("stroke_brush"))
    fill_brush = _brush_from_mapping(fill_value) if fill_value is not None else None
    if fill_brush is None:
        image_value = cast(Mapping[str, Any] | None, value.get("fill_image"))
        if image_value is not None:
            fill_brush = _brush_from_mapping({"kind": "image", **image_value})
    return Style(
        layer_number=cast(int | None, value.get("layer_number")),
        layer_name=_optional_str(value.get("layer_name")),
        color=_optional_rgba(value.get("color")),
        color_index=cast(int | None, value.get("color_index")),
        line_pattern=_optional_str(value.get("line_pattern")),
        line_weight_logical=cast(int | None, value.get("line_weight_logical")),
        nominal_stroke_width=cast(float | None, value.get("nominal_stroke_width")),
        fill=bool(value.get("fill", False)),
        fill_pattern=_optional_str(value.get("fill_pattern")),
        font_name=_optional_str(value.get("font_name")),
        font_canonical_name=_optional_str(value.get("font_canonical_name")),
        font_bold=cast(bool | None, value.get("font_bold")),
        font_italic=cast(bool | None, value.get("font_italic")),
        font_underlined=cast(bool | None, value.get("font_underlined")),
        font_height=cast(float | None, value.get("font_height")),
        font_rotation_degrees=cast(float | None, value.get("font_rotation_degrees")),
        visible=bool(value.get("visible", True)),
        viewport=_optional_str(value.get("viewport")),
        stroke_color=_optional_rgba(value.get("stroke_color")),
        fill_color=_optional_rgba(value.get("fill_color")),
        opacity=float(value.get("opacity", 1.0)),
        stroke_dash_array=tuple(
            float(item)
            for item in cast(list[object], value.get("stroke_dash_array", []))
        ),
        stroke_dash_offset=float(value.get("stroke_dash_offset", 0.0)),
        fill_brush=fill_brush,
        stroke_brush=(
            _brush_from_mapping(stroke_value) if stroke_value is not None else None
        ),
        fill_image=fill_brush if isinstance(fill_brush, ImageBrush) else None,
    )


def _brush_from_mapping(value: Mapping[str, Any]) -> Brush:
    kind = str(value["kind"])
    if kind == "solid":
        color = _optional_rgba(value.get("color"))
        if color is None:
            raise ValueError("normalized solid brush has no color")
        return SolidBrush(color=color, opacity=float(value.get("opacity", 1.0)))
    if kind == "image":
        return ImageBrush(
            source=str(value["source"]),
            resource_part=str(value.get("resource_part", "")),
            content_type=_optional_str(value.get("content_type")),
            data=bytes(value.get("data", b"")),
            pixel_width=cast(int | None, value.get("pixel_width")),
            pixel_height=cast(int | None, value.get("pixel_height")),
            dpi_x=cast(float | None, value.get("dpi_x")),
            dpi_y=cast(float | None, value.get("dpi_y")),
            physical_size_dip=(
                cast(
                    tuple[float, float],
                    tuple(float(item) for item in value["physical_size_dip"]),
                )
                if value.get("physical_size_dip") is not None
                else None
            ),
            viewbox=_optional_box(value.get("viewbox")),
            viewport=_optional_box(value.get("viewport")),
            source_viewport=_optional_box(value.get("source_viewport")),
            viewbox_units=str(value.get("viewbox_units", "Absolute")),
            viewport_units=str(value.get("viewport_units", "Absolute")),
            tile_mode=_optional_str(value.get("tile_mode")),
            transform=tuple(
                float(item)
                for item in cast(
                    list[object], value.get("transform", [1, 0, 0, 1, 0, 0])
                )
            ),
            opacity=float(value.get("opacity", 1.0)),
        )
    if kind == "visual":
        viewbox = _optional_box(value.get("viewbox"))
        viewport = _optional_box(value.get("viewport"))
        source_viewport = _optional_box(value.get("source_viewport"))
        if viewbox is None or viewport is None or source_viewport is None:
            raise ValueError(
                "normalized visual brush is missing its viewbox or viewport"
            )
        return VisualBrush(
            entities=tuple(
                _entity_from_mapping(entity, None, None, None, embedded=True)
                for entity in cast(list[Mapping[str, Any]], value.get("entities", []))
            ),
            viewbox=viewbox,
            viewport=viewport,
            source_viewport=source_viewport,
            viewbox_units=str(value.get("viewbox_units", "Absolute")),
            viewport_units=str(value.get("viewport_units", "Absolute")),
            tile_mode=_optional_str(value.get("tile_mode")),
            transform=tuple(
                float(item)
                for item in cast(
                    list[object], value.get("transform", [1, 0, 0, 1, 0, 0])
                )
            ),
            opacity=float(value.get("opacity", 1.0)),
        )
    if kind in {"linear_gradient", "radial_gradient"}:
        return GradientBrush(
            kind=kind,
            start_point=_optional_point(value.get("start_point")),
            end_point=_optional_point(value.get("end_point")),
            center=_optional_point(value.get("center")),
            gradient_origin=_optional_point(value.get("gradient_origin")),
            x_axis=_optional_point(value.get("x_axis")),
            y_axis=_optional_point(value.get("y_axis")),
            spread_method=str(value.get("spread_method", "Pad")),
            mapping_mode=str(value.get("mapping_mode", "Absolute")),
            gradient_stops=tuple(
                GradientStop(
                    color=_optional_rgba(stop.get("color")),
                    color_value=str(stop["color_value"]),
                    offset=float(stop["offset"]),
                )
                for stop in cast(
                    list[Mapping[str, Any]], value.get("gradient_stops", [])
                )
            ),
            opacity=float(value.get("opacity", 1.0)),
        )
    return UnsupportedBrush(brush_type=str(value.get("brush_type", kind)))


def _parse_selector(
    selector: Selector,
) -> tuple[set[str] | None, tuple[tuple[str, str, object], ...]]:
    if selector is None:
        return None, ()
    if not isinstance(selector, str):
        types = {_normalize_type(value) for value in selector}
        return (types or None), ()
    match = _SELECTOR.fullmatch(selector)
    if match is None:
        raise ValueError(f"invalid entity selector: {selector!r}")
    raw_types = match.group("types").strip()
    types = {
        _normalize_type(value)
        for value in re.split(r"[\s,]+", raw_types)
        if value and value != "*"
    }
    conditions = []
    raw_filters = match.group("filters")
    if raw_filters:
        for raw_condition in _split_conditions(raw_filters):
            condition = _CONDITION.fullmatch(raw_condition)
            if condition is None:
                raise ValueError(f"invalid query condition: {raw_condition!r}")
            name = condition.group("name").lower()
            if name not in _QUERY_FIELDS:
                raise ValueError(f"unsupported query field: {name!r}")
            conditions.append(
                (
                    name,
                    condition.group("operator"),
                    _parse_query_value(condition.group("value")),
                )
            )
    return (types or None), tuple(conditions)


def _split_conditions(value: str) -> tuple[str, ...]:
    output = []
    start = 0
    quote = None
    escaped = False
    for index, character in enumerate(value):
        if quote is not None:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == quote:
                quote = None
        elif character in {'"', "'"}:
            quote = character
        elif character == ",":
            output.append(value[start:index].strip())
            start = index + 1
    if quote is not None:
        raise ValueError("unterminated quoted value in entity selector")
    output.append(value[start:].strip())
    if any(not item for item in output):
        raise ValueError("empty condition in entity selector")
    return tuple(output)


def _parse_query_value(value: str) -> object:
    lowered = value.casefold()
    if lowered == "true":
        return True
    if lowered == "false":
        return False
    if lowered in {"none", "null"}:
        return None
    try:
        parsed = ast.literal_eval(value)
    except (SyntaxError, ValueError):
        parsed = value.strip()
    if not isinstance(parsed, (str, int, bool)) and parsed is not None:
        raise ValueError(f"unsupported query value: {value!r}")
    return parsed


def _condition_matches(
    entity: Entity, name: str, operator: str, expected: object
) -> bool:
    if name in {"type", "kind"}:
        actual: object = entity.kind
        expected = _normalize_type(str(expected))
    elif name == "layer":
        actual = entity.layer
    elif name == "layer_name":
        actual = entity.style.layer_name
    elif name == "layer_number":
        actual = entity.style.layer_number
    elif name == "color_index":
        actual = entity.style.color_index
    elif name == "visible":
        actual = entity.style.visible
    elif name in {"markup", "is_markup"}:
        actual = entity.is_markup
    elif name == "viewport":
        actual = entity.style.viewport
    else:  # pragma: no cover - guarded by _QUERY_FIELDS
        raise ValueError(f"unsupported query field: {name!r}")
    matched = actual == expected
    return matched if operator == "==" else not matched


def _normalize_type(value: object) -> str:
    normalized = str(value).strip().upper().replace("-", "_")
    return _TYPE_ALIASES.get(normalized, normalized)


def _point(value: object) -> Point2D:
    row = cast(Sequence[object], value)
    if len(row) != 2:
        raise ValueError(
            f"native normalized point must contain 2 values, got {len(row)}"
        )
    return Point2D(float(row[0]), float(row[1]))


def _optional_point(value: object) -> Point2D | None:
    return None if value is None else _point(value)


def _optional_box(value: object) -> Bounds2D | None:
    if value is None:
        return None
    row = tuple(float(item) for item in cast(Sequence[object], value))
    if len(row) != 4:
        raise ValueError(
            f"native normalized bounds must contain 4 values, got {len(row)}"
        )
    return cast(Bounds2D, row)


def _optional_rgba(value: object) -> RgbaColor | None:
    if value is None:
        return None
    row = tuple(int(item) for item in cast(Sequence[object], value))
    if len(row) != 4:
        raise ValueError(
            f"native normalized color must contain 4 values, got {len(row)}"
        )
    return cast(RgbaColor, row)


def _optional_rgb(value: object) -> tuple[int, int, int] | None:
    if value is None:
        return None
    row = tuple(int(item) for item in cast(Sequence[object], value))
    if len(row) != 3:
        raise ValueError(f"native paper color must contain 3 values, got {len(row)}")
    return cast(tuple[int, int, int], row)


def _optional_str(value: object) -> str | None:
    return None if value is None else str(value)


def _points_bounds(points: Iterable[Point2D]) -> Bounds2D | None:
    points = tuple(points)
    if not points:
        return None
    return (
        min(point.x for point in points),
        min(point.y for point in points),
        max(point.x for point in points),
        max(point.y for point in points),
    )


def _union_bounds(first: Bounds2D | None, second: Bounds2D | None) -> Bounds2D | None:
    if first is None:
        return second
    if second is None:
        return first
    return (
        min(first[0], second[0]),
        min(first[1], second[1]),
        max(first[2], second[2]),
        max(first[3], second[3]),
    )


def _rounded(value: float | None, digits: int) -> float | None:
    if value is None:
        return None
    rounded = round(value, digits)
    return 0.0 if rounded == 0.0 else rounded


def _point_snapshot(point: Point2D, digits: int) -> tuple[float, float]:
    return cast(
        tuple[float, float],
        (_rounded(point.x, digits), _rounded(point.y, digits)),
    )


def _path_segment_snapshot(segment: PathSegment, digits: int) -> dict[str, object]:
    value: dict[str, object] = {
        "kind": segment.kind,
        "end": _point_snapshot(segment.end, digits),
    }
    for name in ("control1", "control2", "control", "center", "x_axis", "y_axis"):
        point = cast(Point2D | None, getattr(segment, name))
        if point is not None:
            value[name] = _point_snapshot(point, digits)
    if segment.start_angle_degrees is not None:
        value["start_angle_degrees"] = _rounded(segment.start_angle_degrees, digits)
    if segment.sweep_angle_degrees is not None:
        value["sweep_angle_degrees"] = _rounded(segment.sweep_angle_degrees, digits)
    if not segment.stroked:
        value["stroked"] = False
    if segment.smooth_join:
        value["smooth_join"] = True
    return value


def _optional_point_snapshot(
    point: Point2D | None, digits: int
) -> tuple[float, float] | None:
    return None if point is None else _point_snapshot(point, digits)


def _box_snapshot(box: Bounds2D | None, digits: int) -> Bounds2D | None:
    if box is None:
        return None
    return cast(Bounds2D, tuple(_rounded(value, digits) for value in box))


def _brush_snapshot(brush: Brush, digits: int) -> dict[str, object]:
    if isinstance(brush, SolidBrush):
        return {
            "kind": "solid",
            "color": brush.color,
            "opacity": _rounded(brush.opacity, digits),
        }
    if isinstance(brush, ImageBrush):
        return {
            "kind": "image",
            "source": brush.source,
            "resource_part": brush.resource_part,
            "content_type": brush.content_type,
            "data_size": len(brush.data),
            "pixel_size": (brush.pixel_width, brush.pixel_height),
            "dpi": (
                _rounded(brush.dpi_x, digits),
                _rounded(brush.dpi_y, digits),
            ),
            "physical_size_dip": (
                tuple(_rounded(value, digits) for value in brush.physical_size_dip)
                if brush.physical_size_dip is not None
                else None
            ),
            "viewbox": _box_snapshot(brush.viewbox, digits),
            "viewport": _box_snapshot(brush.viewport, digits),
            "source_viewport": _box_snapshot(brush.source_viewport, digits),
            "tile_mode": brush.tile_mode,
            "transform": tuple(_rounded(value, digits) for value in brush.transform),
            "opacity": _rounded(brush.opacity, digits),
        }
    if isinstance(brush, VisualBrush):
        return {
            "kind": "visual",
            "entity_count": len(brush.entities),
            "viewbox": _box_snapshot(brush.viewbox, digits),
            "viewport": _box_snapshot(brush.viewport, digits),
            "source_viewport": _box_snapshot(brush.source_viewport, digits),
            "tile_mode": brush.tile_mode,
            "transform": tuple(_rounded(value, digits) for value in brush.transform),
            "opacity": _rounded(brush.opacity, digits),
        }
    if isinstance(brush, GradientBrush):
        return {
            "kind": brush.kind,
            "start_point": _optional_point_snapshot(brush.start_point, digits),
            "end_point": _optional_point_snapshot(brush.end_point, digits),
            "center": _optional_point_snapshot(brush.center, digits),
            "gradient_origin": _optional_point_snapshot(brush.gradient_origin, digits),
            "x_axis": _optional_point_snapshot(brush.x_axis, digits),
            "y_axis": _optional_point_snapshot(brush.y_axis, digits),
            "spread_method": brush.spread_method,
            "mapping_mode": brush.mapping_mode,
            "gradient_stops": tuple(
                {
                    "color": stop.color,
                    "color_value": stop.color_value,
                    "offset": _rounded(stop.offset, digits),
                }
                for stop in brush.gradient_stops
            ),
            "opacity": _rounded(brush.opacity, digits),
        }
    return {"kind": "unsupported", "brush_type": brush.brush_type}


__all__ = [
    "Bounds2D",
    "Brush",
    "ClipPath",
    "ColoredPoint",
    "CompositingGroup",
    "Drawing",
    "Entity",
    "EntityQuery",
    "GradientBrush",
    "GradientStop",
    "Image",
    "ImageBrush",
    "PathFigure",
    "PathSegment",
    "Point2D",
    "RgbaColor",
    "Sheet",
    "SolidBrush",
    "Style",
    "UnsupportedBrush",
    "VisualBrush",
    "read",
    "readfile",
]
