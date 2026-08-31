//! PyO3 bindings for `ezdwf-core` package and legacy-stream parsing.

use std::collections::BTreeMap;

use ezdwf_core::{
    decode_w2d as decode_w2d_core, detect_format, inspect_dwfx,
    inspect_dwfx_without_glyph_outlines, inspect_package, normalize_dwfx, normalize_package,
    normalize_stream, DwfError as CoreDwfError, DwfFormat, DwfPackage, DwfxPackage, EPlotPage,
    NormalizedBrush, NormalizedDrawing, NormalizedEntity, NormalizedGeometry, NormalizedSheet,
    NormalizedPathSegment, NormalizedStyle, ParseOptions, Point2D, W2dEntity, W2dGeometry,
    W2dRendition, W2dStream, W2dUnits, XpsBrush, XpsEntity, XpsGeometry, XpsPathSegment,
};
use pyo3::create_exception;
use pyo3::exceptions::PyException;
use pyo3::prelude::*;
use pyo3::types::{PyBytes, PyDict, PyList};

create_exception!(
    _core,
    DwfError,
    PyException,
    "Base exception raised by ezdwf."
);
create_exception!(
    _core,
    InvalidDwfError,
    DwfError,
    "The input is not a structurally valid supported DWF package."
);
create_exception!(
    _core,
    UnsupportedDwfError,
    DwfError,
    "The DWF family or feature is recognized but unsupported."
);
create_exception!(
    _core,
    DwfLimitError,
    DwfError,
    "A configured DWF parser resource limit was exceeded."
);

type FormatRow = (String, Option<String>, usize);

#[pyfunction]
fn core_version() -> String {
    ezdwf_core::version().to_owned()
}

#[allow(clippy::too_many_arguments)]
#[pyfunction]
fn detect_format_bytes(
    data: &[u8],
    max_file_size: usize,
    max_archive_entries: usize,
    max_entry_size: usize,
    max_total_uncompressed_size: usize,
    max_compression_ratio: usize,
    max_xml_size: usize,
    max_xml_depth: usize,
    max_w2d_records: usize,
    max_w2d_points_per_entity: usize,
    max_w2d_total_points: usize,
    max_w2d_string_size: usize,
    max_w2d_nesting_depth: usize,
    max_w2d_decompressed_size: usize,
    max_w2d_compression_depth: usize,
    max_xps_visuals: usize,
    max_xps_path_segments: usize,
) -> PyResult<FormatRow> {
    let format = detect_format(
        data,
        parse_options(
            max_file_size,
            max_archive_entries,
            max_entry_size,
            max_total_uncompressed_size,
            max_compression_ratio,
            max_xml_size,
            max_xml_depth,
            max_w2d_records,
            max_w2d_points_per_entity,
            max_w2d_total_points,
            max_w2d_string_size,
            max_w2d_nesting_depth,
            max_w2d_decompressed_size,
            max_w2d_compression_depth,
            max_xps_visuals,
            max_xps_path_segments,
        ),
    )
    .map_err(core_error_to_python)?;
    Ok(format_row(&format))
}

#[allow(clippy::too_many_arguments)]
#[pyfunction]
fn inspect_package_bytes(
    py: Python<'_>,
    data: &[u8],
    max_file_size: usize,
    max_archive_entries: usize,
    max_entry_size: usize,
    max_total_uncompressed_size: usize,
    max_compression_ratio: usize,
    max_xml_size: usize,
    max_xml_depth: usize,
    max_w2d_records: usize,
    max_w2d_points_per_entity: usize,
    max_w2d_total_points: usize,
    max_w2d_string_size: usize,
    max_w2d_nesting_depth: usize,
    max_w2d_decompressed_size: usize,
    max_w2d_compression_depth: usize,
    max_xps_visuals: usize,
    max_xps_path_segments: usize,
) -> PyResult<Py<PyAny>> {
    let package = inspect_package(
        data,
        parse_options(
            max_file_size,
            max_archive_entries,
            max_entry_size,
            max_total_uncompressed_size,
            max_compression_ratio,
            max_xml_size,
            max_xml_depth,
            max_w2d_records,
            max_w2d_points_per_entity,
            max_w2d_total_points,
            max_w2d_string_size,
            max_w2d_nesting_depth,
            max_w2d_decompressed_size,
            max_w2d_compression_depth,
            max_xps_visuals,
            max_xps_path_segments,
        ),
    )
    .map_err(core_error_to_python)?;
    Ok(package_to_python(py, &package)?.into_any().unbind())
}

#[allow(clippy::too_many_arguments)]
#[pyfunction]
fn inspect_dwfx_bytes(
    py: Python<'_>,
    data: &[u8],
    max_file_size: usize,
    max_archive_entries: usize,
    max_entry_size: usize,
    max_total_uncompressed_size: usize,
    max_compression_ratio: usize,
    max_xml_size: usize,
    max_xml_depth: usize,
    max_w2d_records: usize,
    max_w2d_points_per_entity: usize,
    max_w2d_total_points: usize,
    max_w2d_string_size: usize,
    max_w2d_nesting_depth: usize,
    max_w2d_decompressed_size: usize,
    max_w2d_compression_depth: usize,
    max_xps_visuals: usize,
    max_xps_path_segments: usize,
    resolve_glyph_outlines: bool,
) -> PyResult<Py<PyAny>> {
    let options = parse_options(
        max_file_size,
        max_archive_entries,
        max_entry_size,
        max_total_uncompressed_size,
        max_compression_ratio,
        max_xml_size,
        max_xml_depth,
        max_w2d_records,
        max_w2d_points_per_entity,
        max_w2d_total_points,
        max_w2d_string_size,
        max_w2d_nesting_depth,
        max_w2d_decompressed_size,
        max_w2d_compression_depth,
        max_xps_visuals,
        max_xps_path_segments,
    );
    let package = if resolve_glyph_outlines {
        inspect_dwfx(data, options)
    } else {
        inspect_dwfx_without_glyph_outlines(data, options)
    }
    .map_err(core_error_to_python)?;
    Ok(dwfx_to_python(py, &package)?.into_any().unbind())
}

#[allow(clippy::too_many_arguments)]
#[pyfunction]
fn read_drawing_bytes(
    py: Python<'_>,
    data: &[u8],
    max_file_size: usize,
    max_archive_entries: usize,
    max_entry_size: usize,
    max_total_uncompressed_size: usize,
    max_compression_ratio: usize,
    max_xml_size: usize,
    max_xml_depth: usize,
    max_w2d_records: usize,
    max_w2d_points_per_entity: usize,
    max_w2d_total_points: usize,
    max_w2d_string_size: usize,
    max_w2d_nesting_depth: usize,
    max_w2d_decompressed_size: usize,
    max_w2d_compression_depth: usize,
    max_xps_visuals: usize,
    max_xps_path_segments: usize,
) -> PyResult<Py<PyAny>> {
    let options = parse_options(
        max_file_size,
        max_archive_entries,
        max_entry_size,
        max_total_uncompressed_size,
        max_compression_ratio,
        max_xml_size,
        max_xml_depth,
        max_w2d_records,
        max_w2d_points_per_entity,
        max_w2d_total_points,
        max_w2d_string_size,
        max_w2d_nesting_depth,
        max_w2d_decompressed_size,
        max_w2d_compression_depth,
        max_xps_visuals,
        max_xps_path_segments,
    );
    let format = detect_format(data, options).map_err(core_error_to_python)?;
    let output = PyDict::new(py);
    match format {
        DwfFormat::DwfPackage { .. } => {
            let package = inspect_package(data, options).map_err(core_error_to_python)?;
            let drawing = normalize_package(&package).map_err(core_error_to_python)?;
            output.set_item("package", package_to_python(py, &package)?)?;
            output.set_item("legacy_stream", py.None())?;
            output.set_item("dwfx_package", py.None())?;
            output.set_item("drawing", normalized_drawing_to_python(py, &drawing)?)?;
        }
        DwfFormat::LegacyDwf { .. } => {
            let mut stream =
                decode_w2d_core(data, "<legacy.dwf>", options).map_err(core_error_to_python)?;
            stream.role = "legacy 2d streaming graphics".to_owned();
            stream.mime = "application/x-dwf".to_owned();
            let drawing = normalize_stream(&stream);
            output.set_item("package", py.None())?;
            output.set_item("legacy_stream", w2d_stream_to_python(py, &stream)?)?;
            output.set_item("dwfx_package", py.None())?;
            output.set_item("drawing", normalized_drawing_to_python(py, &drawing)?)?;
        }
        DwfFormat::Dwfx => {
            let package = inspect_dwfx(data, options).map_err(core_error_to_python)?;
            let drawing = normalize_dwfx(&package);
            output.set_item("package", py.None())?;
            output.set_item("legacy_stream", py.None())?;
            output.set_item("dwfx_package", dwfx_to_python(py, &package)?)?;
            output.set_item("drawing", normalized_drawing_to_python(py, &drawing)?)?;
        }
    }
    Ok(output.into_any().unbind())
}

/// Rust-side holder for a parsed drawing, exposed so the Python layer can
/// pull the result in PIECES instead of one monolithic dict tree.
///
/// `read_drawing_bytes` converts the raw package, every W2D display list and
/// every normalized sheet into Python objects in a single call, so all of
/// them are alive at once — on a real 9-sheet plot set (74k entities) that
/// transient tree peaks over 1 GB for a 630 KB file. The handle keeps the
/// parsed data in Rust and converts on demand: the package shell (without
/// per-entity display lists), then one stream's entities at a time, then one
/// normalized sheet at a time. The Python wrapper frees each piece's dict as
/// soon as it has folded it into its dataclasses, so peak memory tracks the
/// LARGEST piece rather than the sum of all of them.
#[pyclass(module = "ezdwf._core", frozen)]
struct DrawingHandle {
    package: Option<DwfPackage>,
    legacy_stream: Option<W2dStream>,
    dwfx_package: Option<DwfxPackage>,
    drawing: NormalizedDrawing,
}

