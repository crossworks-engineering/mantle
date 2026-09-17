"""Low-level DWF/DWFx package, XPS, and W2D inspection models."""

from __future__ import annotations

import os
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, TypeAlias, cast

from . import _core

PathSource: TypeAlias = str | os.PathLike[str]
BytesSource: TypeAlias = bytes | bytearray | memoryview
DwfSource: TypeAlias = PathSource | BytesSource
Color: TypeAlias = tuple[int, int, int]


@dataclass(frozen=True, slots=True)
class ParseLimits:
    max_file_size: int = _core.DEFAULT_MAX_FILE_SIZE_BYTES
    max_archive_entries: int = _core.DEFAULT_MAX_ARCHIVE_ENTRIES
    max_entry_size: int = _core.DEFAULT_MAX_ENTRY_SIZE_BYTES
    max_total_uncompressed_size: int = _core.DEFAULT_MAX_TOTAL_UNCOMPRESSED_SIZE_BYTES
    max_compression_ratio: int = _core.DEFAULT_MAX_COMPRESSION_RATIO
    max_xml_size: int = _core.DEFAULT_MAX_XML_SIZE_BYTES
    max_xml_depth: int = _core.DEFAULT_MAX_XML_DEPTH
    max_w2d_records: int = _core.DEFAULT_MAX_W2D_RECORDS
    max_w2d_points_per_entity: int = _core.DEFAULT_MAX_W2D_POINTS_PER_ENTITY
    max_w2d_total_points: int = _core.DEFAULT_MAX_W2D_TOTAL_POINTS
    max_w2d_string_size: int = _core.DEFAULT_MAX_W2D_STRING_SIZE_BYTES
    max_w2d_nesting_depth: int = _core.DEFAULT_MAX_W2D_NESTING_DEPTH
    max_w2d_decompressed_size: int = _core.DEFAULT_MAX_W2D_DECOMPRESSED_SIZE_BYTES
    max_w2d_compression_depth: int = _core.DEFAULT_MAX_W2D_COMPRESSION_DEPTH
    max_xps_visuals: int = _core.DEFAULT_MAX_XPS_VISUALS
    max_xps_path_segments: int = _core.DEFAULT_MAX_XPS_PATH_SEGMENTS

    def __post_init__(self) -> None:
        for name, value in self.as_args_by_name().items():
            if isinstance(value, bool) or not isinstance(value, int):
                raise TypeError(f"{name} must be an int")
            if value < 0:
                raise ValueError(f"{name} must be non-negative")

    def as_args_by_name(self) -> dict[str, int]:
        return {
            "max_file_size": self.max_file_size,
            "max_archive_entries": self.max_archive_entries,
            "max_entry_size": self.max_entry_size,
            "max_total_uncompressed_size": self.max_total_uncompressed_size,
            "max_compression_ratio": self.max_compression_ratio,
            "max_xml_size": self.max_xml_size,
            "max_xml_depth": self.max_xml_depth,
            "max_w2d_records": self.max_w2d_records,
            "max_w2d_points_per_entity": self.max_w2d_points_per_entity,
            "max_w2d_total_points": self.max_w2d_total_points,
            "max_w2d_string_size": self.max_w2d_string_size,
            "max_w2d_nesting_depth": self.max_w2d_nesting_depth,
            "max_w2d_decompressed_size": self.max_w2d_decompressed_size,
            "max_w2d_compression_depth": self.max_w2d_compression_depth,
            "max_xps_visuals": self.max_xps_visuals,
            "max_xps_path_segments": self.max_xps_path_segments,
        }

    def as_args(
        self,
    ) -> tuple[
        int,
        int,
        int,
        int,
        int,
        int,
        int,
        int,
        int,
        int,
        int,
        int,
        int,
        int,
        int,
        int,
    ]:
        return (
            self.max_file_size,
            self.max_archive_entries,
            self.max_entry_size,
            self.max_total_uncompressed_size,
            self.max_compression_ratio,
            self.max_xml_size,
            self.max_xml_depth,
            self.max_w2d_records,
            self.max_w2d_points_per_entity,
            self.max_w2d_total_points,
            self.max_w2d_string_size,
            self.max_w2d_nesting_depth,
            self.max_w2d_decompressed_size,
            self.max_w2d_compression_depth,
            self.max_xps_visuals,
            self.max_xps_path_segments,
        )


DEFAULT_LIMITS = ParseLimits()


@dataclass(frozen=True, slots=True)
class DwfFormatInfo:
    kind: str
    version: str | None
    header_size: int

    @property
    def is_package(self) -> bool:
        return self.kind == "dwf_package"

    @property
    def is_legacy(self) -> bool:
        return self.kind == "legacy_dwf"

    @property
    def is_dwfx(self) -> bool:
        return self.kind == "dwfx"


@dataclass(frozen=True, slots=True)
class ArchiveEntry:
    original_name: str
    normalized_name: str
    compressed_size: int
    uncompressed_size: int
    compression_method: str
    is_directory: bool
    encrypted: bool


@dataclass(frozen=True, slots=True)
class Property:
    name: str
    value: str
    category: str | None = None
    value_type: str | None = None


@dataclass(frozen=True, slots=True)
class Interface:
    name: str
    object_id: str | None = None
    href: str | None = None


@dataclass(frozen=True, slots=True)
class SourceInfo:
    provider: str | None
    href: str | None


@dataclass(frozen=True, slots=True)
class Resource:
    role: str
    mime: str
    href: str
    normalized_href: str


@dataclass(frozen=True, slots=True)
class Paper:
    show: bool | None
    units: str | None
    width: float | None
    height: float | None
    clip: tuple[float, ...] | None
    color: Color | None


@dataclass(frozen=True, slots=True)
class PageResource:
    kind: str
    role: str
    mime: str
    href: str
    normalized_href: str
    title: str | None
    size: int | None
    object_id: str | None
    parent_object_id: str | None
    transform: tuple[float, ...] | None
    clip: tuple[float, ...] | None
    extents: tuple[float, ...] | None
    attributes: Mapping[str, str] = field(repr=False)


@dataclass(frozen=True, slots=True)
class Page:
    version: str
    name: str
    object_id: str | None
    plot_order: int | None
    color: Color | None
    paper: Paper | None
    properties: tuple[Property, ...]
    resources: tuple[PageResource, ...]


@dataclass(frozen=True, slots=True)
class W2dPoint:
    x: int
    y: int


