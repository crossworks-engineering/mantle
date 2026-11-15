/**
 * AutoCAD DWG/DXF and MicroStation DGN, on the brain's side: the one run of
 * the package `drawing-cad` for a drawing (./pipelines/pkg/drawing-cad), kept
 * for the extract, and what the passes take from it.
 *
 * The step reads a drawing in ONE parser job (`pipelineRun`): the CAD tier
 * runs once, and the step gives the tabs, the description, the text digest
 * and the picture in one write call (docs/pipelines.md, "The CAD reader as a package"). The
 * three passes of the extract (the database, ../content file-database.ts;
 * the text, ./parse.ts; the picture, ./embedded-images.ts) and the readings
 * of dwg-reindex all take the SAME run result from the one memo of a
 * Reader's run (./reader-memo.ts), so a drawing costs one heavy job however
 * many passes run.
 *
 * Failure honesty: a failed run throws the parser client's typed
 * ParserError, so the extract records a real error (retried, or terminal on
 * the second counted failure for the same bytes): silently indexing a
 * filename would poison retrieval. The only '' text and the only [] picture
 * with no run is a sniff miss (not that format's bytes, ./cad-sniff.ts),
 * which takes the extractor's hollow-skip carve-out like a renamed DWFx does
 * on the dwf route.
 */
import { createHash } from 'node:crypto';
import { envNum } from '@mantle/config';
import { sniffCad, sniffDgn, sniffDwg } from './cad-sniff';
import { describeImageBytes, type EmbeddedImage } from './embedded-images';
import { asResult, ParserError, parserPipelineRun, type ParserResult } from './parser-client';
import {
  FILE_TABS_WRITE,
  PIPELINE_API,
  type FileTabsWriteInput,
  type PipelineManifest,
  type PipelineStepRequest,
} from './pipelines/contract';
import { BUILTIN_PIPELINES } from './pipelines/builtin';
import { keptReaderRun, memoReaderRun, readerRunFailure, readerRunKey } from './reader-memo';
import { CAD_FTS_SKIP_COLUMNS } from './pipelines/pkg/drawing-cad/cad';
import { CAD_PICTURE } from './pipelines/pkg/drawing-cad/step';
import type { CadExt } from './slug';
import { DWG_ANSWERS_KEY, DWG_VERIFY_RUNS_KEY } from './dwg-keys';

export { DWG_ANSWERS_KEY, DWG_VERIFY_RUNS_KEY };
export { sniffCad, sniffDgn, sniffDwg, sniffDxf } from './cad-sniff';
export { CAD_FTS_SKIP_COLUMNS };

/** `data` without the image check's bookkeeping: a reader that hands `data`
 *  to a model leaves it out, as a drawing's answers can add 256 KB. */
export function withoutDwgAnswers<T extends object>(data: T): T {
  const {
    [DWG_ANSWERS_KEY]: _a,
    [DWG_VERIFY_RUNS_KEY]: _r,
    ...rest
  } = data as Record<string, unknown>;
  return rest as T;
}

/** The tab the image check used to add to a drawing's table. Nothing reads
 *  it as answers now (DWG_ANSWERS_KEY); dwg-reindex's table mode keeps a tab
 *  by this name through a rebuild, as it keeps any person's data, and its
 *  `--count` leaves it out. */
export const DWG_CHECKS_TAB = 'Checks';
/** Table node data key: the version an image-check commit made on a table
 *  that was unedited before it, so dwg-reindex does not count it an edit. */
export const DWG_CHECKED_VERSION_KEY = 'dwgCheckedVersion';
/** Table node data key: the table version the last dwg-reindex committed. */
export const DWG_REINDEXED_VERSION_KEY = 'dwgReindexedVersion';
/** Table node data key: the sha256 of the drawing bytes the table's tabs
 *  were built from (the import, then each dwg-reindex). The image check
 *  files its answers under this revision, and refuses a sheet whose file
 *  now holds other bytes (replaced in place) until it is re-indexed. */
export const DWG_SOURCE_SHA_KEY = 'sourceSha256';