#[pymethods]
impl DrawingHandle {
    /// Which container format was parsed: "package" | "legacy" | "dwfx".
    fn kind(&self) -> &'static str {
        if self.package.is_some() {
            "package"
        } else if self.legacy_stream.is_some() {
            "legacy"
        } else {
            "dwfx"
        }
    }

    fn sheet_count(&self) -> usize {
        self.drawing.sheets.len()
    }

    /// One normalized sheet as the same dict `read_drawing_bytes` produced
    /// inside `drawing.sheets[index]`.
    fn sheet(&self, py: Python<'_>, index: usize) -> PyResult<Py<PyAny>> {
        let sheet = self.drawing.sheets.get(index).ok_or_else(|| {
            pyo3::exceptions::PyIndexError::new_err(format!(
                "sheet index {index} out of range (0..{})",
                self.drawing.sheets.len()
            ))
        })?;
        Ok(normalized_sheet_to_python(py, sheet)?.into_any().unbind())
    }

    /// The package dict WITHOUT per-stream entity display lists (each
    /// stream's `entities` is `None`); fetch them per stream via
    /// `stream_entities`. Errors for non-package formats.
    fn package_shell(&self, py: Python<'_>) -> PyResult<Py<PyAny>> {
        let package = self.package.as_ref().ok_or_else(|| {
            pyo3::exceptions::PyValueError::new_err("not a DWF 6 package")
        })?;
        Ok(package_to_python_impl(py, package, false)?.into_any().unbind())
    }

    /// One W2D stream's raw entity dicts, in display-list order.
    fn stream_entities(
        &self,
        py: Python<'_>,
        section_index: usize,
        stream_index: usize,
    ) -> PyResult<Py<PyAny>> {
        let package = self.package.as_ref().ok_or_else(|| {
            pyo3::exceptions::PyValueError::new_err("not a DWF 6 package")
        })?;
        let section = package.manifest.sections.get(section_index).ok_or_else(|| {
            pyo3::exceptions::PyIndexError::new_err(format!(
                "section index {section_index} out of range (0..{})",
                package.manifest.sections.len()
            ))
        })?;
        let stream = section.w2d_streams.get(stream_index).ok_or_else(|| {
            pyo3::exceptions::PyIndexError::new_err(format!(
                "stream index {stream_index} out of range (0..{})",
                section.w2d_streams.len()
            ))
        })?;
        let entities = PyList::empty(py);
        for entity in &stream.entities {
            entities.append(w2d_entity_to_python(py, entity)?)?;
        }
        Ok(entities.into_any().unbind())
    }

    /// Full legacy-stream dict (single display list; not worth streaming).
    fn legacy_stream(&self, py: Python<'_>) -> PyResult<Py<PyAny>> {
        let stream = self.legacy_stream.as_ref().ok_or_else(|| {
            pyo3::exceptions::PyValueError::new_err("not a legacy 2D stream")
        })?;
        Ok(w2d_stream_to_python(py, stream)?.into_any().unbind())
    }

    /// Full DWFx package dict (XPS pages carry their own model).
    fn dwfx_package(&self, py: Python<'_>) -> PyResult<Py<PyAny>> {
        let package = self.dwfx_package.as_ref().ok_or_else(|| {
            pyo3::exceptions::PyValueError::new_err("not a DWFx package")
        })?;
        Ok(dwfx_to_python(py, package)?.into_any().unbind())
    }
}

#[allow(clippy::too_many_arguments)]
#[pyfunction]
fn read_drawing_handle(
    data: &[u8],
    max_file_size: usize,
    max_archive_entries: usize,
    max_entry_size: usize,
    max_total_uncompressed_size: usize,
    max_compression_ratio: usize,
    max_xml_size: usize,
    max_xml_depth: usize,
    max_w2d_records: usize,
    max_w2d_points_per_entity: usize,
    max_w2d_total_points: usize,
    max_w2d_string_size: usize,
    max_w2d_nesting_depth: usize,
    max_w2d_decompressed_size: usize,
    max_w2d_compression_depth: usize,
    max_xps_visuals: usize,
    max_xps_path_segments: usize,
) -> PyResult<DrawingHandle> {
    let options = parse_options(
        max_file_size,
        max_archive_entries,
        max_entry_size,
        max_total_uncompressed_size,
        max_compression_ratio,
        max_xml_size,
        max_xml_depth,
        max_w2d_records,
        max_w2d_points_per_entity,
        max_w2d_total_points,
        max_w2d_string_size,
        max_w2d_nesting_depth,
        max_w2d_decompressed_size,
        max_w2d_compression_depth,
        max_xps_visuals,
        max_xps_path_segments,
    );
    let format = detect_format(data, options).map_err(core_error_to_python)?;
    match format {
        DwfFormat::DwfPackage { .. } => {
            let package = inspect_package(data, options).map_err(core_error_to_python)?;
            let drawing = normalize_package(&package).map_err(core_error_to_python)?;
            Ok(DrawingHandle {
                package: Some(package),
                legacy_stream: None,
                dwfx_package: None,
                drawing,
            })
        }
        DwfFormat::LegacyDwf { .. } => {
            let mut stream =
                decode_w2d_core(data, "<legacy.dwf>", options).map_err(core_error_to_python)?;
            stream.role = "legacy 2d streaming graphics".to_owned();
            stream.mime = "application/x-dwf".to_owned();
            let drawing = normalize_stream(&stream);
            Ok(DrawingHandle {
                package: None,
                legacy_stream: Some(stream),
                dwfx_package: None,
                drawing,
            })
        }
        DwfFormat::Dwfx => {
            let package = inspect_dwfx(data, options).map_err(core_error_to_python)?;
            let drawing = normalize_dwfx(&package);
            Ok(DrawingHandle {
                package: None,
                legacy_stream: None,
                dwfx_package: Some(package),
                drawing,
            })
        }
    }
}

#[allow(clippy::too_many_arguments)]
#[pyfunction]
fn decode_w2d_bytes(
    py: Python<'_>,
    data: &[u8],
    resource: &str,
    max_file_size: usize,
    max_archive_entries: usize,
    max_entry_size: usize,
    max_total_uncompressed_size: usize,
    max_compression_ratio: usize,
    max_xml_size: usize,
    max_xml_depth: usize,
    max_w2d_records: usize,
    max_w2d_points_per_entity: usize,
    max_w2d_total_points: usize,
    max_w2d_string_size: usize,
    max_w2d_nesting_depth: usize,
    max_w2d_decompressed_size: usize,
    max_w2d_compression_depth: usize,
    max_xps_visuals: usize,
    max_xps_path_segments: usize,
) -> PyResult<Py<PyAny>> {
    if data.len() > max_entry_size {
        return Err(DwfLimitError::new_err(format!(
            "W2D resource size {} bytes exceeds configured entry limit {max_entry_size} bytes",
            data.len()
        )));
    }
    let stream = decode_w2d_core(
        data,
        resource,
        parse_options(
            max_file_size,
            max_archive_entries,
            max_entry_size,
            max_total_uncompressed_size,
            max_compression_ratio,
            max_xml_size,
            max_xml_depth,
            max_w2d_records,
            max_w2d_points_per_entity,
            max_w2d_total_points,
            max_w2d_string_size,
            max_w2d_nesting_depth,
            max_w2d_decompressed_size,
            max_w2d_compression_depth,
            max_xps_visuals,
            max_xps_path_segments,
        ),
    )
    .map_err(core_error_to_python)?;
    Ok(w2d_stream_to_python(py, &stream)?.into_any().unbind())
}

#[allow(clippy::too_many_arguments)]
fn parse_options(
    max_file_size: usize,
    max_archive_entries: usize,
    max_entry_size: usize,
    max_total_uncompressed_size: usize,
    max_compression_ratio: usize,
    max_xml_size: usize,
    max_xml_depth: usize,
    max_w2d_records: usize,
    max_w2d_points_per_entity: usize,
    max_w2d_total_points: usize,
    max_w2d_string_size: usize,
    max_w2d_nesting_depth: usize,
    max_w2d_decompressed_size: usize,
    max_w2d_compression_depth: usize,
    max_xps_visuals: usize,
    max_xps_path_segments: usize,
) -> ParseOptions {
    ParseOptions {
        max_file_size,
        max_archive_entries,
        max_entry_size,
        max_total_uncompressed_size,
        max_compression_ratio,
        max_xml_size,
        max_xml_depth,
        max_w2d_records,
        max_w2d_points_per_entity,
        max_w2d_total_points,
        max_w2d_string_size,
        max_w2d_nesting_depth,
        max_w2d_decompressed_size,
        max_w2d_compression_depth,
        max_xps_visuals,
        max_xps_path_segments,
    }
}

fn format_row(format: &DwfFormat) -> FormatRow {
    (
        format.kind().to_owned(),
        format.version().map(|version| version.to_string()),
        format.package_prefix_len(),
    )
}

fn normalized_drawing_to_python<'py>(
    py: Python<'py>,
    drawing: &NormalizedDrawing,
) -> PyResult<Bound<'py, PyDict>> {
    let value = PyDict::new(py);
    let sheets = PyList::empty(py);
    for sheet in &drawing.sheets {
        sheets.append(normalized_sheet_to_python(py, sheet)?)?;
    }
    value.set_item("sheets", sheets)?;
    Ok(value)
}

fn normalized_sheet_to_python<'py>(
    py: Python<'py>,
    sheet: &NormalizedSheet,
) -> PyResult<Bound<'py, PyDict>> {
    let sheet_value = PyDict::new(py);
    sheet_value.set_item("section_index", sheet.section_index)?;
    sheet_value.set_item("name", &sheet.name)?;
    sheet_value.set_item("title", &sheet.title)?;
    sheet_value.set_item("plot_order", sheet.plot_order)?;
    sheet_value.set_item("units", &sheet.units)?;
    sheet_value.set_item("paper_bounds", sheet.paper_bounds.map(Vec::from))?;
    sheet_value.set_item("clip", sheet.clip.map(Vec::from))?;
    sheet_value.set_item("background_color", sheet.background_color.map(Vec::from))?;
    sheet_value.set_item("content_bounds", sheet.content_bounds.map(Vec::from))?;
    let entities = PyList::empty(py);
    for entity in &sheet.entities {
        entities.append(normalized_entity_to_python(py, entity)?)?;
    }
    sheet_value.set_item("entities", entities)?;
    let markup_entities = PyList::empty(py);
    for entity in &sheet.markup_entities {
        markup_entities.append(normalized_entity_to_python(py, entity)?)?;
    }
    sheet_value.set_item("markup_entities", markup_entities)?;
    Ok(sheet_value)
}