@dataclass(frozen=True, slots=True)
class W2dSourceSpan:
    offset: int
    length: int
    opcode: str
    decoded_offset: int | None
    decoded_length: int | None
    compression_depth: int


@dataclass(frozen=True, slots=True)
class W2dColoredPoint:
    point: W2dPoint
    color: tuple[int, int, int, int]


@dataclass(frozen=True, slots=True)
class W2dImage:
    format: str
    identifier: int
    columns: int
    rows: int
    min: W2dPoint
    max: W2dPoint
    color_map: tuple[tuple[int, int, int, int], ...]
    data: bytes


@dataclass(frozen=True, slots=True)
class W2dEmbeddedFont:
    request: int
    privilege: int
    charset: int
    typeface_name: str
    logfont_name: str
    data: bytes
    source: W2dSourceSpan


@dataclass(frozen=True, slots=True)
class W2dBlockRef:
    format: str
    payload: bytes
    source: W2dSourceSpan


@dataclass(frozen=True, slots=True)
class W2dLayer:
    number: int
    name: str | None


@dataclass(frozen=True, slots=True)
class W2dFont:
    name: str | None
    canonical_name: str | None
    charset: int | None
    pitch: int | None
    family: int | None
    bold: bool | None
    italic: bool | None
    underlined: bool | None
    height: int | None
    rotation: int | None
    width_scale: int | None
    spacing: int | None
    oblique: int | None
    flags: int | None


@dataclass(frozen=True, slots=True)
class W2dLineStyle:
    pattern: str | None
    weight: int | None
    adapt_patterns: bool | None
    pattern_scale: float | None
    line_start_cap: str | None
    line_end_cap: str | None
    dash_start_cap: str | None
    dash_end_cap: str | None
    line_join: str | None
    miter_angle: int | None
    miter_length: int | None


@dataclass(frozen=True, slots=True)
class W2dRendition:
    color: tuple[int, int, int, int] | None
    color_index: int | None
    layer: W2dLayer | None
    line: W2dLineStyle
    fill: bool
    fill_pattern: str | None
    font: W2dFont
    visibility: bool
    viewport: str | None


@dataclass(frozen=True, slots=True)
class W2dEntity:
    kind: str
    points: tuple[W2dPoint, ...]
    center: W2dPoint | None
    radius: int | None
    major: int | None
    minor: int | None
    start_angle: int | None
    end_angle: int | None
    tilt: int | None
    text: str | None
    bounds: tuple[W2dPoint, ...] | None
    colored_points: tuple[W2dColoredPoint, ...]
    contours: tuple[tuple[W2dPoint, ...], ...]
    image: W2dImage | None
    rendition: W2dRendition
    source: W2dSourceSpan


@dataclass(frozen=True, slots=True)
class W2dUnits:
    name: str
    transform: tuple[float, ...]


@dataclass(frozen=True, slots=True)
class W2dViewport:
    name: str
    contours: tuple[tuple[W2dPoint, ...], ...]
    units: W2dUnits | None


@dataclass(frozen=True, slots=True)
class W2dStream:
    href: str
    role: str
    mime: str
    source_format: str
    version: str
    source_size: int
    decompressed_size: int
    compressed_blocks: int
    complete: bool
    end_of_dwf_seen: bool
    logical_bounds: tuple[int, int, int, int] | None
    transform: tuple[float, ...] | None
    clip: tuple[float, ...] | None
    units: W2dUnits | None
    layers: tuple[W2dLayer, ...]
    viewports: tuple[W2dViewport, ...]
    color_maps: tuple[tuple[tuple[int, int, int, int], ...], ...]
    embedded_fonts: tuple[W2dEmbeddedFont, ...]
    block_refs: tuple[W2dBlockRef, ...]
    entities: tuple[W2dEntity, ...]
    diagnostics: tuple[Diagnostic, ...]


@dataclass(frozen=True, slots=True)
class Section:
    section_type: str
    name: str
    title: str | None
    source: SourceInfo | None
    resources: tuple[Resource, ...]
    page: Page | None
    w2d_streams: tuple[W2dStream, ...]

    @property
    def is_sheet(self) -> bool:
        return self.page is not None

    @property
    def entities(self) -> tuple[W2dEntity, ...]:
        """Entities from the primary, non-markup W2D stream(s)."""

        return tuple(
            entity
            for stream in self.w2d_streams
            if "markup" not in stream.role.casefold()
            for entity in stream.entities
        )

    @property
    def markup_entities(self) -> tuple[W2dEntity, ...]:
        """Entities from W2D resources whose role identifies markup."""

        return tuple(
            entity
            for stream in self.w2d_streams
            if "markup" in stream.role.casefold()
            for entity in stream.entities
        )


@dataclass(frozen=True, slots=True)
class Manifest:
    version: str
    object_id: str | None
    properties: tuple[Property, ...]
    interfaces: tuple[Interface, ...]
    sections: tuple[Section, ...]


@dataclass(frozen=True, slots=True)
class Diagnostic:
    code: str
    severity: str
    message: str
    action: str
    section: str | None
    resource: str | None
    offset: int | None
    details: Mapping[str, str]


@dataclass(frozen=True, slots=True)
class PackageInfo:
    format: DwfFormatInfo
    entries: tuple[ArchiveEntry, ...]
    manifest: Manifest
    diagnostics: tuple[Diagnostic, ...]

    @property
    def sheets(self) -> tuple[Section, ...]:
        return tuple(section for section in self.manifest.sections if section.is_sheet)

    @property
    def sheet_count(self) -> int:
        return len(self.sheets)

    @property
    def entity_count(self) -> int:
        return sum(len(sheet.entities) for sheet in self.sheets)


@dataclass(frozen=True, slots=True)
class OpcContentType:
    content_type: str
    extension: str | None = None
    part_name: str | None = None


@dataclass(frozen=True, slots=True)
class OpcRelationship:
    source: str | None
    id: str
    relationship_type: str
    target: str
    target_mode: str
    normalized_target: str | None


@dataclass(frozen=True, slots=True)
class XpsSourceSpan:
    offset: int
    length: int
    element: str


@dataclass(frozen=True, slots=True)
class XpsGradientStop:
    color: tuple[int, int, int, int] | None
    color_value: str
    offset: float


