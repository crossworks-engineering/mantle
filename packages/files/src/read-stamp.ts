/**
 * What read a file, and whether a newer one is there now (docs/files.md,
 * "Reindex and stale indexes"). Two stamps on a file node's data, written
 * by the brain only:
 *
 *  - `read_by` { reader, v }: a read of the file's text completed. `reader`
 *    is the core reader of its type (the parser route, or `image` for a
 *    picture read by vision); `v` is that reader's version then.
 *  - `pipeline_read` { id, name, version }: a Reader pipeline built the
 *    file's database (or gave its text with no tabs).
 *
 * A file is stale when a stamp is below the version in force: the reader's
 * number in READER_VERSIONS, or the version of the installed pipeline. A
 * file with no stamp (read before the stamps, or never read) is NOT stale:
 * unknown. So nothing turns stale by itself on a roll; a developer raises a
 * number here when a reader gets better, and the files it read before show
 * as stale. Nothing reads them again by itself: a person reindexes them.
 *
 * Pure, with no imports but pure helpers: the lists, the tree, the tools
 * and the tests share it.
 */
import { versionBelow } from './pipelines/builtin';
import { isVisionImage, mimeForExt, parserRouteForExt, type ParserRoute } from './slug';

/** The reader of a file's text: the parser route of its type, or `image`
 *  for a picture the vision worker reads. */
export type ReaderKey = ParserRoute | 'image';

/**
 * The version of each reader in force. Raise a number when a reader reads
 * better (more text, a fixed layout, a new part of the format): every file
 * it read at a lower number shows as stale, and a person can read it again.
 * Never lower a number. Every key starts at 1.
 */
export const READER_VERSIONS: Readonly<Record<ReaderKey, number>> = {
  'pdf-parse': 1,
  mammoth: 1,
  pptx: 1,
  exceljs: 1,
  'legacy-sheet': 1,
  anydoc: 1,
  markup: 1,
  vsdx: 1,
  utf8: 1,
  dwf: 1,
  dwg: 1,
  dxf: 1,
  dgn: 1,
  none: 1,
  image: 1,
};

export type ReadByStamp = { reader: string; v: number };
export type PipelineReadStamp = { id: string; name: string; version: string };

/** The reader of a file of this name and MIME type, as the extract picks
 *  it (load-body.ts): a vision image, else the parser route. */
export function readerKeyOf(filename: string, mime?: string | null): ReaderKey {
  const dot = filename.lastIndexOf('.');
  const ext = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
  if (isVisionImage(ext, typeof mime === 'string' && mime ? mime : mimeForExt(ext))) {
    return 'image';
  }
  return parserRouteForExt(ext);
}

/** The `read_by` stamp a completed read of this file writes now. */
export function readByStampOf(data: Readonly<Record<string, unknown>>, title: string): ReadByStamp {
  const filename = typeof data.filename === 'string' ? data.filename : title;
  const mime = typeof data.mimeType === 'string' ? data.mimeType : null;
  const reader = readerKeyOf(filename, mime);
  return { reader, v: READER_VERSIONS[reader] };
}

/** The `read_by` stamp in a node's data, or undefined (none, or not of
 *  the stamp's form). */
export function readByOf(data: Readonly<Record<string, unknown>>): ReadByStamp | undefined {
  const s = data.read_by as { reader?: unknown; v?: unknown } | null | undefined;
  if (!s || typeof s !== 'object') return undefined;
  return typeof s.reader === 'string' && typeof s.v === 'number'
    ? { reader: s.reader, v: s.v }
    : undefined;
}

/** The `pipeline_read` stamp in a node's data, or undefined. */
export function pipelineReadStampOf(
  data: Readonly<Record<string, unknown>>,
): PipelineReadStamp | undefined {
  const s = data.pipeline_read as
    { id?: unknown; name?: unknown; version?: unknown } | null | undefined;
  if (!s || typeof s !== 'object') return undefined;
  return typeof s.id === 'string' && typeof s.version === 'string'
    ? { id: s.id, name: typeof s.name === 'string' ? s.name : s.id, version: s.version }
    : undefined;
}

/** Both stamps of a node's data, each only when there: what a file row
 *  carries (fileRowFromNode) for its status. */
export function readStampsOf(data: Readonly<Record<string, unknown>>): {
  readBy?: ReadByStamp;
  pipelineRead?: PipelineReadStamp;
} {
  const readBy = readByOf(data);
  const pipelineRead = pipelineReadStampOf(data);
  return { ...(readBy ? { readBy } : {}), ...(pipelineRead ? { pipelineRead } : {}) };
}

/** The version of a reader in force, or null for a key this code does not
 *  know (a reader that left). */
export function currentReaderVersion(reader: string): number | null {
  return Object.hasOwn(READER_VERSIONS, reader) ? READER_VERSIONS[reader as ReaderKey] : null;
}

/** An installed pipeline as the stale rule reads it: its version, and the
 *  workspaces where it is off (pipeline_state.off_in). A file homed where
 *  its Reader is off gets no Reader run, so a reindex could never make its
 *  pipeline stamp current: there the stamp decides nothing. */
export type InstalledPipeline = { id: string; version: string; offIn?: readonly string[] };

/** The installed pipelines by id, for the stale rule. */
export type PipelineVersions = ReadonlyMap<string, { version: string; offIn?: readonly string[] }>;

/** The map of staleOf from a list of installed pipelines. */
export function pipelineVersionsOf(installed: readonly InstalledPipeline[]): PipelineVersions {
  return new Map(installed.map((p) => [p.id, { version: p.version, offIn: p.offIn }]));
}

/** Whether any installed pipeline is off somewhere: only then does the
 *  stale rule need a file's home. */
export function anyPipelineOff(installed: readonly InstalledPipeline[]): boolean {
  return installed.some((p) => (p.offIn?.length ?? 0) > 0);
}

/**
 * Whether a file's stamps are stale: true when a stamp is below the version
 * in force, false when every stamp it has is current, null when it has no
 * stamp at all (unknown). A reader this code no longer knows, or a pipeline
 * not installed now, decides nothing; nor does a pipeline that is off in the
 * file's `home` workspace (no Reader run would follow a reindex there).
 * Without `pipelines` the pipeline stamp decides nothing.
 */
export function staleOf(
  stamps: { readBy?: ReadByStamp; pipelineRead?: PipelineReadStamp; home?: string | null },
  pipelines?: PipelineVersions,
): boolean | null {
  if (!stamps.readBy && !stamps.pipelineRead) return null;
  if (stamps.readBy) {
    const cur = currentReaderVersion(stamps.readBy.reader);
    if (cur !== null && stamps.readBy.v < cur) return true;
  }
  if (stamps.pipelineRead && pipelines) {
    const cur = pipelines.get(stamps.pipelineRead.id);
    const off = !!stamps.home && (cur?.offIn?.includes(stamps.home) ?? false);
    if (cur && !off && versionBelow(stamps.pipelineRead.version, cur.version)) return true;
  }
  return false;
}