fn normalized_entity_to_python<'py>(
    py: Python<'py>,
    entity: &NormalizedEntity,
) -> PyResult<Bound<'py, PyDict>> {
    let value = PyDict::new(py);
    value.set_item("kind", entity.geometry.kind())?;
    value.set_item("section_index", entity.section_index)?;
    value.set_item("stream_index", entity.stream_index)?;
    value.set_item("entity_index", entity.entity_index)?;
    value.set_item("resource_href", &entity.resource_href)?;
    value.set_item("resource_role", &entity.resource_role)?;
    value.set_item("is_markup", entity.is_markup)?;
    value.set_item("points", Vec::<(f64, f64)>::new())?;
    value.set_item("center", py.None())?;
    value.set_item("x_axis", py.None())?;
    value.set_item("y_axis", py.None())?;
    value.set_item("start_angle_degrees", py.None())?;
    value.set_item("end_angle_degrees", py.None())?;
    value.set_item("closed", false)?;
    value.set_item("text", py.None())?;
    value.set_item("bounds", py.None())?;
    value.set_item("colored_points", Vec::<Py<PyAny>>::new())?;
    value.set_item("contours", Vec::<Vec<(f64, f64)>>::new())?;
    value.set_item("image", py.None())?;
    value.set_item("path", Vec::<Py<PyAny>>::new())?;
    value.set_item("fill_rule", py.None())?;
    value.set_item("glyph_outline", py.None())?;
    match &entity.geometry {
        NormalizedGeometry::Line { points } => {
            value.set_item("points", points.map(point_row))?;
        }
        NormalizedGeometry::Polyline { points }
        | NormalizedGeometry::Polymarker { points }
        | NormalizedGeometry::Polygon { points }
        | NormalizedGeometry::PolyBezier { points }
        | NormalizedGeometry::Polytriangle { points }
        | NormalizedGeometry::TexturedPolytriangle { points } => {
            value.set_item(
                "points",
                points.iter().copied().map(point_row).collect::<Vec<_>>(),
            )?;
            value.set_item(
                "closed",
                matches!(entity.geometry, NormalizedGeometry::Polygon { .. }),
            )?;
        }
        NormalizedGeometry::Circle {
            center,
            x_axis,
            y_axis,
        } => {
            value.set_item("center", point_row(*center))?;
            value.set_item("x_axis", point_row(*x_axis))?;
            value.set_item("y_axis", point_row(*y_axis))?;
            value.set_item("closed", true)?;
        }
        NormalizedGeometry::Arc {
            center,
            x_axis,
            y_axis,
            start_angle_degrees,
            end_angle_degrees,
        } => {
            value.set_item("center", point_row(*center))?;
            value.set_item("x_axis", point_row(*x_axis))?;
            value.set_item("y_axis", point_row(*y_axis))?;
            value.set_item("start_angle_degrees", start_angle_degrees)?;
            value.set_item("end_angle_degrees", end_angle_degrees)?;
        }
        NormalizedGeometry::Ellipse {
            center,
            x_axis,
            y_axis,
            start_angle_degrees,
            end_angle_degrees,
            closed,
        } => {
            value.set_item("center", point_row(*center))?;
            value.set_item("x_axis", point_row(*x_axis))?;
            value.set_item("y_axis", point_row(*y_axis))?;
            value.set_item("start_angle_degrees", start_angle_degrees)?;
            value.set_item("end_angle_degrees", end_angle_degrees)?;
            value.set_item("closed", closed)?;
        }
        NormalizedGeometry::Text {
            position,
            text,
            bounds,
        } => {
            value.set_item("points", vec![point_row(*position)])?;
            value.set_item("text", text)?;
            value.set_item(
                "bounds",
                bounds.map(|bounds| bounds.map(point_row).to_vec()),
            )?;
        }
        NormalizedGeometry::GouraudPolyline { points }
        | NormalizedGeometry::GouraudPolytriangle { points } => {
            value.set_item(
                "points",
                points
                    .iter()
                    .map(|item| point_row(item.point))
                    .collect::<Vec<_>>(),
            )?;
            let colored = PyList::empty(py);
            for item in points {
                let row = PyDict::new(py);
                row.set_item("point", point_row(item.point))?;
                row.set_item("color", item.color.to_vec())?;
                colored.append(row)?;
            }
            value.set_item("colored_points", colored)?;
        }
        NormalizedGeometry::ContourSet { contours } => {
            value.set_item(
                "contours",
                contours
                    .iter()
                    .map(|points| points.iter().copied().map(point_row).collect::<Vec<_>>())
                    .collect::<Vec<_>>(),
            )?;
        }
        NormalizedGeometry::Image { image } => {
            let row = PyDict::new(py);
            row.set_item("format", &image.format)?;
            row.set_item("identifier", image.identifier)?;
            row.set_item("columns", image.columns)?;
            row.set_item("rows", image.rows)?;
            row.set_item("min", point_row(image.min))?;
            row.set_item("max", point_row(image.max))?;
            row.set_item(
                "color_map",
                image
                    .color_map
                    .iter()
                    .map(|color| color.to_vec())
                    .collect::<Vec<_>>(),
            )?;
            row.set_item("data", PyBytes::new(py, &image.data))?;
            value.set_item("image", row)?;
        }
        NormalizedGeometry::Path { fill_rule, figures } => {
            value.set_item("fill_rule", fill_rule)?;
            let path = PyList::empty(py);
            let mut flat_points = Vec::new();
            for figure in figures {
                let row = PyDict::new(py);
                row.set_item("start", point_row(figure.start))?;
                row.set_item("closed", figure.closed)?;
                row.set_item("filled", figure.filled)?;
                flat_points.push(point_row(figure.start));
                let segments = PyList::empty(py);
                for segment in &figure.segments {
                    let segment_row = PyDict::new(py);
                    segment_row.set_item("kind", segment.kind())?;
                    segment_row.set_item("stroked", segment.stroked())?;
                    segment_row.set_item("smooth_join", segment.smooth_join())?;
                    match segment {
                        NormalizedPathSegment::Line { end, .. } => {
                            segment_row.set_item("end", point_row(*end))?;
                            flat_points.push(point_row(*end));
                        }
                        NormalizedPathSegment::CubicBezier {
                            control1,
                            control2,
                            end,
                            ..
                        } => {
                            segment_row.set_item("control1", point_row(*control1))?;
                            segment_row.set_item("control2", point_row(*control2))?;
                            segment_row.set_item("end", point_row(*end))?;
                            flat_points.extend([
                                point_row(*control1),
                                point_row(*control2),
                                point_row(*end),
                            ]);
                        }
                        NormalizedPathSegment::QuadraticBezier { control, end, .. } => {
                            segment_row.set_item("control", point_row(*control))?;
                            segment_row.set_item("end", point_row(*end))?;
                            flat_points.extend([point_row(*control), point_row(*end)]);
                        }
                        NormalizedPathSegment::EllipticalArc {
                            center,
                            x_axis,
                            y_axis,
                            start_angle_degrees,
                            sweep_angle_degrees,
                            end,
                            ..
                        } => {
                            segment_row.set_item("center", point_row(*center))?;
                            segment_row.set_item("x_axis", point_row(*x_axis))?;
                            segment_row.set_item("y_axis", point_row(*y_axis))?;
                            segment_row.set_item("start_angle_degrees", start_angle_degrees)?;
                            segment_row.set_item("sweep_angle_degrees", sweep_angle_degrees)?;
                            segment_row.set_item("end", point_row(*end))?;
                            flat_points.push(point_row(*end));
                        }
                    }
                    segments.append(segment_row)?;
                }
                row.set_item("segments", segments)?;
                path.append(row)?;
            }
            value.set_item("points", flat_points)?;
            value.set_item("path", path)?;
            value.set_item("closed", figures.iter().all(|figure| figure.closed))?;
        }
    }
    let clips = PyList::empty(py);
    for clip in &entity.clips {
        let row = PyDict::new(py);
        row.set_item("fill_rule", &clip.fill_rule)?;
        row.set_item(
            "figures",
            normalized_path_figures_to_python(py, &clip.figures)?,
        )?;
        clips.append(row)?;
    }
    value.set_item("clips", clips)?;
    let local_clips = PyList::empty(py);
    for clip in &entity.local_clips {
        let row = PyDict::new(py);
        row.set_item("fill_rule", &clip.fill_rule)?;
        row.set_item(
            "figures",
            normalized_path_figures_to_python(py, &clip.figures)?,
        )?;
        local_clips.append(row)?;
    }
    value.set_item("local_clips", local_clips)?;
    let opacity_masks = PyList::empty(py);
    for mask in &entity.opacity_masks {
        opacity_masks.append(normalized_brush_to_python(py, mask)?)?;
    }
    value.set_item("opacity_masks", opacity_masks)?;
    let local_opacity_masks = PyList::empty(py);
    for mask in &entity.local_opacity_masks {
        local_opacity_masks.append(normalized_brush_to_python(py, mask)?)?;
    }
    value.set_item("local_opacity_masks", local_opacity_masks)?;
    let compositing_groups = PyList::empty(py);
    for group in &entity.compositing_groups {
        let row = PyDict::new(py);
        row.set_item("id", group.id)?;
        row.set_item("name", &group.name)?;
        row.set_item("opacity", group.opacity)?;
        row.set_item(
            "clip",
            group
                .clip
                .as_ref()
                .map(|clip| {
                    let value = PyDict::new(py);
                    value.set_item("fill_rule", &clip.fill_rule)?;
                    value.set_item(
                        "figures",
                        normalized_path_figures_to_python(py, &clip.figures)?,
                    )?;
                    Ok::<_, PyErr>(value)
                })
                .transpose()?,
        )?;
        row.set_item(
            "opacity_mask",
            group
                .opacity_mask
                .as_ref()
                .map(|brush| normalized_brush_to_python(py, brush))
                .transpose()?,
        )?;
        compositing_groups.append(row)?;
    }
    value.set_item("compositing_groups", compositing_groups)?;
    value.set_item(
        "glyph_outline",
        entity
            .glyph_outline
            .as_ref()
            .map(|figures| normalized_path_figures_to_python(py, figures))
            .transpose()?,
    )?;
    value.set_item("style", normalized_style_to_python(py, &entity.style)?)?;
    let source = PyDict::new(py);
    source.set_item("offset", entity.source.offset)?;
    source.set_item("length", entity.source.length)?;
    source.set_item("opcode", &entity.source.opcode)?;
    source.set_item("decoded_offset", entity.source.decoded_offset)?;
    source.set_item("decoded_length", entity.source.decoded_length)?;
    source.set_item("compression_depth", entity.source.compression_depth)?;
    value.set_item("source", source)?;
    Ok(value)
}