@dataclass(frozen=True, slots=True)
class XpsImageMetadata:
    pixel_width: int
    pixel_height: int
    dpi_x: float
    dpi_y: float

    @property
    def physical_size_dip(self) -> tuple[float, float]:
        return (
            self.pixel_width * 96.0 / self.dpi_x,
            self.pixel_height * 96.0 / self.dpi_y,
        )


@dataclass(frozen=True, slots=True)
class XpsBrush:
    kind: str
    opacity: float | None = None
    color: tuple[int, int, int, int] | None = None
    source: str | None = None
    resource_part: str | None = None
    normalized_source: str | None = None
    content_type: str | None = None
    data: bytes = b""
    image_metadata: XpsImageMetadata | None = None
    entities: tuple[XpsEntity, ...] = ()
    viewbox: tuple[float, ...] | None = None
    viewport: tuple[float, ...] | None = None
    viewbox_units: str | None = None
    viewport_units: str | None = None
    tile_mode: str | None = None
    transform: tuple[float, ...] | None = None
    start_point: tuple[float, float] | None = None
    end_point: tuple[float, float] | None = None
    center: tuple[float, float] | None = None
    gradient_origin: tuple[float, float] | None = None
    radius_x: float | None = None
    radius_y: float | None = None
    spread_method: str | None = None
    mapping_mode: str | None = None
    gradient_stops: tuple[XpsGradientStop, ...] = ()
    brush_type: str | None = None
    attributes: Mapping[str, str] = field(default_factory=dict, repr=False)


@dataclass(frozen=True, slots=True)
class XpsStyle:
    fill: XpsBrush | None
    stroke: XpsBrush | None
    stroke_thickness: float
    stroke_dash_array: tuple[float, ...]
    stroke_dash_offset: float
    stroke_start_line_cap: str | None
    stroke_end_line_cap: str | None
    stroke_dash_cap: str | None
    stroke_line_join: str | None
    stroke_miter_limit: float | None
    opacity: float


@dataclass(frozen=True, slots=True)
class XpsPathSegment:
    kind: str
    end: tuple[float, float]
    stroked: bool = True
    smooth_join: bool = False
    control1: tuple[float, float] | None = None
    control2: tuple[float, float] | None = None
    control: tuple[float, float] | None = None
    radius: tuple[float, float] | None = None
    rotation_degrees: float | None = None
    large_arc: bool | None = None
    sweep_clockwise: bool | None = None


@dataclass(frozen=True, slots=True)
class XpsPathFigure:
    start: tuple[float, float]
    segments: tuple[XpsPathSegment, ...]
    closed: bool
    filled: bool


@dataclass(frozen=True, slots=True)
class XpsPathGeometry:
    fill_rule: str
    figures: tuple[XpsPathFigure, ...]
    data: str | None = None
    transform: tuple[float, ...] = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


@dataclass(frozen=True, slots=True)
class XpsClip:
    geometry: XpsPathGeometry
    transform: tuple[float, ...]


@dataclass(frozen=True, slots=True)
class XpsOpacityMask:
    brush: XpsBrush
    transform: tuple[float, ...]


@dataclass(frozen=True, slots=True)
class XpsCanvasGroup:
    id: int
    name: str | None
    opacity: float
    transform: tuple[float, ...]
    clip: XpsPathGeometry | None
    opacity_mask: XpsBrush | None


@dataclass(frozen=True, slots=True)
class XpsGlyphs:
    unicode_string: str
    origin: tuple[float, float]
    font_uri: str
    font_resource_part: str
    normalized_font_uri: str | None
    font_rendering_em_size: float
    indices: str | None
    style_simulations: str | None
    bidi_level: int | None
    sideways: bool
    font_part: str | None
    font_content_type: str | None
    font_obfuscated: bool
    outline: XpsPathGeometry | None


@dataclass(frozen=True, slots=True)
class XpsEntity:
    kind: str
    name: str | None
    canvas_name: str | None
    navigate_uri: str | None
    transform: tuple[float, ...]
    clip: XpsPathGeometry | None
    clip_chain: tuple[XpsClip, ...]
    opacity_mask: XpsBrush | None
    opacity_mask_chain: tuple[XpsOpacityMask, ...]
    canvas_groups: tuple[XpsCanvasGroup, ...]
    style: XpsStyle
    path: XpsPathGeometry | None
    glyphs: XpsGlyphs | None
    source: XpsSourceSpan
    attributes: Mapping[str, str] = field(repr=False)


@dataclass(frozen=True, slots=True)
class XpsPage:
    part_name: str
    name: str
    language: str | None
    width: float
    height: float
    content_box: tuple[float, ...] | None
    bleed_box: tuple[float, ...] | None
    resource_dictionaries: tuple[str, ...]
    relationships: tuple[OpcRelationship, ...]
    canvas_groups: tuple[XpsCanvasGroup, ...]
    entities: tuple[XpsEntity, ...]
    diagnostics: tuple[Diagnostic, ...]


@dataclass(frozen=True, slots=True)
class XpsDocument:
    part_name: str
    relationships: tuple[OpcRelationship, ...]
    pages: tuple[XpsPage, ...]


@dataclass(frozen=True, slots=True)
class DwfxPackageInfo:
    format: DwfFormatInfo
    entries: tuple[ArchiveEntry, ...]
    content_types: tuple[OpcContentType, ...]
    relationships: tuple[OpcRelationship, ...]
    document_sequence: str
    documents: tuple[XpsDocument, ...]
    diagnostics: tuple[Diagnostic, ...]

    @property
    def pages(self) -> tuple[XpsPage, ...]:
        return tuple(page for document in self.documents for page in document.pages)

    @property
    def sheets(self) -> tuple[XpsPage, ...]:
        return self.pages

    @property
    def sheet_count(self) -> int:
        return len(self.pages)

    @property
    def entity_count(self) -> int:
        return sum(len(page.entities) for page in self.pages)


def detect_format(
    source: DwfSource,
    *,
    limits: ParseLimits = DEFAULT_LIMITS,
) -> DwfFormatInfo:
    """Identify a DWF family from bytes rather than its filename extension."""

    data = _load_data(source, max_file_size=limits.max_file_size)
    kind, version, header_size = _core.detect_format_bytes(data, *limits.as_args())
    return DwfFormatInfo(kind=kind, version=version, header_size=header_size)