/** The maintenance command that builds one drawing's database from its file's
 *  bytes now (the task's default mode, no model pass), quoted as a tool result
 *  shows it. */
export function dwgReindexCommand(fileId: string | null): string {
  return `\`pnpm maintain dwg-reindex --file=${fileId ?? '<file id>'} --again --apply\``;
}

/** The sha256 of a drawing's bytes, as DWG_SOURCE_SHA_KEY holds it. */
export function dwgSourceSha(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Whether a drawing's table was edited by someone since its import, its
 *  last re-index or its last image-check commit (neither of which is an
 *  edit): its version moved past all three. The one rule dwg-reindex and
 *  the image check's store both read. */
export function dwgTableEdited(t: {
  version: number;
  reindexedVersion: number | null;
  checkedVersion?: number | null;
}): boolean {
  return t.version > Math.max(t.reindexedVersion ?? 1, t.checkedVersion ?? 0);
}

/** Env dial for render sharpness, mirroring DWF_RENDER_DPI (docs there).
 *  One dial for DWG, DXF and DGN: the same CAD tier, the same rasteriser.
 *  The brain reads it and sends it to the step as the option `dpi`.
 *
 *  `raw <= 0` is UNSET, not "smallest allowed". The compose env anchor passes
 *  `DWG_RENDER_DPI: ${DWG_RENDER_DPI:-}`, so an operator who never sets the
 *  dial hands this function the EMPTY STRING, and `Number('')` is 0, which is
 *  finite. Without the `<= 0` arm (the guard ./dwf-images.ts has too) that 0 would
 *  clamp up to the 50 floor instead of falling back to 300, and every DWG on
 *  every default box would render at 50 dpi: an 800×500 smudge of a P&ID,
 *  small enough (~1 KB) that the embedded-image gate drops it as
 *  `too_few_bytes` and the drawing gets no picture at all. */
export function dwgRenderDpi(): number {
  return envNum('DWG_RENDER_DPI');
}

/** The end of one run of the step: its write, its picture's bytes, its
 *  facts (`counts`) and its one warning (a render that failed). */
export type CadRun = {
  write: FileTabsWriteInput;
  pictures: ReadonlyMap<string, Buffer>;
  warnings: readonly string[];
  counts: Readonly<Record<string, number>>;
};

/**
 * One run of the step per drawing per process, in the one memo of a
 * Reader's run (./reader-memo.ts): keyed by the content hash, the
 * extension and whether the run is for a Table, kept for the extract, and a
 * failure kept for the rest of the extract it failed in.
 */
function memoKey(bytes: Buffer, ext: CadExt, symbols: boolean): string {
  return readerRunKey(cadPipeline(), dwgSourceSha(bytes), ext, symbols ? '' : 'table');
}

/** The CAD reader, for the id and version of its job. The image's own
 *  built-in, read here and not from the registry: a built-in always wins
 *  its id and its extensions (docs/pipelines.md, "The registry"), and this
 *  memo also serves the text pass, which has no box in hand. */
function cadPipeline(): PipelineManifest {
  return BUILTIN_PIPELINES.find((p) => p.id === 'drawing-cad')!;
}

/** The step's one job, as the runner sends it (packages/content
 *  pipeline-runner.ts): one step, model-free, the dial as an option. */
async function runStep(bytes: Buffer, ext: CadExt, symbols: boolean): Promise<CadRun> {
  const request: PipelineStepRequest = {
    api: PIPELINE_API,
    step: 1,
    file: { name: `file.${ext}`, ext, size: bytes.length, sha256: dwgSourceSha(bytes) },
    options: { dpi: dwgRenderDpi(), ...(symbols ? {} : { symbols: false }) },
    asks: false,
  };
  const { result, pictures } = await parserPipelineRun(bytes, cadPipeline(), request);
  const write = (result.calls ?? []).find((c) => c.call === 'tool' && c.tool === FILE_TABS_WRITE);
  // The step ends `ok` with its write, or the job failed before here.
  if (result.status !== 'ok' || !write || write.call !== 'tool') {
    throw new ParserError('failed', `drawing-cad ended with the status ${result.status}`, {
      retryable: false,
      terminal: false,
    });
  }
  return {
    write: write.input as FileTabsWriteInput,
    pictures,
    warnings: result.warnings ?? [],
    counts: result.counts ?? {},
  };
}

function fetchCadRun(bytes: Buffer, ext: CadExt, symbols = true): Promise<ParserResult<CadRun>> {
  return asResult(() =>
    memoReaderRun(memoKey(bytes, ext, symbols), () => runStep(bytes, ext, symbols)),
  );
}

/** The format's name, for the words of a failure. */
const formatOf = (ext: CadExt) => ext.toUpperCase();

/**
 * The run of a drawing for its database, its text and its readings: the
 * memoised one. A sniff miss is the caller's (no run here). Throws the
 * parser's typed error on a failed run.
 */
export async function cadRun(bytes: Buffer, ext: CadExt, opts: { symbols?: boolean } = {}) {
  const res = await fetchCadRun(bytes, ext, opts.symbols !== false);
  if (!res.ok) {
    throw new ParserError(
      res.code,
      `${formatOf(ext)} extraction failed (${res.code}): ${res.message}`,
      { retryable: res.retryable, terminal: res.terminal },
    );
  }
  return res.value;
}

/** The write of a file that is not the format its extension names: no
 *  tabs, as the old path gave. The core answers it before any job
 *  (parseFileSheets), and so does the step. */
export function cadSniffMiss(bytes: Buffer): FileTabsWriteInput {
  return { tabs: [], sourceSha256: dwgSourceSha(bytes), ftsSkipColumns: CAD_FTS_SKIP_COLUMNS };
}

/**
 * The tabs and the description of a drawing's Table (dwg-reindex --table):
 * the registry and the bones, with no Symbols, Placements or Shapes (they
 * belong in the file's database alone). No tabs when the bytes are not
 * that format.
 */
export async function cadTableWorkbook(
  bytes: Buffer,
  ext: CadExt,
): Promise<{ sheets: FileTabsWriteInput['tabs']; description: string | undefined }> {
  if (!sniffCad(bytes, ext)) return { sheets: [], description: undefined };
  const { write } = await cadRun(bytes, ext, { symbols: false });
  return { sheets: write.tabs, description: write.description };
}

/** How the parser reads a DGN, for `dwg-reindex --dgn-data`:
 *  - `data`: with the data reader (its `dgn` record holds `shared_cells`);
 *  - `data-error`: with the data reader, but the data part failed on this
 *    file, so it read the file the 0.3.2 way and said so (`data_error`);
 *  - `v7`: a V7 file, which holds none of the data the reader adds;
 *  - `not-dgn`: the bytes are not a DGN (the sniff), and no parser call;
 *  - `old-reader`: any other reply. A V8 file read with no data is what an
 *    image with ezdgn 0.3.2 gives, and so is a reply with no `dgn` record.
 *  It shares the memoised run with the database pass, so asking first costs
 *  no second job. A failed read throws the ParserError the database pass
 *  would. */
export type DgnReading = 'data' | 'data-error' | 'v7' | 'not-dgn' | 'old-reader';

export async function dgnReading(bytes: Buffer): Promise<DgnReading> {
  if (!sniffDgn(bytes)) return 'not-dgn';
  const c = (await cadRun(bytes, 'dgn')).counts;
  if (c.dgn_data_reader) return 'data';
  if (c.dgn_data_error) return 'data-error';
  return c.dgn_v7 ? 'v7' : 'old-reader';
}

/** How the parser reads a DWG, for `dwg-reindex --dwg-reader`:
 *  - `data`: with the ezdwg reader (its reply holds the `dwg` record, which
 *    only that reader sends: converter `ezdwg` alone is no proof, as an older
 *    image named its fallback converter `ezdwg` too);
 *  - `not-dwg`: the bytes are not a DWG (the sniff), and no parser call;
 *  - `old-reader`: any other reply, as an image before the reader gives.
 *  It shares the memoised run with the database pass. A failed read throws
 *  the ParserError the database pass would. */
export type DwgReading = 'data' | 'not-dwg' | 'old-reader';

export async function dwgReading(bytes: Buffer): Promise<DwgReading> {
  if (!sniffDwg(bytes)) return 'not-dwg';
  return (await cadRun(bytes, 'dwg')).counts.dwg ? 'data' : 'old-reader';
}

/** How the parser reads a drawing's symbols, for `dwg-reindex --symbols`:
 *  - `data`: its reply holds `symbols` (empty for a drawing with no INSERT);
 *  - `not-cad`: the bytes are not the extension's format (the sniff), and no
 *    parser call;
 *  - `old-reader`: a reply with no `symbols`, as an image before the
 *    symbols pass gives.
 *  It shares the memoised run with the database pass. A failed read throws
 *  the ParserError the database pass would. */
export type SymbolsReading = 'data' | 'not-cad' | 'old-reader';

export async function symbolsReading(bytes: Buffer, ext: CadExt): Promise<SymbolsReading> {
  if (!sniffCad(bytes, ext)) return 'not-cad';
  return (await cadRun(bytes, ext)).counts.symbols ? 'data' : 'old-reader';
}

/**
 * The indexable text digest of a CAD file by its extension. Returns '' only
 * on a sniff miss (the hollow skip); throws when the run fails, so the node
 * shows an honest extract error instead of junk.
 */
export async function parseCadFile(bytes: Buffer, ext: CadExt): Promise<string> {
  if (!sniffCad(bytes, ext)) return '';
  return (await cadRun(bytes, ext)).write.text ?? '';
}

/**
 * Why {@link extractCadFileImages} came back empty for these bytes, answered
 * from the memos alone: NEVER a fresh job (this runs after the image pass on
 * the same bytes, so retrying here would double a failed job). Feeds the
 * extractor's zero-candidate `extract_images` trace step.
 */
export async function explainCadFileImageMiss(bytes: Buffer, ext: CadExt): Promise<string> {
  const format = formatOf(ext);
  if (!sniffCad(bytes, ext)) return `not ${format} bytes (sniff miss)`;
  const key = memoKey(bytes, ext, true);
  const kept = keptReaderRun<CadRun>(key);
  if (kept) {
    // Settled by the time this runs (the image pass awaited the same promise).
    const res = await asResult(() => kept);
    if (res.ok) {
      if (res.value.warnings[0]) return `CAD render failed: ${res.value.warnings[0]}`;
      if (!res.value.pictures.get(CAD_PICTURE)) {
        return 'the CAD tier shipped the registry but no render and no reason';
      }
      return 'a render exists for these bytes (not a miss)';
    }
  }
  const failure = readerRunFailure(key);
  if (failure) return `parser exchange failed (${failure})`;
  return 'no parser exchange was recorded for these bytes';
}

/**
 * The model-space picture of a CAD file, as a single essential image node.
 * Unlike DWF there is no thumbnail fallback tier inside the file: a failed
 * render yields [] and the file simply has no image child: the honest
 * outcome, and the extract-images trace records the reason upstream.
 */
export async function extractCadFileImages(bytes: Buffer, ext: CadExt): Promise<EmbeddedImage[]> {
  if (!sniffCad(bytes, ext)) return [];
  const res = await fetchCadRun(bytes, ext);
  // The parser busy or restarting: the extract retries, rather than
  // completing a drawing with no picture.
  if (!res.ok && (res.code === 'busy' || res.code === 'unavailable')) {
    throw new ParserError(
      res.code,
      `${formatOf(ext)} render failed (${res.code}): ${res.message}`,
      {
        retryable: true,
        terminal: false,
      },
    );
  }
  const png = res.ok ? res.value.pictures.get(CAD_PICTURE) : undefined;
  if (!png) return [];
  return [
    {
      // sha256 + sniffed ext + dimensions, same helper as every other pass.
      ...describeImageBytes(png, 'png'),
      bytes: png,
      ordinal: 1,
      altText: 'Model space',
      // Bypasses the size floors like DWF sheet renders do: a drawing's one
      // render is content by construction, never decoration.
      essential: true,
      provenance: 'sidecar_render',
    },
  ];
}