fn normalized_path_figures_to_python<'py>(
    py: Python<'py>,
    figures: &[ezdwf_core::NormalizedPathFigure],
) -> PyResult<Bound<'py, PyList>> {
    let output = PyList::empty(py);
    for figure in figures {
        let row = PyDict::new(py);
        row.set_item("start", point_row(figure.start))?;
        row.set_item("closed", figure.closed)?;
        row.set_item("filled", figure.filled)?;
        let segments = PyList::empty(py);
        for segment in &figure.segments {
            let segment_row = PyDict::new(py);
            segment_row.set_item("kind", segment.kind())?;
            segment_row.set_item("stroked", segment.stroked())?;
            segment_row.set_item("smooth_join", segment.smooth_join())?;
            match segment {
                NormalizedPathSegment::Line { end, .. } => {
                    segment_row.set_item("end", point_row(*end))?;
                }
                NormalizedPathSegment::CubicBezier {
                    control1,
                    control2,
                    end,
                    ..
                } => {
                    segment_row.set_item("control1", point_row(*control1))?;
                    segment_row.set_item("control2", point_row(*control2))?;
                    segment_row.set_item("end", point_row(*end))?;
                }
                NormalizedPathSegment::QuadraticBezier { control, end, .. } => {
                    segment_row.set_item("control", point_row(*control))?;
                    segment_row.set_item("end", point_row(*end))?;
                }
                NormalizedPathSegment::EllipticalArc {
                    center,
                    x_axis,
                    y_axis,
                    start_angle_degrees,
                    sweep_angle_degrees,
                    end,
                    ..
                } => {
                    segment_row.set_item("center", point_row(*center))?;
                    segment_row.set_item("x_axis", point_row(*x_axis))?;
                    segment_row.set_item("y_axis", point_row(*y_axis))?;
                    segment_row.set_item("start_angle_degrees", start_angle_degrees)?;
                    segment_row.set_item("sweep_angle_degrees", sweep_angle_degrees)?;
                    segment_row.set_item("end", point_row(*end))?;
                }
            }
            segments.append(segment_row)?;
        }
        row.set_item("segments", segments)?;
        output.append(row)?;
    }
    Ok(output)
}

fn normalized_style_to_python<'py>(
    py: Python<'py>,
    style: &NormalizedStyle,
) -> PyResult<Bound<'py, PyDict>> {
    let value = PyDict::new(py);
    value.set_item("layer_number", style.layer_number)?;
    value.set_item("layer_name", &style.layer_name)?;
    value.set_item("color", style.color.map(Vec::from))?;
    value.set_item("color_index", style.color_index)?;
    value.set_item("line_pattern", &style.line_pattern)?;
    value.set_item("line_weight_logical", style.line_weight_logical)?;
    value.set_item("nominal_stroke_width", style.nominal_stroke_width)?;
    value.set_item("fill", style.fill)?;
    value.set_item("fill_pattern", &style.fill_pattern)?;
    value.set_item("font_name", &style.font.name)?;
    value.set_item("font_canonical_name", &style.font.canonical_name)?;
    value.set_item("font_bold", style.font.bold)?;
    value.set_item("font_italic", style.font.italic)?;
    value.set_item("font_underlined", style.font.underlined)?;
    value.set_item("font_height", style.font_height)?;
    value.set_item("font_rotation_degrees", style.font_rotation_degrees)?;
    value.set_item("visible", style.visible)?;
    value.set_item("viewport", &style.viewport)?;
    value.set_item("stroke_color", style.stroke_color.map(Vec::from))?;
    value.set_item("fill_color", style.fill_color.map(Vec::from))?;
    value.set_item("opacity", style.opacity)?;
    value.set_item("stroke_dash_array", &style.stroke_dash_array)?;
    value.set_item("stroke_dash_offset", style.stroke_dash_offset)?;
    value.set_item(
        "fill_brush",
        style
            .fill_brush
            .as_ref()
            .map(|brush| normalized_brush_to_python(py, brush))
            .transpose()?,
    )?;
    value.set_item(
        "stroke_brush",
        style
            .stroke_brush
            .as_ref()
            .map(|brush| normalized_brush_to_python(py, brush))
            .transpose()?,
    )?;
    Ok(value)
}

fn normalized_brush_to_python<'py>(
    py: Python<'py>,
    brush: &NormalizedBrush,
) -> PyResult<Bound<'py, PyDict>> {
    let output = PyDict::new(py);
    match brush {
        NormalizedBrush::Solid { color, opacity } => {
            output.set_item("kind", "solid")?;
            output.set_item("color", color.to_vec())?;
            output.set_item("opacity", opacity)?;
        }
        NormalizedBrush::Image { brush } => {
            output.set_item("kind", "image")?;
            output.set_item("source", &brush.source)?;
            output.set_item("resource_part", &brush.resource_part)?;
            output.set_item("content_type", &brush.content_type)?;
            output.set_item("data", PyBytes::new(py, &brush.data))?;
            output.set_item("pixel_width", brush.pixel_width)?;
            output.set_item("pixel_height", brush.pixel_height)?;
            output.set_item("dpi_x", brush.dpi_x)?;
            output.set_item("dpi_y", brush.dpi_y)?;
            output.set_item("physical_size_dip", brush.physical_size_dip.map(Vec::from))?;
            output.set_item("viewbox", brush.viewbox.map(Vec::from))?;
            output.set_item("viewport", brush.viewport.map(Vec::from))?;
            output.set_item("source_viewport", brush.source_viewport.map(Vec::from))?;
            output.set_item("viewbox_units", &brush.viewbox_units)?;
            output.set_item("viewport_units", &brush.viewport_units)?;
            output.set_item("tile_mode", &brush.tile_mode)?;
            output.set_item(
                "transform",
                [
                    brush.transform.a,
                    brush.transform.b,
                    brush.transform.c,
                    brush.transform.d,
                    brush.transform.e,
                    brush.transform.f,
                ],
            )?;
            output.set_item("opacity", brush.opacity)?;
        }
        NormalizedBrush::Visual { brush } => {
            output.set_item("kind", "visual")?;
            let entities = PyList::empty(py);
            for entity in &brush.entities {
                entities.append(normalized_entity_to_python(py, entity)?)?;
            }
            output.set_item("entities", entities)?;
            output.set_item("viewbox", brush.viewbox.to_vec())?;
            output.set_item("viewport", brush.viewport.to_vec())?;
            output.set_item("source_viewport", brush.source_viewport.to_vec())?;
            output.set_item("viewbox_units", &brush.viewbox_units)?;
            output.set_item("viewport_units", &brush.viewport_units)?;
            output.set_item("tile_mode", &brush.tile_mode)?;
            output.set_item(
                "transform",
                [
                    brush.transform.a,
                    brush.transform.b,
                    brush.transform.c,
                    brush.transform.d,
                    brush.transform.e,
                    brush.transform.f,
                ],
            )?;
            output.set_item("opacity", brush.opacity)?;
        }
        NormalizedBrush::LinearGradient {
            start_point,
            end_point,
            spread_method,
            mapping_mode,
            gradient_stops,
            opacity,
        } => {
            output.set_item("kind", "linear_gradient")?;
            output.set_item("start_point", point_row(*start_point))?;
            output.set_item("end_point", point_row(*end_point))?;
            output.set_item("spread_method", spread_method)?;
            output.set_item("mapping_mode", mapping_mode)?;
            output.set_item(
                "gradient_stops",
                gradient_stops_to_python(py, gradient_stops)?,
            )?;
            output.set_item("opacity", opacity)?;
        }
        NormalizedBrush::RadialGradient {
            center,
            gradient_origin,
            x_axis,
            y_axis,
            spread_method,
            mapping_mode,
            gradient_stops,
            opacity,
        } => {
            output.set_item("kind", "radial_gradient")?;
            output.set_item("center", point_row(*center))?;
            output.set_item("gradient_origin", point_row(*gradient_origin))?;
            output.set_item("x_axis", point_row(*x_axis))?;
            output.set_item("y_axis", point_row(*y_axis))?;
            output.set_item("spread_method", spread_method)?;
            output.set_item("mapping_mode", mapping_mode)?;
            output.set_item(
                "gradient_stops",
                gradient_stops_to_python(py, gradient_stops)?,
            )?;
            output.set_item("opacity", opacity)?;
        }
        NormalizedBrush::Unsupported { brush_type } => {
            output.set_item("kind", "unsupported")?;
            output.set_item("brush_type", brush_type)?;
        }
    }
    Ok(output)
}

fn gradient_stops_to_python<'py>(
    py: Python<'py>,
    stops: &[ezdwf_core::NormalizedGradientStop],
) -> PyResult<Bound<'py, PyList>> {
    let output = PyList::empty(py);
    for stop in stops {
        let row = PyDict::new(py);
        row.set_item("color", stop.color.map(Vec::from))?;
        row.set_item("color_value", &stop.color_value)?;
        row.set_item("offset", stop.offset)?;
        output.append(row)?;
    }
    Ok(output)
}

fn point_row(point: Point2D) -> (f64, f64) {
    (point.x, point.y)
}

fn package_to_python<'py>(py: Python<'py>, package: &DwfPackage) -> PyResult<Bound<'py, PyDict>> {
    package_to_python_impl(py, package, true)
}