def inspect_package(
    source: DwfSource,
    *,
    limits: ParseLimits = DEFAULT_LIMITS,
) -> PackageInfo:
    """Inspect a DWF 6 package, manifest, and all ePlot descriptors."""

    data = _load_data(source, max_file_size=limits.max_file_size)
    raw = cast(
        Mapping[str, Any],
        _core.inspect_package_bytes(data, *limits.as_args()),
    )
    return _package_from_mapping(raw)


def inspect_dwfx(
    source: DwfSource,
    *,
    limits: ParseLimits = DEFAULT_LIMITS,
    resolve_glyph_outlines: bool = False,
) -> DwfxPackageInfo:
    """Inspect a DWFx OPC graph and decode its XPS FixedPage visuals.

    Packaged-font outlines are opt-in here because expanding every Glyphs
    element can dominate structure-only inspection of text-heavy packages.
    :func:`ezdwf.read` resolves them for rendering.
    """

    data = _load_data(source, max_file_size=limits.max_file_size)
    raw = cast(
        Mapping[str, Any],
        _core.inspect_dwfx_bytes(data, *limits.as_args(), bool(resolve_glyph_outlines)),
    )
    return _dwfx_from_mapping(raw)


def decode_w2d(
    source: DwfSource,
    *,
    resource_name: str | None = None,
    limits: ParseLimits = DEFAULT_LIMITS,
) -> W2dStream:
    """Decode a standalone W2D resource into raw logical-coordinate entities."""

    data = _load_data(
        source,
        max_file_size=min(limits.max_file_size, limits.max_entry_size),
    )
    if resource_name is None:
        resource_name = (
            os.fspath(source)
            if isinstance(source, (str, os.PathLike))
            else "<memory.w2d>"
        )
    raw = cast(
        Mapping[str, Any],
        _core.decode_w2d_bytes(data, resource_name, *limits.as_args()),
    )
    return _w2d_stream(raw)


def _load_data(source: DwfSource, *, max_file_size: int) -> bytes:
    if isinstance(source, (str, os.PathLike)):
        path = Path(source)
        size = path.stat().st_size
        if size > max_file_size:
            raise _core.DwfLimitError(
                f"input size {size} bytes exceeds configured limit "
                f"{max_file_size} bytes"
            )
        return path.read_bytes()
    data = bytes(source)
    if len(data) > max_file_size:
        raise _core.DwfLimitError(
            f"input size {len(data)} bytes exceeds configured limit "
            f"{max_file_size} bytes"
        )
    return data


def _format_from_row(row: tuple[str, str | None, int]) -> DwfFormatInfo:
    return DwfFormatInfo(kind=row[0], version=row[1], header_size=row[2])


def _property(value: Mapping[str, Any]) -> Property:
    return Property(
        name=str(value["name"]),
        value=str(value["value"]),
        category=_optional_str(value.get("category")),
        value_type=_optional_str(value.get("value_type")),
    )


def _page(value: Mapping[str, Any] | None) -> Page | None:
    if value is None:
        return None
    paper_value = cast(Mapping[str, Any] | None, value.get("paper"))
    paper = None
    if paper_value is not None:
        paper = Paper(
            show=cast(bool | None, paper_value.get("show")),
            units=_optional_str(paper_value.get("units")),
            width=cast(float | None, paper_value.get("width")),
            height=cast(float | None, paper_value.get("height")),
            clip=_optional_float_tuple(paper_value.get("clip")),
            color=_optional_color(paper_value.get("color")),
        )
    resources = tuple(
        PageResource(
            kind=str(resource["kind"]),
            role=str(resource["role"]),
            mime=str(resource["mime"]),
            href=str(resource["href"]),
            normalized_href=str(resource["normalized_href"]),
            title=_optional_str(resource.get("title")),
            size=cast(int | None, resource.get("size")),
            object_id=_optional_str(resource.get("object_id")),
            parent_object_id=_optional_str(resource.get("parent_object_id")),
            transform=_optional_float_tuple(resource.get("transform")),
            clip=_optional_float_tuple(resource.get("clip")),
            extents=_optional_float_tuple(resource.get("extents")),
            attributes=dict(cast(Mapping[str, str], resource.get("attributes", {}))),
        )
        for resource in cast(list[Mapping[str, Any]], value.get("resources", []))
    )
    return Page(
        version=str(value["version"]),
        name=str(value["name"]),
        object_id=_optional_str(value.get("object_id")),
        plot_order=cast(int | None, value.get("plot_order")),
        color=_optional_color(value.get("color")),
        paper=paper,
        properties=tuple(
            _property(item)
            for item in cast(list[Mapping[str, Any]], value.get("properties", []))
        ),
        resources=resources,
    )


def _diagnostic(value: Mapping[str, Any]) -> Diagnostic:
    return Diagnostic(
        code=str(value["code"]),
        severity=str(value["severity"]),
        message=str(value["message"]),
        action=str(value["action"]),
        section=_optional_str(value.get("section")),
        resource=_optional_str(value.get("resource")),
        offset=cast(int | None, value.get("offset")),
        details=dict(cast(Mapping[str, str], value.get("details", {}))),
    )


def _w2d_point(value: object) -> W2dPoint:
    row = cast(tuple[int, int], value)
    return W2dPoint(x=int(row[0]), y=int(row[1]))


def _w2d_source(value: Mapping[str, Any]) -> W2dSourceSpan:
    return W2dSourceSpan(
        offset=int(value["offset"]),
        length=int(value["length"]),
        opcode=str(value["opcode"]),
        decoded_offset=cast(int | None, value.get("decoded_offset")),
        decoded_length=cast(int | None, value.get("decoded_length")),
        compression_depth=int(value.get("compression_depth", 0)),
    )


def _rgba(value: object) -> tuple[int, int, int, int]:
    channels = tuple(int(item) for item in cast(list[object], value))
    if len(channels) != 4:
        raise ValueError(
            f"native RGBA row must contain 4 channels, got {len(channels)}"
        )
    return cast(tuple[int, int, int, int], channels)


def _w2d_layer(value: Mapping[str, Any] | None) -> W2dLayer | None:
    if value is None:
        return None
    return W2dLayer(number=int(value["number"]), name=_optional_str(value.get("name")))


def _w2d_units(value: Mapping[str, Any] | None) -> W2dUnits | None:
    if value is None:
        return None
    return W2dUnits(
        name=str(value["name"]),
        transform=tuple(float(item) for item in cast(list[object], value["transform"])),
    )


