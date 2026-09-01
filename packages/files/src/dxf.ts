/**
 * AutoCAD DXF — the interchange twin of DWG. This module is deliberately a
 * re-export: a DXF takes the SAME single media-sidecar exchange as a DWG
 * (`POST /dwg/render`, whose worker sniffs the bytes and reads a DXF
 * natively with ezdxf, converter "none"), the same content-hash memo, the
 * same digest/workbook/image shapes, and the same failure honesty. All of
 * that lives in ./dwg.ts as one code path; this file exists so callers
 * import `@mantle/files/dxf` in the same pattern as `/dwf` and `/dwg`.
 */
export {
  sniffDxf,
  parseDxf,
  parseDxfToGrids,
  extractDxfImages,
  explainDxfImageMiss,
  type DwgGrids,
} from './dwg';