fn package_to_python_impl<'py>(
    py: Python<'py>,
    package: &DwfPackage,
    include_stream_entities: bool,
) -> PyResult<Bound<'py, PyDict>> {
    let output = PyDict::new(py);
    output.set_item("format", format_row(&package.format))?;

    let entries = PyList::empty(py);
    for entry in &package.entries {
        let value = PyDict::new(py);
        value.set_item("original_name", &entry.original_name)?;
        value.set_item("normalized_name", &entry.normalized_name)?;
        value.set_item("compressed_size", entry.compressed_size)?;
        value.set_item("uncompressed_size", entry.uncompressed_size)?;
        value.set_item("compression_method", &entry.compression_method)?;
        value.set_item("is_directory", entry.is_directory)?;
        value.set_item("encrypted", entry.encrypted)?;
        entries.append(value)?;
    }
    output.set_item("entries", entries)?;

    let manifest = PyDict::new(py);
    manifest.set_item("version", &package.manifest.version)?;
    manifest.set_item("object_id", &package.manifest.object_id)?;
    manifest.set_item(
        "properties",
        properties_to_python(py, &package.manifest.properties)?,
    )?;

    let interfaces = PyList::empty(py);
    for interface in &package.manifest.interfaces {
        let value = PyDict::new(py);
        value.set_item("object_id", &interface.object_id)?;
        value.set_item("name", &interface.name)?;
        value.set_item("href", &interface.href)?;
        interfaces.append(value)?;
    }
    manifest.set_item("interfaces", interfaces)?;

    let sections = PyList::empty(py);
    for section in &package.manifest.sections {
        let value = PyDict::new(py);
        value.set_item("section_type", &section.section_type)?;
        value.set_item("name", &section.name)?;
        value.set_item("title", &section.title)?;
        if let Some(source) = &section.source {
            let source_value = PyDict::new(py);
            source_value.set_item("provider", &source.provider)?;
            source_value.set_item("href", &source.href)?;
            value.set_item("source", source_value)?;
        } else {
            value.set_item("source", py.None())?;
        }

        let resources = PyList::empty(py);
        for resource in &section.resources {
            let resource_value = PyDict::new(py);
            resource_value.set_item("role", &resource.role)?;
            resource_value.set_item("mime", &resource.mime)?;
            resource_value.set_item("href", &resource.href)?;
            resource_value.set_item("normalized_href", &resource.normalized_href)?;
            resources.append(resource_value)?;
        }
        value.set_item("resources", resources)?;
        let streams = PyList::empty(py);
        for stream in &section.w2d_streams {
            streams.append(w2d_stream_to_python_impl(py, stream, include_stream_entities)?)?;
        }
        value.set_item("w2d_streams", streams)?;
        value.set_item(
            "page",
            section
                .page
                .as_ref()
                .map(|page| page_to_python(py, page))
                .transpose()?,
        )?;
        sections.append(value)?;
    }
    manifest.set_item("sections", sections)?;
    output.set_item("manifest", manifest)?;

    let diagnostics = PyList::empty(py);
    for diagnostic in &package.diagnostics {
        let value = PyDict::new(py);
        value.set_item("code", &diagnostic.code)?;
        value.set_item("severity", diagnostic.severity.to_string())?;
        value.set_item("message", &diagnostic.message)?;
        value.set_item("action", &diagnostic.action)?;
        value.set_item("section", &diagnostic.section)?;
        value.set_item("resource", &diagnostic.resource)?;
        value.set_item("offset", diagnostic.offset)?;
        value.set_item("details", string_map_to_python(py, &diagnostic.details)?)?;
        diagnostics.append(value)?;
    }
    output.set_item("diagnostics", diagnostics)?;
    Ok(output)
}

fn dwfx_to_python<'py>(py: Python<'py>, package: &DwfxPackage) -> PyResult<Bound<'py, PyDict>> {
    let output = PyDict::new(py);
    output.set_item("format", format_row(&package.format))?;
    let entries = PyList::empty(py);
    for entry in &package.entries {
        let row = PyDict::new(py);
        row.set_item("original_name", &entry.original_name)?;
        row.set_item("normalized_name", &entry.normalized_name)?;
        row.set_item("compressed_size", entry.compressed_size)?;
        row.set_item("uncompressed_size", entry.uncompressed_size)?;
        row.set_item("compression_method", &entry.compression_method)?;
        row.set_item("is_directory", entry.is_directory)?;
        row.set_item("encrypted", entry.encrypted)?;
        entries.append(row)?;
    }
    output.set_item("entries", entries)?;

    let content_types = PyList::empty(py);
    for content_type in &package.content_types {
        let row = PyDict::new(py);
        row.set_item("extension", &content_type.extension)?;
        row.set_item("part_name", &content_type.part_name)?;
        row.set_item("content_type", &content_type.content_type)?;
        content_types.append(row)?;
    }
    output.set_item("content_types", content_types)?;
    output.set_item(
        "relationships",
        relationships_to_python(py, &package.relationships)?,
    )?;
    output.set_item("document_sequence", &package.document_sequence)?;

    let documents = PyList::empty(py);
    for document in &package.documents {
        let row = PyDict::new(py);
        row.set_item("part_name", &document.part_name)?;
        row.set_item(
            "relationships",
            relationships_to_python(py, &document.relationships)?,
        )?;
        let pages = PyList::empty(py);
        for page in &document.pages {
            let page_row = PyDict::new(py);
            page_row.set_item("part_name", &page.part_name)?;
            page_row.set_item("name", &page.name)?;
            page_row.set_item("language", &page.language)?;
            page_row.set_item("width", page.width)?;
            page_row.set_item("height", page.height)?;
            page_row.set_item("content_box", page.content_box.map(Vec::from))?;
            page_row.set_item("bleed_box", page.bleed_box.map(Vec::from))?;
            page_row.set_item("resource_dictionaries", &page.resource_dictionaries)?;
            page_row.set_item(
                "relationships",
                relationships_to_python(py, &page.relationships)?,
            )?;
            page_row.set_item(
                "canvas_groups",
                xps_canvas_groups_to_python(py, &page.entities)?,
            )?;
            let entities = PyList::empty(py);
            for entity in &page.entities {
                entities.append(xps_entity_to_python(py, entity)?)?;
            }
            page_row.set_item("entities", entities)?;
            let diagnostics = PyList::empty(py);
            for diagnostic in &page.diagnostics {
                diagnostics.append(diagnostic_to_python(py, diagnostic)?)?;
            }
            page_row.set_item("diagnostics", diagnostics)?;
            pages.append(page_row)?;
        }
        row.set_item("pages", pages)?;
        documents.append(row)?;
    }
    output.set_item("documents", documents)?;
    let diagnostics = PyList::empty(py);
    for diagnostic in &package.diagnostics {
        diagnostics.append(diagnostic_to_python(py, diagnostic)?)?;
    }
    output.set_item("diagnostics", diagnostics)?;
    Ok(output)
}

fn relationships_to_python<'py>(
    py: Python<'py>,
    relationships: &[ezdwf_core::OpcRelationship],
) -> PyResult<Bound<'py, PyList>> {
    let output = PyList::empty(py);
    for relationship in relationships {
        let row = PyDict::new(py);
        row.set_item("source", &relationship.source)?;
        row.set_item("id", &relationship.id)?;
        row.set_item("relationship_type", &relationship.relationship_type)?;
        row.set_item("target", &relationship.target)?;
        row.set_item("target_mode", &relationship.target_mode)?;
        row.set_item("normalized_target", &relationship.normalized_target)?;
        output.append(row)?;
    }
    Ok(output)
}

fn xps_entity_to_python<'py>(py: Python<'py>, entity: &XpsEntity) -> PyResult<Bound<'py, PyDict>> {
    let output = PyDict::new(py);
    output.set_item("kind", entity.geometry.kind())?;
    output.set_item("name", &entity.name)?;
    output.set_item("canvas_name", &entity.canvas_name)?;
    output.set_item("navigate_uri", &entity.navigate_uri)?;
    output.set_item(
        "transform",
        [
            entity.transform.m11,
            entity.transform.m12,
            entity.transform.m21,
            entity.transform.m22,
            entity.transform.offset_x,
            entity.transform.offset_y,
        ],
    )?;
    output.set_item(
        "clip",
        entity
            .clip
            .as_ref()
            .map(|geometry| xps_path_to_python(py, geometry))
            .transpose()?,
    )?;
    let clip_chain = PyList::empty(py);
    for clip in &entity.clip_chain {
        let row = PyDict::new(py);
        row.set_item("geometry", xps_path_to_python(py, &clip.geometry)?)?;
        row.set_item(
            "transform",
            [
                clip.transform.m11,
                clip.transform.m12,
                clip.transform.m21,
                clip.transform.m22,
                clip.transform.offset_x,
                clip.transform.offset_y,
            ],
        )?;
        clip_chain.append(row)?;
    }
    output.set_item("clip_chain", clip_chain)?;
    output.set_item(
        "opacity_mask",
        entity
            .opacity_mask
            .as_ref()
            .map(|brush| xps_brush_to_python(py, brush))
            .transpose()?,
    )?;
    let opacity_mask_chain = PyList::empty(py);
    for mask in &entity.opacity_mask_chain {
        let row = PyDict::new(py);
        row.set_item("brush", xps_brush_to_python(py, &mask.brush)?)?;
        row.set_item(
            "transform",
            [
                mask.transform.m11,
                mask.transform.m12,
                mask.transform.m21,
                mask.transform.m22,
                mask.transform.offset_x,
                mask.transform.offset_y,
            ],
        )?;
        opacity_mask_chain.append(row)?;
    }
    output.set_item("opacity_mask_chain", opacity_mask_chain)?;
    output.set_item(
        "canvas_group_ids",
        entity
            .canvas_groups
            .iter()
            .map(|group| group.id)
            .collect::<Vec<_>>(),
    )?;
    output.set_item("style", xps_style_to_python(py, &entity.style)?)?;
    match &entity.geometry {
        XpsGeometry::Path { geometry } => {
            output.set_item("path", xps_path_to_python(py, geometry)?)?;
            output.set_item("glyphs", py.None())?;
        }
        XpsGeometry::Glyphs { glyphs } => {
            output.set_item("path", py.None())?;
            let row = PyDict::new(py);
            row.set_item("unicode_string", &glyphs.unicode_string)?;
            row.set_item("origin", (glyphs.origin.x, glyphs.origin.y))?;
            row.set_item("font_uri", &glyphs.font_uri)?;
            row.set_item("font_resource_part", &glyphs.font_resource_part)?;
            row.set_item("normalized_font_uri", &glyphs.normalized_font_uri)?;
            row.set_item("font_rendering_em_size", glyphs.font_rendering_em_size)?;
            row.set_item("indices", &glyphs.indices)?;
            row.set_item("style_simulations", &glyphs.style_simulations)?;
            row.set_item("bidi_level", glyphs.bidi_level)?;
            row.set_item("sideways", glyphs.sideways)?;
            row.set_item("font_part", &glyphs.font_part)?;
            row.set_item("font_content_type", &glyphs.font_content_type)?;
            row.set_item("font_obfuscated", glyphs.font_obfuscated)?;
            row.set_item(
                "outline",
                glyphs
                    .outline
                    .as_ref()
                    .map(|geometry| xps_path_to_python(py, geometry))
                    .transpose()?,
            )?;
            output.set_item("glyphs", row)?;
        }
    }
    let source = PyDict::new(py);
    source.set_item("offset", entity.source.offset)?;
    source.set_item("length", entity.source.length)?;
    source.set_item("element", &entity.source.element)?;
    output.set_item("source", source)?;
    output.set_item("attributes", string_map_to_python(py, &entity.attributes)?)?;
    Ok(output)
}