def _w2d_rendition(value: Mapping[str, Any]) -> W2dRendition:
    line = cast(Mapping[str, Any], value["line"])
    font = cast(Mapping[str, Any], value["font"])
    color_value = cast(list[object] | None, value.get("color"))
    color = None
    if color_value is not None:
        channels = tuple(int(item) for item in color_value)
        if len(channels) != 4:
            raise ValueError(
                f"native W2D color row must contain 4 channels, got {len(channels)}"
            )
        color = cast(tuple[int, int, int, int], channels)
    return W2dRendition(
        color=color,
        color_index=cast(int | None, value.get("color_index")),
        layer=_w2d_layer(cast(Mapping[str, Any] | None, value.get("layer"))),
        line=W2dLineStyle(
            pattern=_optional_str(line.get("pattern")),
            weight=cast(int | None, line.get("weight")),
            adapt_patterns=cast(bool | None, line.get("adapt_patterns")),
            pattern_scale=cast(float | None, line.get("pattern_scale")),
            line_start_cap=_optional_str(line.get("line_start_cap")),
            line_end_cap=_optional_str(line.get("line_end_cap")),
            dash_start_cap=_optional_str(line.get("dash_start_cap")),
            dash_end_cap=_optional_str(line.get("dash_end_cap")),
            line_join=_optional_str(line.get("line_join")),
            miter_angle=cast(int | None, line.get("miter_angle")),
            miter_length=cast(int | None, line.get("miter_length")),
        ),
        fill=bool(value["fill"]),
        fill_pattern=_optional_str(value.get("fill_pattern")),
        font=W2dFont(
            name=_optional_str(font.get("name")),
            canonical_name=_optional_str(font.get("canonical_name")),
            charset=cast(int | None, font.get("charset")),
            pitch=cast(int | None, font.get("pitch")),
            family=cast(int | None, font.get("family")),
            bold=cast(bool | None, font.get("bold")),
            italic=cast(bool | None, font.get("italic")),
            underlined=cast(bool | None, font.get("underlined")),
            height=cast(int | None, font.get("height")),
            rotation=cast(int | None, font.get("rotation")),
            width_scale=cast(int | None, font.get("width_scale")),
            spacing=cast(int | None, font.get("spacing")),
            oblique=cast(int | None, font.get("oblique")),
            flags=cast(int | None, font.get("flags")),
        ),
        visibility=bool(value["visibility"]),
        viewport=_optional_str(value.get("viewport")),
    )


def _w2d_entity(value: Mapping[str, Any]) -> W2dEntity:
    source = cast(Mapping[str, Any], value["source"])
    center = value.get("center")
    bounds = cast(list[object] | None, value.get("bounds"))
    return W2dEntity(
        kind=str(value["kind"]),
        points=tuple(
            _w2d_point(point) for point in cast(list[object], value["points"])
        ),
        center=_w2d_point(center) if center is not None else None,
        radius=cast(int | None, value.get("radius")),
        major=cast(int | None, value.get("major")),
        minor=cast(int | None, value.get("minor")),
        start_angle=cast(int | None, value.get("start_angle")),
        end_angle=cast(int | None, value.get("end_angle")),
        tilt=cast(int | None, value.get("tilt")),
        text=_optional_str(value.get("text")),
        bounds=tuple(_w2d_point(point) for point in bounds) if bounds else None,
        colored_points=tuple(
            W2dColoredPoint(
                point=_w2d_point(item["point"]),
                color=_rgba(item["color"]),
            )
            for item in cast(list[Mapping[str, Any]], value.get("colored_points", []))
        ),
        contours=tuple(
            tuple(_w2d_point(point) for point in contour)
            for contour in cast(list[list[object]], value.get("contours", []))
        ),
        image=(
            W2dImage(
                format=str(image["format"]),
                identifier=int(image["identifier"]),
                columns=int(image["columns"]),
                rows=int(image["rows"]),
                min=_w2d_point(image["min"]),
                max=_w2d_point(image["max"]),
                color_map=tuple(
                    _rgba(color)
                    for color in cast(list[object], image.get("color_map", []))
                ),
                data=bytes(image["data"]),
            )
            if (image := cast(Mapping[str, Any] | None, value.get("image"))) is not None
            else None
        ),
        rendition=_w2d_rendition(cast(Mapping[str, Any], value["rendition"])),
        source=_w2d_source(source),
    )


def _w2d_stream(
    value: Mapping[str, Any],
    entities_override: list[Mapping[str, Any]] | None = None,
) -> W2dStream:
    return W2dStream(
        href=str(value["href"]),
        role=str(value["role"]),
        mime=str(value["mime"]),
        source_format=str(value.get("source_format", "w2d")),
        version=str(value["version"]),
        source_size=int(value["source_size"]),
        decompressed_size=int(value.get("decompressed_size", value["source_size"])),
        compressed_blocks=int(value.get("compressed_blocks", 0)),
        complete=bool(value["complete"]),
        end_of_dwf_seen=bool(value["end_of_dwf_seen"]),
        logical_bounds=_optional_int_box(value.get("logical_bounds")),
        transform=_optional_float_tuple(value.get("transform")),
        clip=_optional_float_tuple(value.get("clip")),
        units=_w2d_units(cast(Mapping[str, Any] | None, value.get("units"))),
        layers=tuple(
            cast(W2dLayer, _w2d_layer(layer))
            for layer in cast(list[Mapping[str, Any]], value.get("layers", []))
        ),
        viewports=tuple(
            W2dViewport(
                name=str(viewport["name"]),
                contours=tuple(
                    tuple(_w2d_point(point) for point in contour)
                    for contour in cast(list[list[object]], viewport["contours"])
                ),
                units=_w2d_units(cast(Mapping[str, Any] | None, viewport.get("units"))),
            )
            for viewport in cast(list[Mapping[str, Any]], value.get("viewports", []))
        ),
        color_maps=tuple(
            tuple(_rgba(color) for color in cast(list[object], colors))
            for colors in cast(list[list[object]], value.get("color_maps", []))
        ),
        embedded_fonts=tuple(
            W2dEmbeddedFont(
                request=int(font["request"]),
                privilege=int(font["privilege"]),
                charset=int(font["charset"]),
                typeface_name=str(font["typeface_name"]),
                logfont_name=str(font["logfont_name"]),
                data=bytes(font["data"]),
                source=_w2d_source(cast(Mapping[str, Any], font["source"])),
            )
            for font in cast(list[Mapping[str, Any]], value.get("embedded_fonts", []))
        ),
        block_refs=tuple(
            W2dBlockRef(
                format=str(block_ref["format"]),
                payload=bytes(block_ref["payload"]),
                source=_w2d_source(cast(Mapping[str, Any], block_ref["source"])),
            )
            for block_ref in cast(list[Mapping[str, Any]], value.get("block_refs", []))
        ),
        entities=tuple(
            _w2d_entity(entity)
            for entity in (
                entities_override
                if entities_override is not None
                # A stream SHELL carries entities=None ("deferred"), which the
                # streaming read path always overrides; `or []` keeps a bare
                # shell usable rather than crashing on the sentinel.
                else cast(list[Mapping[str, Any]], value.get("entities") or [])
            )
        ),
        diagnostics=tuple(
            _diagnostic(diagnostic)
            for diagnostic in cast(
                list[Mapping[str, Any]], value.get("diagnostics", [])
            )
        ),
    )


def _package_from_mapping(
    raw: Mapping[str, Any],
    stream_entities_loader: Callable[[int, int], list[Mapping[str, Any]]] | None = None,
) -> PackageInfo:
    manifest_value = cast(Mapping[str, Any], raw["manifest"])
    sections = []
    for section_index, value in enumerate(
        cast(list[Mapping[str, Any]], manifest_value["sections"])
    ):
        source_value = cast(Mapping[str, Any] | None, value.get("source"))
        source = (
            SourceInfo(
                provider=_optional_str(source_value.get("provider")),
                href=_optional_str(source_value.get("href")),
            )
            if source_value is not None
            else None
        )
        sections.append(
            Section(
                section_type=str(value["section_type"]),
                name=str(value["name"]),
                title=_optional_str(value.get("title")),
                source=source,
                resources=tuple(
                    Resource(
                        role=str(resource["role"]),
                        mime=str(resource["mime"]),
                        href=str(resource["href"]),
                        normalized_href=str(resource["normalized_href"]),
                    )
                    for resource in cast(
                        list[Mapping[str, Any]], value.get("resources", [])
                    )
                ),
                page=_page(cast(Mapping[str, Any] | None, value.get("page"))),
                w2d_streams=tuple(
                    # With a loader, each stream's entity dicts are fetched,
                    # folded into dataclasses, and freed before the next
                    # stream converts — the streaming read path's whole point.
                    _w2d_stream(
                        stream,
                        entities_override=(
                            stream_entities_loader(section_index, stream_index)
                            if stream_entities_loader is not None
                            else None
                        ),
                    )
                    for stream_index, stream in enumerate(
                        cast(list[Mapping[str, Any]], value.get("w2d_streams", []))
                    )
                ),
            )
        )

    manifest = Manifest(
        version=str(manifest_value["version"]),
        object_id=_optional_str(manifest_value.get("object_id")),
        properties=tuple(
            _property(value)
            for value in cast(
                list[Mapping[str, Any]], manifest_value.get("properties", [])
            )
        ),
        interfaces=tuple(
            Interface(
                name=str(value["name"]),
                object_id=_optional_str(value.get("object_id")),
                href=_optional_str(value.get("href")),
            )
            for value in cast(
                list[Mapping[str, Any]], manifest_value.get("interfaces", [])
            )
        ),
        sections=tuple(sections),
    )
    return PackageInfo(
        format=_format_from_row(cast(tuple[str, str | None, int], raw["format"])),
        entries=tuple(
            ArchiveEntry(
                original_name=str(value["original_name"]),
                normalized_name=str(value["normalized_name"]),
                compressed_size=int(value["compressed_size"]),
                uncompressed_size=int(value["uncompressed_size"]),
                compression_method=str(value["compression_method"]),
                is_directory=bool(value["is_directory"]),
                encrypted=bool(value["encrypted"]),
            )
            for value in cast(list[Mapping[str, Any]], raw["entries"])
        ),
        manifest=manifest,
        diagnostics=tuple(
            _diagnostic(value)
            for value in cast(list[Mapping[str, Any]], raw.get("diagnostics", []))
        ),
    )


def _opc_relationship(value: Mapping[str, Any]) -> OpcRelationship:
    return OpcRelationship(
        source=_optional_str(value.get("source")),
        id=str(value["id"]),
        relationship_type=str(value["relationship_type"]),
        target=str(value["target"]),
        target_mode=str(value["target_mode"]),
        normalized_target=_optional_str(value.get("normalized_target")),
    )


def _xps_brush(value: Mapping[str, Any] | None) -> XpsBrush | None:
    if value is None:
        return None
    color = value.get("color")
    metadata = cast(Mapping[str, Any] | None, value.get("image_metadata"))
    groups = tuple(
        _xps_canvas_group(group)
        for group in cast(list[Mapping[str, Any]], value.get("canvas_groups", []))
    )
    groups_by_id = {group.id: group for group in groups}
    return XpsBrush(
        kind=str(value["kind"]),
        opacity=cast(float | None, value.get("opacity")),
        color=_rgba(color) if color is not None else None,
        source=_optional_str(value.get("source")),
        resource_part=_optional_str(value.get("resource_part")),
        normalized_source=_optional_str(value.get("normalized_source")),
        content_type=_optional_str(value.get("content_type")),
        data=bytes(value.get("data", b"")),
        image_metadata=(
            XpsImageMetadata(
                pixel_width=int(metadata["pixel_width"]),
                pixel_height=int(metadata["pixel_height"]),
                dpi_x=float(metadata["dpi_x"]),
                dpi_y=float(metadata["dpi_y"]),
            )
            if metadata is not None
            else None
        ),
        entities=tuple(
            _xps_entity(entity, groups_by_id)
            for entity in cast(list[Mapping[str, Any]], value.get("entities", []))
        ),
        viewbox=_optional_float_tuple(value.get("viewbox")),
        viewport=_optional_float_tuple(value.get("viewport")),
        viewbox_units=_optional_str(value.get("viewbox_units")),
        viewport_units=_optional_str(value.get("viewport_units")),
        tile_mode=_optional_str(value.get("tile_mode")),
        transform=_optional_float_tuple(value.get("transform")),
        start_point=_optional_float_point(value.get("start_point")),
        end_point=_optional_float_point(value.get("end_point")),
        center=_optional_float_point(value.get("center")),
        gradient_origin=_optional_float_point(value.get("gradient_origin")),
        radius_x=cast(float | None, value.get("radius_x")),
        radius_y=cast(float | None, value.get("radius_y")),
        spread_method=_optional_str(value.get("spread_method")),
        mapping_mode=_optional_str(value.get("mapping_mode")),
        gradient_stops=tuple(
            XpsGradientStop(
                color=(_rgba(stop["color"]) if stop.get("color") is not None else None),
                color_value=str(stop["color_value"]),
                offset=float(stop["offset"]),
            )
            for stop in cast(list[Mapping[str, Any]], value.get("gradient_stops", []))
        ),
        brush_type=_optional_str(value.get("brush_type")),
        attributes=dict(cast(Mapping[str, str], value.get("attributes", {}))),
    )