fn xps_canvas_groups_to_python<'py>(
    py: Python<'py>,
    entities: &[XpsEntity],
) -> PyResult<Bound<'py, PyList>> {
    let mut groups = BTreeMap::new();
    for entity in entities {
        for group in &entity.canvas_groups {
            groups.entry(group.id).or_insert(group);
        }
    }
    let output = PyList::empty(py);
    for group in groups.into_values() {
        let row = PyDict::new(py);
        row.set_item("id", group.id)?;
        row.set_item("name", &group.name)?;
        row.set_item("opacity", group.opacity)?;
        row.set_item("transform", xps_matrix_row(group.transform))?;
        row.set_item(
            "clip",
            group
                .clip
                .as_ref()
                .map(|geometry| xps_path_to_python(py, geometry))
                .transpose()?,
        )?;
        row.set_item(
            "opacity_mask",
            group
                .opacity_mask
                .as_ref()
                .map(|brush| xps_brush_to_python(py, brush))
                .transpose()?,
        )?;
        output.append(row)?;
    }
    Ok(output)
}

fn xps_style_to_python<'py>(
    py: Python<'py>,
    style: &ezdwf_core::XpsStyle,
) -> PyResult<Bound<'py, PyDict>> {
    let output = PyDict::new(py);
    output.set_item(
        "fill",
        style
            .fill
            .as_ref()
            .map(|brush| xps_brush_to_python(py, brush))
            .transpose()?,
    )?;
    output.set_item(
        "stroke",
        style
            .stroke
            .as_ref()
            .map(|brush| xps_brush_to_python(py, brush))
            .transpose()?,
    )?;
    output.set_item("stroke_thickness", style.stroke_thickness)?;
    output.set_item("stroke_dash_array", &style.stroke_dash_array)?;
    output.set_item("stroke_dash_offset", style.stroke_dash_offset)?;
    output.set_item("stroke_start_line_cap", &style.stroke_start_line_cap)?;
    output.set_item("stroke_end_line_cap", &style.stroke_end_line_cap)?;
    output.set_item("stroke_dash_cap", &style.stroke_dash_cap)?;
    output.set_item("stroke_line_join", &style.stroke_line_join)?;
    output.set_item("stroke_miter_limit", style.stroke_miter_limit)?;
    output.set_item("opacity", style.opacity)?;
    Ok(output)
}

fn xps_brush_to_python<'py>(py: Python<'py>, brush: &XpsBrush) -> PyResult<Bound<'py, PyDict>> {
    let output = PyDict::new(py);
    output.set_item("kind", brush.kind())?;
    match brush {
        XpsBrush::Solid {
            color,
            opacity,
            attributes,
        } => {
            output.set_item("color", color.to_vec())?;
            output.set_item("opacity", opacity)?;
            output.set_item("attributes", string_map_to_python(py, attributes)?)?;
        }
        XpsBrush::Image {
            source,
            resource_part,
            normalized_source,
            content_type,
            data,
            image_metadata,
            viewbox,
            viewport,
            viewbox_units,
            viewport_units,
            tile_mode,
            transform,
            opacity,
            attributes,
        } => {
            output.set_item("source", source)?;
            output.set_item("resource_part", resource_part)?;
            output.set_item("normalized_source", normalized_source)?;
            output.set_item("content_type", content_type)?;
            output.set_item("data", PyBytes::new(py, data))?;
            let metadata_value = image_metadata.as_ref().map(|metadata| {
                let row = PyDict::new(py);
                row.set_item("pixel_width", metadata.pixel_width)?;
                row.set_item("pixel_height", metadata.pixel_height)?;
                row.set_item("dpi_x", metadata.dpi_x)?;
                row.set_item("dpi_y", metadata.dpi_y)?;
                Ok::<_, PyErr>(row)
            });
            output.set_item("image_metadata", metadata_value.transpose()?)?;
            output.set_item("viewbox", viewbox.map(Vec::from))?;
            output.set_item("viewport", viewport.map(Vec::from))?;
            output.set_item("viewbox_units", viewbox_units)?;
            output.set_item("viewport_units", viewport_units)?;
            output.set_item("tile_mode", tile_mode)?;
            output.set_item(
                "transform",
                [
                    transform.m11,
                    transform.m12,
                    transform.m21,
                    transform.m22,
                    transform.offset_x,
                    transform.offset_y,
                ],
            )?;
            output.set_item("opacity", opacity)?;
            output.set_item("attributes", string_map_to_python(py, attributes)?)?;
        }
        XpsBrush::Visual {
            visual,
            viewbox,
            viewport,
            viewbox_units,
            viewport_units,
            tile_mode,
            transform,
            opacity,
            attributes,
        } => {
            let entities = PyList::empty(py);
            if let Some(visual) = visual {
                output.set_item(
                    "canvas_groups",
                    xps_canvas_groups_to_python(py, &visual.entities)?,
                )?;
                for entity in &visual.entities {
                    entities.append(xps_entity_to_python(py, entity)?)?;
                }
            } else {
                output.set_item("canvas_groups", PyList::empty(py))?;
            }
            output.set_item("entities", entities)?;
            output.set_item("viewbox", viewbox.to_vec())?;
            output.set_item("viewport", viewport.to_vec())?;
            output.set_item("viewbox_units", viewbox_units)?;
            output.set_item("viewport_units", viewport_units)?;
            output.set_item("tile_mode", tile_mode)?;
            output.set_item("transform", xps_matrix_row(*transform))?;
            output.set_item("opacity", opacity)?;
            output.set_item("attributes", string_map_to_python(py, attributes)?)?;
        }
        XpsBrush::LinearGradient {
            start_point,
            end_point,
            spread_method,
            mapping_mode,
            transform,
            gradient_stops,
            opacity,
            attributes,
        } => {
            output.set_item("start_point", (start_point.x, start_point.y))?;
            output.set_item("end_point", (end_point.x, end_point.y))?;
            output.set_item("spread_method", spread_method)?;
            output.set_item("mapping_mode", mapping_mode)?;
            output.set_item("transform", xps_matrix_row(*transform))?;
            output.set_item(
                "gradient_stops",
                xps_gradient_stops_to_python(py, gradient_stops)?,
            )?;
            output.set_item("opacity", opacity)?;
            output.set_item("attributes", string_map_to_python(py, attributes)?)?;
        }
        XpsBrush::RadialGradient {
            center,
            gradient_origin,
            radius_x,
            radius_y,
            spread_method,
            mapping_mode,
            transform,
            gradient_stops,
            opacity,
            attributes,
        } => {
            output.set_item("center", (center.x, center.y))?;
            output.set_item("gradient_origin", (gradient_origin.x, gradient_origin.y))?;
            output.set_item("radius_x", radius_x)?;
            output.set_item("radius_y", radius_y)?;
            output.set_item("spread_method", spread_method)?;
            output.set_item("mapping_mode", mapping_mode)?;
            output.set_item("transform", xps_matrix_row(*transform))?;
            output.set_item(
                "gradient_stops",
                xps_gradient_stops_to_python(py, gradient_stops)?,
            )?;
            output.set_item("opacity", opacity)?;
            output.set_item("attributes", string_map_to_python(py, attributes)?)?;
        }
        XpsBrush::Unsupported {
            brush_type,
            attributes,
        } => {
            output.set_item("brush_type", brush_type)?;
            output.set_item("attributes", string_map_to_python(py, attributes)?)?;
        }
    }
    Ok(output)
}

fn xps_matrix_row(matrix: ezdwf_core::XpsMatrix) -> [f64; 6] {
    [
        matrix.m11,
        matrix.m12,
        matrix.m21,
        matrix.m22,
        matrix.offset_x,
        matrix.offset_y,
    ]
}

fn xps_gradient_stops_to_python<'py>(
    py: Python<'py>,
    stops: &[ezdwf_core::XpsGradientStop],
) -> PyResult<Bound<'py, PyList>> {
    let output = PyList::empty(py);
    for stop in stops {
        let row = PyDict::new(py);
        row.set_item("color", stop.color.map(Vec::from))?;
        row.set_item("color_value", &stop.color_value)?;
        row.set_item("offset", stop.offset)?;
        output.append(row)?;
    }
    Ok(output)
}

fn xps_path_to_python<'py>(
    py: Python<'py>,
    geometry: &ezdwf_core::XpsPathGeometry,
) -> PyResult<Bound<'py, PyDict>> {
    let output = PyDict::new(py);
    output.set_item("fill_rule", &geometry.fill_rule)?;
    output.set_item("data", &geometry.data)?;
    output.set_item("transform", xps_matrix_row(geometry.transform))?;
    let figures = PyList::empty(py);
    for figure in &geometry.figures {
        let row = PyDict::new(py);
        row.set_item("start", (figure.start.x, figure.start.y))?;
        row.set_item("closed", figure.closed)?;
        row.set_item("filled", figure.filled)?;
        let segments = PyList::empty(py);
        for segment in &figure.segments {
            let segment_row = PyDict::new(py);
            segment_row.set_item("kind", segment.kind())?;
            segment_row.set_item("stroked", segment.stroked())?;
            segment_row.set_item("smooth_join", segment.smooth_join())?;
            match segment {
                XpsPathSegment::Line { end, .. } => {
                    segment_row.set_item("end", (end.x, end.y))?;
                }
                XpsPathSegment::CubicBezier {
                    control1,
                    control2,
                    end,
                    ..
                } => {
                    segment_row.set_item("control1", (control1.x, control1.y))?;
                    segment_row.set_item("control2", (control2.x, control2.y))?;
                    segment_row.set_item("end", (end.x, end.y))?;
                }
                XpsPathSegment::QuadraticBezier { control, end, .. } => {
                    segment_row.set_item("control", (control.x, control.y))?;
                    segment_row.set_item("end", (end.x, end.y))?;
                }
                XpsPathSegment::Arc {
                    radius,
                    rotation_degrees,
                    large_arc,
                    sweep_clockwise,
                    end,
                    ..
                } => {
                    segment_row.set_item("radius", (radius.x, radius.y))?;
                    segment_row.set_item("rotation_degrees", rotation_degrees)?;
                    segment_row.set_item("large_arc", large_arc)?;
                    segment_row.set_item("sweep_clockwise", sweep_clockwise)?;
                    segment_row.set_item("end", (end.x, end.y))?;
                }
            }
            segments.append(segment_row)?;
        }
        row.set_item("segments", segments)?;
        figures.append(row)?;
    }
    output.set_item("figures", figures)?;
    Ok(output)
}