def _xps_path_segment(value: Mapping[str, Any]) -> XpsPathSegment:
    return XpsPathSegment(
        kind=str(value["kind"]),
        end=_float_point(value["end"]),
        stroked=bool(value.get("stroked", True)),
        smooth_join=bool(value.get("smooth_join", False)),
        control1=_optional_float_point(value.get("control1")),
        control2=_optional_float_point(value.get("control2")),
        control=_optional_float_point(value.get("control")),
        radius=_optional_float_point(value.get("radius")),
        rotation_degrees=cast(float | None, value.get("rotation_degrees")),
        large_arc=cast(bool | None, value.get("large_arc")),
        sweep_clockwise=cast(bool | None, value.get("sweep_clockwise")),
    )


def _xps_path(value: Mapping[str, Any] | None) -> XpsPathGeometry | None:
    if value is None:
        return None
    return XpsPathGeometry(
        fill_rule=str(value["fill_rule"]),
        figures=tuple(
            XpsPathFigure(
                start=_float_point(figure["start"]),
                segments=tuple(
                    _xps_path_segment(segment)
                    for segment in cast(
                        list[Mapping[str, Any]], figure.get("segments", [])
                    )
                ),
                closed=bool(figure["closed"]),
                filled=bool(figure["filled"]),
            )
            for figure in cast(list[Mapping[str, Any]], value.get("figures", []))
        ),
        data=_optional_str(value.get("data")),
        transform=tuple(
            float(item)
            for item in cast(list[object], value.get("transform", [1, 0, 0, 1, 0, 0]))
        ),
    )


def _xps_canvas_group(value: Mapping[str, Any]) -> XpsCanvasGroup:
    return XpsCanvasGroup(
        id=int(value["id"]),
        name=_optional_str(value.get("name")),
        opacity=float(value["opacity"]),
        transform=tuple(
            float(component) for component in cast(list[object], value["transform"])
        ),
        clip=_xps_path(cast(Mapping[str, Any] | None, value.get("clip"))),
        opacity_mask=_xps_brush(
            cast(Mapping[str, Any] | None, value.get("opacity_mask"))
        ),
    )


def _xps_entity(
    value: Mapping[str, Any],
    canvas_groups: Mapping[int, XpsCanvasGroup] | None = None,
) -> XpsEntity:
    style = cast(Mapping[str, Any], value["style"])
    glyph_value = cast(Mapping[str, Any] | None, value.get("glyphs"))
    source = cast(Mapping[str, Any], value["source"])
    return XpsEntity(
        kind=str(value["kind"]),
        name=_optional_str(value.get("name")),
        canvas_name=_optional_str(value.get("canvas_name")),
        navigate_uri=_optional_str(value.get("navigate_uri")),
        transform=tuple(float(item) for item in cast(list[object], value["transform"])),
        clip=_xps_path(cast(Mapping[str, Any] | None, value.get("clip"))),
        clip_chain=tuple(
            XpsClip(
                geometry=cast(
                    XpsPathGeometry,
                    _xps_path(cast(Mapping[str, Any], item["geometry"])),
                ),
                transform=tuple(
                    float(component)
                    for component in cast(list[object], item["transform"])
                ),
            )
            for item in cast(list[Mapping[str, Any]], value.get("clip_chain", []))
        ),
        opacity_mask=_xps_brush(
            cast(Mapping[str, Any] | None, value.get("opacity_mask"))
        ),
        opacity_mask_chain=tuple(
            XpsOpacityMask(
                brush=cast(
                    XpsBrush,
                    _xps_brush(cast(Mapping[str, Any], item["brush"])),
                ),
                transform=tuple(
                    float(component)
                    for component in cast(list[object], item["transform"])
                ),
            )
            for item in cast(
                list[Mapping[str, Any]], value.get("opacity_mask_chain", [])
            )
        ),
        canvas_groups=tuple(
            canvas_groups[group_id]
            for group_id in cast(list[int], value.get("canvas_group_ids", []))
            if canvas_groups is not None and group_id in canvas_groups
        ),
        style=XpsStyle(
            fill=_xps_brush(cast(Mapping[str, Any] | None, style.get("fill"))),
            stroke=_xps_brush(cast(Mapping[str, Any] | None, style.get("stroke"))),
            stroke_thickness=float(style["stroke_thickness"]),
            stroke_dash_array=tuple(
                float(item)
                for item in cast(list[object], style.get("stroke_dash_array", []))
            ),
            stroke_dash_offset=float(style["stroke_dash_offset"]),
            stroke_start_line_cap=_optional_str(style.get("stroke_start_line_cap")),
            stroke_end_line_cap=_optional_str(style.get("stroke_end_line_cap")),
            stroke_dash_cap=_optional_str(style.get("stroke_dash_cap")),
            stroke_line_join=_optional_str(style.get("stroke_line_join")),
            stroke_miter_limit=cast(float | None, style.get("stroke_miter_limit")),
            opacity=float(style["opacity"]),
        ),
        path=_xps_path(cast(Mapping[str, Any] | None, value.get("path"))),
        glyphs=(
            XpsGlyphs(
                unicode_string=str(glyph_value["unicode_string"]),
                origin=_float_point(glyph_value["origin"]),
                font_uri=str(glyph_value["font_uri"]),
                font_resource_part=str(glyph_value.get("font_resource_part", "")),
                normalized_font_uri=_optional_str(
                    glyph_value.get("normalized_font_uri")
                ),
                font_rendering_em_size=float(glyph_value["font_rendering_em_size"]),
                indices=_optional_str(glyph_value.get("indices")),
                style_simulations=_optional_str(glyph_value.get("style_simulations")),
                bidi_level=cast(int | None, glyph_value.get("bidi_level")),
                sideways=bool(glyph_value["sideways"]),
                font_part=_optional_str(glyph_value.get("font_part")),
                font_content_type=_optional_str(glyph_value.get("font_content_type")),
                font_obfuscated=bool(glyph_value.get("font_obfuscated", False)),
                outline=_xps_path(
                    cast(Mapping[str, Any] | None, glyph_value.get("outline"))
                ),
            )
            if glyph_value is not None
            else None
        ),
        source=XpsSourceSpan(
            offset=int(source["offset"]),
            length=int(source["length"]),
            element=str(source["element"]),
        ),
        attributes=dict(cast(Mapping[str, str], value.get("attributes", {}))),
    )


def _xps_page(value: Mapping[str, Any]) -> XpsPage:
    canvas_groups = tuple(
        _xps_canvas_group(group)
        for group in cast(list[Mapping[str, Any]], value.get("canvas_groups", []))
    )
    canvas_groups_by_id = {group.id: group for group in canvas_groups}
    return XpsPage(
        part_name=str(value["part_name"]),
        name=str(value["name"]),
        language=_optional_str(value.get("language")),
        width=float(value["width"]),
        height=float(value["height"]),
        content_box=_optional_float_tuple(value.get("content_box")),
        bleed_box=_optional_float_tuple(value.get("bleed_box")),
        resource_dictionaries=tuple(
            str(item)
            for item in cast(list[object], value.get("resource_dictionaries", []))
        ),
        relationships=tuple(
            _opc_relationship(relationship)
            for relationship in cast(
                list[Mapping[str, Any]], value.get("relationships", [])
            )
        ),
        canvas_groups=canvas_groups,
        entities=tuple(
            _xps_entity(entity, canvas_groups_by_id)
            for entity in cast(list[Mapping[str, Any]], value.get("entities", []))
        ),
        diagnostics=tuple(
            _diagnostic(diagnostic)
            for diagnostic in cast(
                list[Mapping[str, Any]], value.get("diagnostics", [])
            )
        ),
    )


def _dwfx_from_mapping(raw: Mapping[str, Any]) -> DwfxPackageInfo:
    documents = tuple(
        XpsDocument(
            part_name=str(document["part_name"]),
            relationships=tuple(
                _opc_relationship(relationship)
                for relationship in cast(
                    list[Mapping[str, Any]], document.get("relationships", [])
                )
            ),
            pages=tuple(
                _xps_page(page)
                for page in cast(list[Mapping[str, Any]], document.get("pages", []))
            ),
        )
        for document in cast(list[Mapping[str, Any]], raw.get("documents", []))
    )
    return DwfxPackageInfo(
        format=_format_from_row(cast(tuple[str, str | None, int], raw["format"])),
        entries=tuple(
            ArchiveEntry(
                original_name=str(value["original_name"]),
                normalized_name=str(value["normalized_name"]),
                compressed_size=int(value["compressed_size"]),
                uncompressed_size=int(value["uncompressed_size"]),
                compression_method=str(value["compression_method"]),
                is_directory=bool(value["is_directory"]),
                encrypted=bool(value["encrypted"]),
            )
            for value in cast(list[Mapping[str, Any]], raw["entries"])
        ),
        content_types=tuple(
            OpcContentType(
                extension=_optional_str(value.get("extension")),
                part_name=_optional_str(value.get("part_name")),
                content_type=str(value["content_type"]),
            )
            for value in cast(list[Mapping[str, Any]], raw.get("content_types", []))
        ),
        relationships=tuple(
            _opc_relationship(value)
            for value in cast(list[Mapping[str, Any]], raw.get("relationships", []))
        ),
        document_sequence=str(raw["document_sequence"]),
        documents=documents,
        diagnostics=tuple(
            _diagnostic(value)
            for value in cast(list[Mapping[str, Any]], raw.get("diagnostics", []))
        ),
    )


def _optional_str(value: object) -> str | None:
    return None if value is None else str(value)


def _optional_float_tuple(value: object) -> tuple[float, ...] | None:
    if value is None:
        return None
    return tuple(float(item) for item in cast(list[object], value))


def _float_point(value: object) -> tuple[float, float]:
    point = tuple(float(item) for item in cast(list[object], value))
    if len(point) != 2:
        raise ValueError(f"native point must contain 2 coordinates, got {len(point)}")
    return cast(tuple[float, float], point)


def _optional_float_point(value: object) -> tuple[float, float] | None:
    return None if value is None else _float_point(value)


def _optional_int_box(value: object) -> tuple[int, int, int, int] | None:
    if value is None:
        return None
    coordinates = tuple(int(item) for item in cast(list[object], value))
    if len(coordinates) != 4:
        raise ValueError(
            f"native logical bounds must contain 4 coordinates, got {len(coordinates)}"
        )
    return cast(tuple[int, int, int, int], coordinates)


def _optional_color(value: object) -> Color | None:
    if value is None:
        return None
    channels = tuple(int(item) for item in cast(list[object], value))
    if len(channels) != 3:
        raise ValueError(
            f"native color row must contain 3 channels, got {len(channels)}"
        )
    return cast(Color, channels)


__all__ = [
    "DEFAULT_LIMITS",
    "ArchiveEntry",
    "Diagnostic",
    "DwfFormatInfo",
    "DwfSource",
    "DwfxPackageInfo",
    "Interface",
    "Manifest",
    "OpcContentType",
    "OpcRelationship",
    "PackageInfo",
    "Page",
    "PageResource",
    "Paper",
    "ParseLimits",
    "Property",
    "Resource",
    "Section",
    "SourceInfo",
    "W2dBlockRef",
    "W2dColoredPoint",
    "W2dEmbeddedFont",
    "W2dEntity",
    "W2dFont",
    "W2dImage",
    "W2dLayer",
    "W2dLineStyle",
    "W2dPoint",
    "W2dRendition",
    "W2dSourceSpan",
    "W2dStream",
    "W2dUnits",
    "W2dViewport",
    "XpsBrush",
    "XpsCanvasGroup",
    "XpsClip",
    "XpsDocument",
    "XpsEntity",
    "XpsGlyphs",
    "XpsGradientStop",
    "XpsImageMetadata",
    "XpsOpacityMask",
    "XpsPage",
    "XpsPathFigure",
    "XpsPathGeometry",
    "XpsPathSegment",
    "XpsSourceSpan",
    "XpsStyle",
    "decode_w2d",
    "detect_format",
    "inspect_dwfx",
    "inspect_package",
]