fn w2d_stream_to_python<'py>(py: Python<'py>, stream: &W2dStream) -> PyResult<Bound<'py, PyDict>> {
    w2d_stream_to_python_impl(py, stream, true)
}

/// `include_entities: false` renders the stream SHELL — everything except the
/// per-entity display list, which dominates the dict's size on real plot
/// sets. The streaming read path fetches entities per stream afterwards
/// (`DrawingHandle::stream_entities`) so only one stream's entity dicts are
/// ever alive at once; `entities` is set to `None` (not `[]`) so a consumer
/// can tell "deferred" from "genuinely empty".
fn w2d_stream_to_python_impl<'py>(
    py: Python<'py>,
    stream: &W2dStream,
    include_entities: bool,
) -> PyResult<Bound<'py, PyDict>> {
    let value = PyDict::new(py);
    value.set_item("href", &stream.href)?;
    value.set_item("role", &stream.role)?;
    value.set_item("mime", &stream.mime)?;
    value.set_item("source_format", &stream.source_format)?;
    value.set_item("version", &stream.version)?;
    value.set_item("source_size", stream.source_size)?;
    value.set_item("decompressed_size", stream.decompressed_size)?;
    value.set_item("compressed_blocks", stream.compressed_blocks)?;
    value.set_item("complete", stream.complete)?;
    value.set_item("end_of_dwf_seen", stream.end_of_dwf_seen)?;
    value.set_item("logical_bounds", stream.logical_bounds.map(Vec::from))?;
    value.set_item("transform", &stream.transform)?;
    value.set_item("clip", &stream.clip)?;
    value.set_item(
        "units",
        stream
            .units
            .as_ref()
            .map(|units| w2d_units_to_python(py, units))
            .transpose()?,
    )?;

    let layers = PyList::empty(py);
    for layer in &stream.layers {
        let layer_value = PyDict::new(py);
        layer_value.set_item("number", layer.number)?;
        layer_value.set_item("name", &layer.name)?;
        layers.append(layer_value)?;
    }
    value.set_item("layers", layers)?;

    let viewports = PyList::empty(py);
    for viewport in &stream.viewports {
        let viewport_value = PyDict::new(py);
        viewport_value.set_item("name", &viewport.name)?;
        let contours = PyList::empty(py);
        for contour in &viewport.contours {
            contours.append(
                contour
                    .iter()
                    .map(|point| (point.x, point.y))
                    .collect::<Vec<_>>(),
            )?;
        }
        viewport_value.set_item("contours", contours)?;
        viewport_value.set_item(
            "units",
            viewport
                .units
                .as_ref()
                .map(|units| w2d_units_to_python(py, units))
                .transpose()?,
        )?;
        viewports.append(viewport_value)?;
    }
    value.set_item("viewports", viewports)?;

    value.set_item(
        "color_maps",
        stream
            .color_maps
            .iter()
            .map(|colors| {
                colors
                    .iter()
                    .map(|color| color.to_vec())
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>(),
    )?;

    let embedded_fonts = PyList::empty(py);
    for font in &stream.embedded_fonts {
        let row = PyDict::new(py);
        row.set_item("request", font.request)?;
        row.set_item("privilege", font.privilege)?;
        row.set_item("charset", font.charset)?;
        row.set_item("typeface_name", &font.typeface_name)?;
        row.set_item("logfont_name", &font.logfont_name)?;
        row.set_item("data", PyBytes::new(py, &font.data))?;
        row.set_item("source", source_span_to_python(py, &font.source)?)?;
        embedded_fonts.append(row)?;
    }
    value.set_item("embedded_fonts", embedded_fonts)?;

    let block_refs = PyList::empty(py);
    for block_ref in &stream.block_refs {
        let row = PyDict::new(py);
        row.set_item("format", &block_ref.format)?;
        row.set_item("payload", PyBytes::new(py, &block_ref.payload))?;
        row.set_item("source", source_span_to_python(py, &block_ref.source)?)?;
        block_refs.append(row)?;
    }
    value.set_item("block_refs", block_refs)?;

    if include_entities {
        let entities = PyList::empty(py);
        for entity in &stream.entities {
            entities.append(w2d_entity_to_python(py, entity)?)?;
        }
        value.set_item("entities", entities)?;
    } else {
        value.set_item("entities", py.None())?;
    }

    let diagnostics = PyList::empty(py);
    for diagnostic in &stream.diagnostics {
        diagnostics.append(diagnostic_to_python(py, diagnostic)?)?;
    }
    value.set_item("diagnostics", diagnostics)?;
    Ok(value)
}

fn w2d_units_to_python<'py>(py: Python<'py>, units: &W2dUnits) -> PyResult<Bound<'py, PyDict>> {
    let value = PyDict::new(py);
    value.set_item("name", &units.name)?;
    value.set_item("transform", units.transform.to_vec())?;
    Ok(value)
}

fn w2d_entity_to_python<'py>(py: Python<'py>, entity: &W2dEntity) -> PyResult<Bound<'py, PyDict>> {
    let value = PyDict::new(py);
    value.set_item("kind", entity.geometry.kind())?;
    value.set_item("points", Vec::<(i64, i64)>::new())?;
    value.set_item("center", py.None())?;
    value.set_item("radius", py.None())?;
    value.set_item("major", py.None())?;
    value.set_item("minor", py.None())?;
    value.set_item("start_angle", py.None())?;
    value.set_item("end_angle", py.None())?;
    value.set_item("tilt", py.None())?;
    value.set_item("text", py.None())?;
    value.set_item("bounds", py.None())?;
    value.set_item("colored_points", Vec::<Py<PyAny>>::new())?;
    value.set_item("contours", Vec::<Vec<(i64, i64)>>::new())?;
    value.set_item("image", py.None())?;
    match &entity.geometry {
        W2dGeometry::Line { start, end } => {
            value.set_item("points", vec![(start.x, start.y), (end.x, end.y)])?;
        }
        W2dGeometry::Polyline { points }
        | W2dGeometry::Polymarker { points }
        | W2dGeometry::Polygon { points }
        | W2dGeometry::PolyBezier { points }
        | W2dGeometry::Polytriangle { points }
        | W2dGeometry::TexturedPolytriangle { points } => {
            value.set_item(
                "points",
                points
                    .iter()
                    .map(|point| (point.x, point.y))
                    .collect::<Vec<_>>(),
            )?;
        }
        W2dGeometry::Circle {
            center,
            radius,
            start_angle,
            end_angle,
        } => {
            value.set_item("center", (center.x, center.y))?;
            value.set_item("radius", radius)?;
            value.set_item("start_angle", start_angle)?;
            value.set_item("end_angle", end_angle)?;
        }
        W2dGeometry::Ellipse {
            center,
            major,
            minor,
            start_angle,
            end_angle,
            tilt,
        } => {
            value.set_item("center", (center.x, center.y))?;
            value.set_item("major", major)?;
            value.set_item("minor", minor)?;
            value.set_item("start_angle", start_angle)?;
            value.set_item("end_angle", end_angle)?;
            value.set_item("tilt", tilt)?;
        }
        W2dGeometry::Text {
            position,
            text,
            bounds,
        } => {
            value.set_item("points", vec![(position.x, position.y)])?;
            value.set_item("text", text)?;
            value.set_item(
                "bounds",
                bounds.map(|bounds| {
                    bounds
                        .iter()
                        .map(|point| (point.x, point.y))
                        .collect::<Vec<_>>()
                }),
            )?;
        }
        W2dGeometry::GouraudPolyline { points } | W2dGeometry::GouraudPolytriangle { points } => {
            value.set_item(
                "points",
                points
                    .iter()
                    .map(|item| (item.point.x, item.point.y))
                    .collect::<Vec<_>>(),
            )?;
            let colored = PyList::empty(py);
            for item in points {
                let row = PyDict::new(py);
                row.set_item("point", (item.point.x, item.point.y))?;
                row.set_item("color", item.color.to_vec())?;
                colored.append(row)?;
            }
            value.set_item("colored_points", colored)?;
        }
        W2dGeometry::ContourSet { contours } => {
            value.set_item(
                "contours",
                contours
                    .iter()
                    .map(|points| {
                        points
                            .iter()
                            .map(|point| (point.x, point.y))
                            .collect::<Vec<_>>()
                    })
                    .collect::<Vec<_>>(),
            )?;
        }
        W2dGeometry::Image { image } => {
            let row = PyDict::new(py);
            row.set_item("format", &image.format)?;
            row.set_item("identifier", image.identifier)?;
            row.set_item("columns", image.columns)?;
            row.set_item("rows", image.rows)?;
            row.set_item("min", (image.min.x, image.min.y))?;
            row.set_item("max", (image.max.x, image.max.y))?;
            row.set_item(
                "color_map",
                image
                    .color_map
                    .iter()
                    .map(|color| color.to_vec())
                    .collect::<Vec<_>>(),
            )?;
            row.set_item("data", PyBytes::new(py, &image.data))?;
            value.set_item("image", row)?;
        }
    }
    value.set_item("rendition", w2d_rendition_to_python(py, &entity.rendition)?)?;
    value.set_item("source", source_span_to_python(py, &entity.source)?)?;
    Ok(value)
}

fn source_span_to_python<'py>(
    py: Python<'py>,
    source: &ezdwf_core::W2dSourceSpan,
) -> PyResult<Bound<'py, PyDict>> {
    let value = PyDict::new(py);
    value.set_item("offset", source.offset)?;
    value.set_item("length", source.length)?;
    value.set_item("opcode", &source.opcode)?;
    value.set_item("decoded_offset", source.decoded_offset)?;
    value.set_item("decoded_length", source.decoded_length)?;
    value.set_item("compression_depth", source.compression_depth)?;
    Ok(value)
}

fn w2d_rendition_to_python<'py>(
    py: Python<'py>,
    rendition: &W2dRendition,
) -> PyResult<Bound<'py, PyDict>> {
    let value = PyDict::new(py);
    value.set_item("color", rendition.color.map(Vec::from))?;
    value.set_item("color_index", rendition.color_index)?;
    if let Some(layer) = &rendition.layer {
        let layer_value = PyDict::new(py);
        layer_value.set_item("number", layer.number)?;
        layer_value.set_item("name", &layer.name)?;
        value.set_item("layer", layer_value)?;
    } else {
        value.set_item("layer", py.None())?;
    }
    let line = PyDict::new(py);
    line.set_item("pattern", &rendition.line.pattern)?;
    line.set_item("weight", rendition.line.weight)?;
    line.set_item("adapt_patterns", rendition.line.adapt_patterns)?;
    line.set_item("pattern_scale", rendition.line.pattern_scale)?;
    line.set_item("line_start_cap", &rendition.line.line_start_cap)?;
    line.set_item("line_end_cap", &rendition.line.line_end_cap)?;
    line.set_item("dash_start_cap", &rendition.line.dash_start_cap)?;
    line.set_item("dash_end_cap", &rendition.line.dash_end_cap)?;
    line.set_item("line_join", &rendition.line.line_join)?;
    line.set_item("miter_angle", rendition.line.miter_angle)?;
    line.set_item("miter_length", rendition.line.miter_length)?;
    value.set_item("line", line)?;
    value.set_item("fill", rendition.fill)?;
    value.set_item("fill_pattern", &rendition.fill_pattern)?;

    let font = PyDict::new(py);
    font.set_item("name", &rendition.font.name)?;
    font.set_item("canonical_name", &rendition.font.canonical_name)?;
    font.set_item("charset", rendition.font.charset)?;
    font.set_item("pitch", rendition.font.pitch)?;
    font.set_item("family", rendition.font.family)?;
    font.set_item("bold", rendition.font.bold)?;
    font.set_item("italic", rendition.font.italic)?;
    font.set_item("underlined", rendition.font.underlined)?;
    font.set_item("height", rendition.font.height)?;
    font.set_item("rotation", rendition.font.rotation)?;
    font.set_item("width_scale", rendition.font.width_scale)?;
    font.set_item("spacing", rendition.font.spacing)?;
    font.set_item("oblique", rendition.font.oblique)?;
    font.set_item("flags", rendition.font.flags)?;
    value.set_item("font", font)?;
    value.set_item("visibility", rendition.visibility)?;
    value.set_item("viewport", &rendition.viewport)?;
    Ok(value)
}

fn diagnostic_to_python<'py>(
    py: Python<'py>,
    diagnostic: &ezdwf_core::Diagnostic,
) -> PyResult<Bound<'py, PyDict>> {
    let value = PyDict::new(py);
    value.set_item("code", &diagnostic.code)?;
    value.set_item("severity", diagnostic.severity.to_string())?;
    value.set_item("message", &diagnostic.message)?;
    value.set_item("action", &diagnostic.action)?;
    value.set_item("section", &diagnostic.section)?;
    value.set_item("resource", &diagnostic.resource)?;
    value.set_item("offset", diagnostic.offset)?;
    value.set_item("details", string_map_to_python(py, &diagnostic.details)?)?;
    Ok(value)
}

fn page_to_python<'py>(py: Python<'py>, page: &EPlotPage) -> PyResult<Bound<'py, PyDict>> {
    let value = PyDict::new(py);
    value.set_item("version", &page.version)?;
    value.set_item("name", &page.name)?;
    value.set_item("object_id", &page.object_id)?;
    value.set_item("plot_order", page.plot_order)?;
    value.set_item("color", page.color.map(Vec::from))?;
    if let Some(paper) = &page.paper {
        let paper_value = PyDict::new(py);
        paper_value.set_item("show", paper.show)?;
        paper_value.set_item("units", &paper.units)?;
        paper_value.set_item("width", paper.width)?;
        paper_value.set_item("height", paper.height)?;
        paper_value.set_item("clip", &paper.clip)?;
        paper_value.set_item("color", paper.color.map(Vec::from))?;
        value.set_item("paper", paper_value)?;
    } else {
        value.set_item("paper", py.None())?;
    }
    value.set_item("properties", properties_to_python(py, &page.properties)?)?;

    let resources = PyList::empty(py);
    for resource in &page.resources {
        let resource_value = PyDict::new(py);
        resource_value.set_item("kind", &resource.kind)?;
        resource_value.set_item("role", &resource.role)?;
        resource_value.set_item("mime", &resource.mime)?;
        resource_value.set_item("href", &resource.href)?;
        resource_value.set_item("normalized_href", &resource.normalized_href)?;
        resource_value.set_item("title", &resource.title)?;
        resource_value.set_item("size", resource.size)?;
        resource_value.set_item("object_id", &resource.object_id)?;
        resource_value.set_item("parent_object_id", &resource.parent_object_id)?;
        resource_value.set_item("transform", &resource.transform)?;
        resource_value.set_item("clip", &resource.clip)?;
        resource_value.set_item("extents", &resource.extents)?;
        resource_value.set_item(
            "attributes",
            string_map_to_python(py, &resource.attributes)?,
        )?;
        resources.append(resource_value)?;
    }
    value.set_item("resources", resources)?;
    Ok(value)
}

fn properties_to_python<'py>(
    py: Python<'py>,
    properties: &[ezdwf_core::DwfProperty],
) -> PyResult<Bound<'py, PyList>> {
    let output = PyList::empty(py);
    for property in properties {
        let value = PyDict::new(py);
        value.set_item("name", &property.name)?;
        value.set_item("category", &property.category)?;
        value.set_item("value", &property.value)?;
        value.set_item("value_type", &property.value_type)?;
        output.append(value)?;
    }
    Ok(output)
}

fn string_map_to_python<'py>(
    py: Python<'py>,
    values: &BTreeMap<String, String>,
) -> PyResult<Bound<'py, PyDict>> {
    let output = PyDict::new(py);
    for (key, value) in values {
        output.set_item(key, value)?;
    }
    Ok(output)
}

fn core_error_to_python(error: CoreDwfError) -> PyErr {
    let message = error.to_string();
    if error.is_unsupported_error() {
        UnsupportedDwfError::new_err(message)
    } else if error.is_limit_error() {
        DwfLimitError::new_err(message)
    } else {
        InvalidDwfError::new_err(message)
    }
}

#[pymodule]
fn _core(module: &Bound<'_, PyModule>) -> PyResult<()> {
    let py = module.py();
    module.add(
        "DEFAULT_MAX_FILE_SIZE_BYTES",
        ezdwf_core::DEFAULT_MAX_FILE_SIZE_BYTES,
    )?;
    module.add(
        "DEFAULT_MAX_ARCHIVE_ENTRIES",
        ezdwf_core::DEFAULT_MAX_ARCHIVE_ENTRIES,
    )?;
    module.add(
        "DEFAULT_MAX_ENTRY_SIZE_BYTES",
        ezdwf_core::DEFAULT_MAX_ENTRY_SIZE_BYTES,
    )?;
    module.add(
        "DEFAULT_MAX_TOTAL_UNCOMPRESSED_SIZE_BYTES",
        ezdwf_core::DEFAULT_MAX_TOTAL_UNCOMPRESSED_SIZE_BYTES,
    )?;
    module.add(
        "DEFAULT_MAX_COMPRESSION_RATIO",
        ezdwf_core::DEFAULT_MAX_COMPRESSION_RATIO,
    )?;
    module.add(
        "DEFAULT_MAX_XML_SIZE_BYTES",
        ezdwf_core::DEFAULT_MAX_XML_SIZE_BYTES,
    )?;
    module.add("DEFAULT_MAX_XML_DEPTH", ezdwf_core::DEFAULT_MAX_XML_DEPTH)?;
    module.add(
        "DEFAULT_MAX_W2D_RECORDS",
        ezdwf_core::DEFAULT_MAX_W2D_RECORDS,
    )?;
    module.add(
        "DEFAULT_MAX_W2D_POINTS_PER_ENTITY",
        ezdwf_core::DEFAULT_MAX_W2D_POINTS_PER_ENTITY,
    )?;
    module.add(
        "DEFAULT_MAX_W2D_TOTAL_POINTS",
        ezdwf_core::DEFAULT_MAX_W2D_TOTAL_POINTS,
    )?;
    module.add(
        "DEFAULT_MAX_W2D_STRING_SIZE_BYTES",
        ezdwf_core::DEFAULT_MAX_W2D_STRING_SIZE_BYTES,
    )?;
    module.add(
        "DEFAULT_MAX_W2D_NESTING_DEPTH",
        ezdwf_core::DEFAULT_MAX_W2D_NESTING_DEPTH,
    )?;
    module.add(
        "DEFAULT_MAX_W2D_DECOMPRESSED_SIZE_BYTES",
        ezdwf_core::DEFAULT_MAX_W2D_DECOMPRESSED_SIZE_BYTES,
    )?;
    module.add(
        "DEFAULT_MAX_W2D_COMPRESSION_DEPTH",
        ezdwf_core::DEFAULT_MAX_W2D_COMPRESSION_DEPTH,
    )?;
    module.add(
        "DEFAULT_MAX_XPS_VISUALS",
        ezdwf_core::DEFAULT_MAX_XPS_VISUALS,
    )?;
    module.add(
        "DEFAULT_MAX_XPS_PATH_SEGMENTS",
        ezdwf_core::DEFAULT_MAX_XPS_PATH_SEGMENTS,
    )?;
    module.add("DwfError", py.get_type::<DwfError>())?;
    module.add("InvalidDwfError", py.get_type::<InvalidDwfError>())?;
    module.add("UnsupportedDwfError", py.get_type::<UnsupportedDwfError>())?;
    module.add("DwfLimitError", py.get_type::<DwfLimitError>())?;
    module.add_function(wrap_pyfunction!(core_version, module)?)?;
    module.add_function(wrap_pyfunction!(detect_format_bytes, module)?)?;
    module.add_function(wrap_pyfunction!(inspect_package_bytes, module)?)?;
    module.add_function(wrap_pyfunction!(inspect_dwfx_bytes, module)?)?;
    module.add_function(wrap_pyfunction!(read_drawing_bytes, module)?)?;
    module.add_function(wrap_pyfunction!(read_drawing_handle, module)?)?;
    module.add_class::<DrawingHandle>()?;
    module.add_function(wrap_pyfunction!(decode_w2d_bytes, module)?)?;
    Ok(())
}
