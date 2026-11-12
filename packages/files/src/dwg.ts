/**
 * AutoCAD DWG/DXF and MicroStation DGN → text digest, registry workbook, and
 * model-space render.
 *
 * A `.dgn` takes the same exchange: the worker sniffs a DGN signature and
 * reads it with ezdgn into the same in-memory document (converter "ezdgn"),
 * and its reply carries a `dgn` record of what was and was not converted.
 * Nothing below the sniff has a DGN branch except the wording.
 *
 * A `.dwg` is the LIVE drawing (unlike a `.dwf`, which is a published plot
 * set); a `.dxf` is the same drawing in AutoCAD's interchange encoding
 * (ASCII or binary). Both are read by the parser service's CAD tier, never
 * in this process: everything comes from ONE parser exchange
 * (`parserDwgRender`), whose worker sniffs the bytes: DWG magic is read by
 * ezdwg's reader into an in-memory document (converter "ezdwg", with a `dwg`
 * record of what it could not convert), a DXF is read natively by ezdxf
 * (converter "none"), and it extracts with ezdxf either way.
 * The three extractor passes (text digest, auto-table workbook, image node)
 * all consume the SAME memoised reply, so a drawing costs one upload
 * however many passes run. The `.dxf` public surface (parseDxf & co) lives
 * in ./dxf.ts as thin re-exports of the wrappers defined here; the code path
 * is this one file.
 *
 * Digest philosophy mirrors ./dwf.ts: small and text-shaped, indexes like one
 * document. Layers ordered by entity count; text labels deduped and kept by a
 * CHARACTER budget (frequency orders, never selects — the once-only valve tag
 * is exactly what a query names). Bake-off reality baked in: these drawings
 * carry ZERO DIMENSION entities — the labels ARE the annotation layer, which
 * is why the workbook keeps per-text coordinates for the geometry phase.
 *
 * Failure honesty: a failed exchange throws the parser client's typed
 * ParserError, so the extract records a real error (retried, or terminal on
 * the second counted failure for the same bytes): silently indexing a
 * filename would poison retrieval. The only '' return is a sniff miss (not
 * actually DWG/DXF bytes), which takes the extractor's hollow-skip carve-out
 * like a renamed DWFx does on the dwf route.
 */
import { createHash } from 'node:crypto';
import type { CadExt } from './slug';
import { describeImageBytes, type EmbeddedImage } from './embedded-images';
import { currentParserScope, ParserError } from './parser-client';
import {
  parserDwgRender,
  type DgnFacts,
  type DwgFacts,
  type DwgRender,
  type DwgSymbolFacts,
} from './parser-cad';
import type { ParsedSheet } from './sheet-to-grid';
import { envNum } from '@mantle/config';
import { DWG_ANSWERS_KEY, DWG_VERIFY_RUNS_KEY } from './dwg-keys';

export { DWG_ANSWERS_KEY, DWG_VERIFY_RUNS_KEY };

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

/** True when the bytes open with a DWG version magic (`AC1012`…`AC1032`). */
export function sniffDwg(bytes: Buffer): boolean {
  return /^AC1\d{3}$/.test(bytes.subarray(0, 6).toString('latin1'));
}

/** The binary-DXF sentinel, byte-exact per the DXF reference. */
const DXF_BINARY_SENTINEL = 'AutoCAD Binary DXF\r\n\x1a\x00';

/**
 * True when the bytes look like a DXF. Binary DXF is the fixed 22-byte
 * sentinel. ASCII DXF is group-code/value line pairs from the top: the first
 * non-comment pair must be `0` / `SECTION` (group codes may be space-padded;
 * `999` pairs are comments and legitimately lead the file; a UTF-8 BOM is
 * tolerated). A DWG (binary, starts `AC1…`) and arbitrary text both fail the
 * pair check, which is the point — the '' hollow-skip path keys off this.
 */
export function sniffDxf(bytes: Buffer): boolean {
  if (bytes.subarray(0, 22).toString('latin1') === DXF_BINARY_SENTINEL) return true;
  const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const lines = bytes
    .subarray(start, start + 8192)
    .toString('latin1')
    .split(/\r?\n/);
  for (let i = 0; i + 1 < lines.length; i += 2) {
    if (lines[i]!.trim() === '999') continue; // leading comment pair
    return lines[i]!.trim() === '0' && lines[i + 1]!.trim().toUpperCase() === 'SECTION';
  }
  return false;
}

/** A DGN V8 is an OLE compound file that holds a `Dgn~H` stream (ezdgn
 *  refuses one without it; a directory entry's name is UTF-16LE). A DGN V7
 *  opens with a type-9 header element (2D or 3D). */
const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const DGN_V8_HEADER_NAME = Buffer.from('Dgn~H', 'utf16le');
const DGN_V7_HEADS = [Buffer.from([0x08, 0x09, 0xfe, 0x02]), Buffer.from([0xc8, 0x09, 0xfe, 0x02])];

/** True when the bytes are a DGN: a V7 signature, or a compound file that
 *  names the DGN header stream. Any other compound file named `.dgn` (an old
 *  Word or Excel file) is a sniff miss: the free hollow skip with the
 *  "renamed or mislabelled" hint, never a parser run. */
export function sniffDgn(bytes: Buffer): boolean {
  if (bytes.subarray(0, 8).equals(CFB_MAGIC)) return bytes.includes(DGN_V8_HEADER_NAME);
  const head = bytes.subarray(0, 4);
  return DGN_V7_HEADS.some((h) => head.equals(h));
}

/** The formats this module serves; picks the sniff and the wording. */
type CadFormat = 'DWG' | 'DXF' | 'DGN';

const SNIFF: Record<CadFormat, (bytes: Buffer) => boolean> = {
  DWG: sniffDwg,
  DXF: sniffDxf,
  DGN: sniffDgn,
};

function sniffFor(format: CadFormat, bytes: Buffer): boolean {
  return SNIFF[format](bytes);
}

/** The format of a CAD extension (slug.ts CAD_EXTS). */
function formatOf(ext: CadExt): CadFormat {
  return ext.toUpperCase() as CadFormat;
}

/** The program a format comes from, for the wording. */
function makerOf(format: CadFormat): string {
  return format === 'DGN' ? 'MicroStation' : 'AutoCAD';
}

/** True when the bytes are the format their CAD extension names. */
export function sniffCad(bytes: Buffer, ext: CadExt): boolean {
  return sniffFor(formatOf(ext), bytes);
}

/** Human name for the release behind a DXF/DWG version code, when known. */
const VERSION_NAMES: Record<string, string> = {
  AC1012: 'R13',
  AC1014: 'R14',
  AC1015: 'AutoCAD 2000',
  AC1018: 'AutoCAD 2004',
  AC1021: 'AutoCAD 2007',
  AC1024: 'AutoCAD 2010',
  AC1027: 'AutoCAD 2013',
  AC1032: 'AutoCAD 2018',
};

/* ------------------------------------------------------------------- caps */
const DIGEST_LAYERS = 400;
/** Character budget for the label list — same rationale as the DWF digest. */
const DIGEST_LABEL_CHARS = 12_000;
/** Row ceiling for the Texts tab of the auto-imported registry workbook. */
const MAX_TEXT_ROWS = 20_000;
/** Character budget for the block-attribute list in the digest: room for a
 *  few hundred line-number pairs, since table rows never reach embeddings. */
const DIGEST_BLOCK_CHARS = 24_000;
const DIGEST_BLOCK_LINE_CHARS = 400;
/** Row ceiling for the Blocks tab. */
const MAX_BLOCK_ROWS = 20_000;
/** Attribute-tag columns on the Blocks tab, most frequent tags first. A
 *  title block can carry dozens of tags; the cap keeps the grid usable. */
const MAX_BLOCK_TAG_COLUMNS = 40;
/** The Blocks tab's own columns; a tag with one of these names is renamed. */
const BLOCK_FIXED_COLUMNS = ['Block', 'Layer', 'Handle', 'X', 'Y'];
/** Row ceilings for the bones tabs. The CAD tier's character budgets bind
 *  first on any real drawing; these only guard the grid. */
const MAX_SEGMENT_ROWS = 60_000;
const MAX_NODE_ROWS = 60_000;
const MAX_INSERT_ROWS = 40_000;
const MAX_CIRCUIT_ROWS = 5_000;
/** A drawing's columns the file database's search index leaves out: an SVG
 *  is found by its Key or Name, never by its letters, and indexing it would
 *  about double what the symbols add to the file (bench, 2026-11-12); a
 *  shape's Path is numbers only. */
export const CAD_FTS_SKIP_COLUMNS: readonly string[] = ['SVG', 'Path'];
/** Row ceiling for the Shapes tab: the CAD tier's cap binds first. */
const MAX_SHAPE_ROWS = 100_000;
/** Row ceiling for the symbols tabs: the CAD tier's cap binds first, and a
 *  symbol has at least one placement. */
const MAX_PLACEMENT_ROWS = 40_000;
/** Character budget for the circuit lines in the digest. */
const DIGEST_CIRCUIT_CHARS = 12_000;
const DIGEST_CIRCUIT_LINE_CHARS = 600;

/** Env dial for render sharpness, mirroring DWF_RENDER_DPI (docs there).
 *  One dial for DWG and DXF: same CAD route, same rasteriser.
 *
 *  `raw <= 0` is UNSET, not "smallest allowed". The compose env anchor passes
 *  `DWG_RENDER_DPI: ${DWG_RENDER_DPI:-}`, so an operator who never sets the
 *  dial hands this function the EMPTY STRING — and `Number('')` is 0, which is
 *  finite. Without the `<= 0` arm (the guard ./dwf.ts has too) that 0 would
 *  clamp up to the 50 floor instead of falling back to 300, and every DWG on
 *  every default box would render at 50 dpi: an 800×500 smudge of a P&ID,
 *  small enough (~1 KB) that the embedded-image gate drops it as
 *  `too_few_bytes` and the drawing gets no picture at all. */
export function dwgRenderDpi(): number {
  return envNum('DWG_RENDER_DPI');
}

/**
 * One parser exchange per drawing per process. Keyed by CONTENT HASH, not
 * Buffer identity: the extractor's byte cache can evict and re-read a file
 * between passes under load, and a fresh Buffer of the same bytes must reuse
 * the exchange rather than pay a second upload. Tiny LRU (a node's passes run
 * back-to-back, so 2 in-flight drawings is the realistic ceiling). The
 * PROMISE is memoised so concurrent passes share the in-flight upload.
 *
 * A failed exchange is kept for the rest of the run it failed in (one
 * extract, the parser scope it ran under: packages/files/src/parser-client.ts
 * `withParserScope`), so the extract's later passes neither ask the parser
 * again nor count the same failure twice. A later run (the extract's retry)
 * asks afresh; outside any scope a failure is forgotten at once.
 * Its message is kept (per hash) so a later pass can explain the missing
 * image.
 */
const RENDER_MEMO_MAX = 2;
type RenderEntry = {
  promise: Promise<Awaited<ReturnType<typeof parserDwgRender>>>;
  scope: object | undefined;
  failed: boolean;
};
const renderMemo = new Map<string, RenderEntry>();
const failureMemo = new Map<string, string>();

function dwgHash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fetchDwgRender(bytes: Buffer) {
  const key = dwgHash(bytes);
  const here = currentParserScope();
  let entry = renderMemo.get(key);
  if (entry?.failed && (entry.scope === undefined || entry.scope !== here)) {
    renderMemo.delete(key);
    entry = undefined;
  }
  if (!entry) {
    const fresh = { scope: here, failed: false } as RenderEntry;
    fresh.promise = parserDwgRender(bytes, { dpi: dwgRenderDpi() }).then((res) => {
      if (!res.ok) {
        fresh.failed = true;
        failureMemo.set(key, `${res.code}: ${res.message}`);
        if (failureMemo.size > RENDER_MEMO_MAX) {
          const oldest = failureMemo.keys().next().value;
          if (oldest !== undefined) failureMemo.delete(oldest);
        }
      } else {
        failureMemo.delete(key);
      }
      return res;
    });
    entry = fresh;
    renderMemo.set(key, entry);
    if (renderMemo.size > RENDER_MEMO_MAX) {
      const oldest = renderMemo.keys().next().value;
      if (oldest !== undefined) renderMemo.delete(oldest);
    }
  }
  return entry.promise;
}

async function renderOrThrow(bytes: Buffer, format: CadFormat): Promise<DwgRender> {
  const res = await fetchDwgRender(bytes);
  if (!res.ok) {
    throw new ParserError(res.code, `${format} extraction failed (${res.code}): ${res.message}`, {
      retryable: res.retryable,
      terminal: res.terminal,
    });
  }
  return res.value;
}

/** How the parser reads a DGN, for `dwg-reindex --dgn-data`:
 *  - `data`: with the data reader (its `dgn` record holds `shared_cells`);
 *  - `data-error`: with the data reader, but the data part failed on this
 *    file, so it read the file the 0.3.2 way and said so (`data_error`);
 *  - `v7`: a V7 file, which holds none of the data the reader adds;
 *  - `not-dgn`: the bytes are not a DGN (the sniff), and no parser call;
 *  - `old-reader`: any other reply. A V8 file read with no data is what an
 *    image with ezdgn 0.3.2 gives, and so is a reply with no `dgn` record.
 *  It shares the memoised exchange with the workbook pass, so asking first
 *  costs no second parser call. A failed read throws the ParserError the
 *  workbook pass would. */
export type DgnReading = 'data' | 'data-error' | 'v7' | 'not-dgn' | 'old-reader';

export async function dgnReading(bytes: Buffer): Promise<DgnReading> {
  if (!sniffDgn(bytes)) return 'not-dgn';
  const d = (await renderOrThrow(bytes, 'DGN')).dgn;
  if (d?.dataReader) return 'data';
  if (d?.dataError) return 'data-error';
  return d?.format?.startsWith('V7') ? 'v7' : 'old-reader';
}

/** How the parser reads a DWG, for `dwg-reindex --dwg-reader`:
 *  - `data`: with the ezdwg reader (its reply holds the `dwg` record, which
 *    only that reader sends: converter `ezdwg` alone is no proof, as an older
 *    image named its fallback converter `ezdwg` too);
 *  - `not-dwg`: the bytes are not a DWG (the sniff), and no parser call;
 *  - `old-reader`: any other reply, as an image before the reader gives.
 *  It shares the memoised exchange with the workbook pass, so asking first
 *  costs no second parser call. A failed read throws the ParserError the
 *  workbook pass would. */
export type DwgReading = 'data' | 'not-dwg' | 'old-reader';

export async function dwgReading(bytes: Buffer): Promise<DwgReading> {
  if (!sniffDwg(bytes)) return 'not-dwg';
  return (await renderOrThrow(bytes, 'DWG')).dwg ? 'data' : 'old-reader';
}

/** How the parser reads a drawing's symbols, for `dwg-reindex --symbols`:
 *  - `data`: its reply holds `symbols` (empty for a drawing with no INSERT);
 *  - `not-cad`: the bytes are not the extension's format (the sniff), and no
 *    parser call;
 *  - `old-reader`: a reply with no `symbols`, as an image before the
 *    symbols pass gives.
 *  It shares the memoised exchange with the workbook pass, so asking first
 *  costs no second parser call. A failed read throws the ParserError the
 *  workbook pass would. */
export type SymbolsReading = 'data' | 'not-cad' | 'old-reader';

export async function symbolsReading(bytes: Buffer, ext: CadExt): Promise<SymbolsReading> {
  const format = formatOf(ext);
  if (!sniffFor(format, bytes)) return 'not-cad';
  return (await renderOrThrow(bytes, format)).symbols ? 'data' : 'old-reader';
}

/* ----------------------------------------------------------------- digest */

async function parseCad(bytes: Buffer, format: CadFormat): Promise<string> {
  if (!sniffFor(format, bytes)) return '';
  const r = await renderOrThrow(bytes, format);
  const out: string[] = [];
  // A DGN's document is made in memory: its DXF version names no release, so
  // a DGN states the reader's own format ("V7 2D" already says its
  // dimension; "V8" does not), or nothing when the reply has no DGN facts.
  const dgnFormat = r.dgn?.format ?? null;
  const version =
    format === 'DGN'
      ? [dgnFormat, dgnFormat?.endsWith('D') || !r.dgn?.dimension ? null : `${r.dgn.dimension}D`]
          .filter(Boolean)
          .join(', ')
      : r.version;
  const versionName = (format !== 'DGN' && r.version && VERSION_NAMES[r.version]) || null;
  out.push(
    `${makerOf(format)} ${format} drawing${version ? ` (${version}${versionName ? ` / ${versionName}` : ''})` : ''} — ` +
      `${r.entities} model-space entities, ${r.layers.length} layers` +
      `${r.capped ? ' (registry capped)' : ''}. ` +
      (r.converter === 'none' ? 'Parsed natively as DXF.' : `Converted via ${r.converter}.`),
  );
  if (r.dgn) out.push(...dgnDigest(r.dgn));
  if (r.dwg) out.push(...dwgDigest(r.dwg));

  const typeLine = Object.entries(r.counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
  if (typeLine) out.push(`Entities: ${typeLine}`);

  // The picture frames the sheet, so it must say what it left out.
  if (r.png && r.frame?.framed) {
    const off = r.frame.offSheet.reduce((n, g) => n + g.entities, 0);
    out.push(
      `Picture: frames the sheet. ${off} ${off === 1 ? 'entity sits' : 'entities sit'} off the sheet and ${off === 1 ? 'is' : 'are'} not in it (dwg_render with full: true shows them).`,
    );
  }

  if (r.layers.length) {
    out.push('', 'Layers (by entity count):');
    for (const layer of r.layers.slice(0, DIGEST_LAYERS)) {
      out.push(`  - ${layer.name || '(unnamed)'} (${layer.count})`);
    }
    if (r.layers.length > DIGEST_LAYERS) {
      out.push(`  … ${r.layers.length - DIGEST_LAYERS} more layers`);
    }
  }

  // Dedupe labels with counts; frequency orders the list, the character
  // budget cuts it — never a top-N (the singleton tag is the query target).
  const counts = new Map<string, number>();
  for (const t of r.texts) counts.set(t.text, (counts.get(t.text) ?? 0) + 1);
  if (counts.size) {
    const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    out.push('', `Annotation text (${r.texts.length} entities, ${counts.size} unique):`);
    let spent = 0;
    let shown = 0;
    for (const [text, n] of ordered) {
      const line = n > 1 ? `  - ${text} (×${n})` : `  - ${text}`;
      if (spent + line.length > DIGEST_LABEL_CHARS) break;
      out.push(line);
      spent += line.length;
      shown++;
    }
    if (shown < ordered.length) out.push(`  … ${ordered.length - shown} more unique labels`);
  }

  // One line per attribute-bearing block, its tags kept together: this is
  // what makes "which circuit is line N…" a retrievable sentence rather than
  // two unrelated labels. Drawing order, NOT frequency: every line-number
  // block is unique, so a frequency sort would put them all behind the
  // repeated blocks and the budget would cut exactly the pairs that matter.
  const blockCounts = new Map<string, number>();
  for (const b of r.blocks) {
    const pairs = Object.entries(b.attribs)
      .filter(([, v]) => v)
      .map(([tag, v]) => `${tag}=${v}`)
      .join(', ');
    const line = `  - ${b.block || '(unnamed block)'}: ${pairs}`.slice(0, DIGEST_BLOCK_LINE_CHARS);
    blockCounts.set(line, (blockCounts.get(line) ?? 0) + 1);
  }
  if (blockCounts.size) {
    const ordered = [...blockCounts.entries()];
    out.push('', `Block attributes (${r.blocks.length} blocks, ${blockCounts.size} unique):`);
    let spent = 0;
    let shown = 0;
    for (const [line, n] of ordered) {
      const shownLine = n > 1 ? `${line} (×${n})` : line;
      if (spent + shownLine.length > DIGEST_BLOCK_CHARS) break;
      out.push(shownLine);
      spent += shownLine.length;
      shown++;
    }
    if (shown < ordered.length) out.push(`  … ${ordered.length - shown} more unique blocks`);
  }
  out.push(...geometryDigest(r));
  return out.join('\n');
}

/** The network in a sentence, then one retrievable line per circuit, so
 *  "how long is circuit X" or "which line numbers are on X" find the file. */
function geometryDigest(r: DwgRender): string[] {
  const g = r.geometry;
  if (!g) return [];
  const out: string[] = [];
  const k = g.nodeKinds;
  out.push(
    '',
    `Geometry: ${g.segments} segments, ${g.nodes} nodes (${k.end ?? 0} ends,` +
      ` ${k.joint ?? 0} joints, ${k.tee ?? 0} tees, ${k.block ?? 0} block joins),` +
      ` ${g.runs} runs, ${g.inserts} inserts.`,
  );
  if (!r.circuits.length) return out;
  out.push('', `Circuits (${r.circuits.length}):`);
  let spent = 0;
  let shown = 0;
  for (const c of r.circuits) {
    const parts = [
      `${c.segments} segments (${c.length ?? 0} long)`,
      ...(c.deadlegSegments
        ? [`${c.deadlegSegments} deadleg segments (${c.deadlegLength ?? 0})`]
        : []),
      `${c.runs} run${c.runs === 1 ? '' : 's'}`,
      `${c.tees} tee${c.tees === 1 ? '' : 's'}`,
      `${c.ends} end${c.ends === 1 ? '' : 's'}`,
    ];
    const parent = c.parent ? ` (${c.kind} of ${c.parent})` : '';
    const numbers = c.lineNumbers ? `; line numbers ${c.lineNumbers}` : '';
    const line = `  - Circuit ${c.circuit}${parent}: ${parts.join(', ')}${numbers}`.slice(
      0,
      DIGEST_CIRCUIT_LINE_CHARS,
    );
    if (spent + line.length > DIGEST_CIRCUIT_CHARS) break;
    out.push(line);
    spent += line.length;
    shown++;
  }
  if (shown < r.circuits.length) out.push(`  … ${r.circuits.length - shown} more circuits`);
  return out;
}

/**
 * The indexable text digest. Returns '' only on a sniff miss (bytes are not
 * DWG: hollow-skip); throws when the parser exchange
 * fails, so the node shows an honest extract error instead of junk.
 */
export async function parseDwg(bytes: Buffer): Promise<string> {
  return parseCad(bytes, 'DWG');
}

/** DXF twin of {@link parseDwg} — same contract, DXF sniff. */
export async function parseDxf(bytes: Buffer): Promise<string> {
  return parseCad(bytes, 'DXF');
}

/** The text digest of a CAD file by its extension; '' on a sniff miss. */
export async function parseCadFile(bytes: Buffer, ext: CadExt): Promise<string> {
  return parseCad(bytes, formatOf(ext));
}

/** The one "Not converted" line of a DGN or a DWG: `kinds` are the
 *  reader's rows in words ("VIEWPORT 7"); `more` counts what the capped
 *  row list left out, so the total and the list never disagree. */
function notConvertedLine(
  total: number,
  of: number,
  unit: string,
  kinds: string[],
  more = 0,
): string {
  const list = more > 0 ? [...kinds, `and ${more} more`] : kinds;
  return (
    `Not converted: ${total} of ${of} ${unit}` +
    (list.length ? ` (${list.join(', ')})` : '') +
    '. They are not in the picture, the texts or the bones.'
  );
}

/** What a DGN gave and what it did not, in a few lines: the reader's
 *  counts, so the brain never takes a partial read for a whole one. */
function dgnDigest(d: DgnFacts): string[] {
  const out: string[] = [];
  if (d.notConvertedTotal > 0) {
    const kinds = d.notConverted.map(
      (m) => `${m.name ?? m.kind}${m.type !== null ? ` (type ${m.type})` : ''} ${m.count}`,
    );
    out.push(notConvertedLine(d.notConvertedTotal, d.elements, 'DGN elements', kinds));
  }
  if (d.models.length > 1) {
    out.push(
      `Models: ${d.models.map((m) => `${m.name || '(unnamed)'} (${m.space}${m.elements !== null ? `, ${m.elements} elements` : ''})`).join('; ')}.`,
    );
  }
  if (d.note) out.push(d.note);
  return out;
}

/** What a DWG did not give: the objects not converted, by type, and what
 *  was lost below the entity (`partial`, with the gap when it is not 0), so
 *  the brain never takes a partial read for a whole one. */
function dwgDigest(d: DwgFacts): string[] {
  const out: string[] = [];
  if (d.notConvertedTotal > 0) {
    const byType = new Map<string, number>();
    let listed = 0;
    for (const m of d.notConverted) {
      byType.set(m.type, (byType.get(m.type) ?? 0) + m.count);
      listed += m.count;
    }
    const kinds = [...byType].map(([t, n]) => `${t} ${n}`);
    // The reply's list is cut at 50 rows; what it left out is said, not lost.
    out.push(
      notConvertedLine(
        d.notConvertedTotal,
        d.objects,
        'DWG objects',
        kinds,
        d.notConvertedTotal - listed,
      ),
    );
  }
  const parts = d.partial.map((m) => `${m.reason} ${m.count}`);
  if (d.gap !== 0) parts.push(`${d.gap} of ${d.objects} DWG objects neither converted nor counted`);
  if (parts.length) out.push(`Partly read: ${parts.join(', ')}.`);
  return out;
}

/* ---------------------------------------------------------------- workbook */

export type DwgGrids = {
  sheets: ParsedSheet[];
  /** True when the registry is INCOMPLETE: the CAD tier hit its text/layer
   *  caps or the Texts tab was cut at MAX_TEXT_ROWS. The auto-table
   *  description must not claim "every annotation string" then. */
  capped: boolean;
  /** True when the Blocks tab is incomplete: rows or tag columns cut. Kept
   *  apart from `capped`, which speaks for Texts. */
  blocksCapped?: boolean;
  /** The bones tabs (Segments, Nodes, Inserts, Circuits), when the CAD tier
   *  sent geometry: how it was built and which tab is incomplete. Absent
   *  from an older CAD tier; `error` set when the geometry pass failed
   *  on a drawing whose registry is fine. */
  geometry?: DwgGridsGeometry;
  /** The symbols tabs (Symbols, Placements), when the CAD tier sent them:
   *  what it counted and which tab is incomplete. Absent from an older CAD
   *  tier. */
  symbols?: DwgGridsSymbols;
  /** True when the Shapes tab is incomplete (the CAD tier's caps, or the
   *  row ceiling). */
  shapesCapped?: boolean;
};

export type DwgGridsSymbols = {
  facts: DwgSymbolFacts | null;
  placementsCapped: boolean;
  error: string | null;
};

export type DwgGridsGeometry = {
  snapTolerance: number | null;
  nearDistance: number | null;
  sheets: number;
  skipped: Record<string, number>;
  segmentsCapped: boolean;
  nodesCapped: boolean;
  insertsCapped: boolean;
  circuitsCapped: boolean;
  error: string | null;
};

async function parseCadToGrids(
  bytes: Buffer,
  format: CadFormat,
  withSymbols = true,
): Promise<DwgGrids> {
  if (!sniffFor(format, bytes)) return { sheets: [], capped: false };
  const r = await renderOrThrow(bytes, format);
  const sheets: ParsedSheet[] = [];
  if (r.layers.length) {
    sheets.push({
      name: 'Layers',
      columns: [
        { name: 'Layer', type: 'text' },
        { name: 'Entities', type: 'number' },
      ],
      rows: r.layers.map((l) => [l.name, l.count]),
    });
  }
  if (r.texts.length) {
    sheets.push({
      name: 'Texts',
      columns: [
        { name: 'Text', type: 'text' },
        { name: 'Layer', type: 'text' },
        { name: 'X', type: 'number' },
        { name: 'Y', type: 'number' },
        // The size a redraw sets the text in (drawing_redraw): null from a
        // CAD tier before them.
        { name: 'Height', type: 'number' },
        { name: 'Rotation', type: 'number' },
        { name: 'Width', type: 'number' },
      ],
      rows: r.texts
        .slice(0, MAX_TEXT_ROWS)
        .map((t) => [
          t.text,
          t.layer,
          t.x,
          t.y,
          t.height ?? null,
          t.rotation ?? null,
          t.width ?? null,
        ]),
    });
  }
  const blocks = blocksSheet(r);
  if (blocks.sheet) sheets.push(blocks.sheet);
  const countRows = Object.entries(r.counts).sort((a, b) => b[1] - a[1]);
  if (countRows.length) {
    sheets.push({
      name: 'Counts',
      columns: [
        { name: 'Entity type', type: 'text' },
        { name: 'Count', type: 'number' },
      ],
      rows: countRows,
    });
  }
  const geometry = bonesSheets(r, sheets);
  const symbols = withSymbols ? symbolsSheets(r, sheets) : null;
  if (withSymbols) shapesSheet(r, sheets);
  const shapesCapped = withSymbols && (r.shapesCapped || r.shapes.length > MAX_SHAPE_ROWS);
  return {
    sheets,
    capped: r.capped || r.texts.length > MAX_TEXT_ROWS,
    blocksCapped: r.blocksCapped || blocks.capped,
    ...(geometry ? { geometry } : {}),
    ...(symbols ? { symbols } : {}),
    ...(shapesCapped ? { shapesCapped } : {}),
  };
}

/**
 * The Shapes tab, beside the symbols (a file database only, as they are): the
 * drawable model-space line work, each LINE, CIRCLE, ARC, ELLIPSE, SPLINE and
 * polyline as its exact outline (an SVG path in drawing units, y up) with
 * its box. Segments is the pipe network (chords, no circles, and nothing
 * when the network pass gives up); a redraw reads this instead.
 */
function shapesSheet(r: DwgRender, sheets: ParsedSheet[]): void {
  if (!r.shapes?.length) return;
  sheets.push({
    name: 'Shapes',
    columns: [
      { name: 'Kind', type: 'text' },
      { name: 'Layer', type: 'text' },
      { name: 'Handle', type: 'text' },
      { name: 'Path', type: 'text' },
      { name: 'Min X', type: 'number' },
      { name: 'Min Y', type: 'number' },
      { name: 'Max X', type: 'number' },
      { name: 'Max Y', type: 'number' },
    ],
    rows: r.shapes
      .slice(0, MAX_SHAPE_ROWS)
      .map((g) => [g.kind, g.layer, g.handle, g.path, g.minX, g.minY, g.maxX, g.maxY]),
  });
}

/**
 * The symbols tabs, after the bones: Symbols has one row per exact shape a
 * model-space INSERT uses, drawn once as SVG; Placements one row per INSERT
 * (an array INSERT: one per copy), joined to Symbols by Key. A rebuild draws
 * the drawing from the two. Tags are JSON: a list on Symbols, an object by
 * tag on Placements.
 */
function symbolsSheets(r: DwgRender, sheets: ParsedSheet[]): DwgGridsSymbols | null {
  if (!r.symbols) return null;
  if (r.symbols.length) {
    sheets.push({
      name: 'Symbols',
      columns: [
        { name: 'Key', type: 'text' },
        { name: 'Shape', type: 'text' },
        { name: 'Name', type: 'text' },
        { name: 'Kind', type: 'text' },
        { name: 'SVG', type: 'text' },
        { name: 'X0', type: 'number' },
        { name: 'Y0', type: 'number' },
        { name: 'Width', type: 'number' },
        { name: 'Height', type: 'number' },
        { name: 'Hidden', type: 'number' },
        { name: 'Tags', type: 'text' },
        { name: 'Placements', type: 'number' },
      ],
      rows: r.symbols
        .slice(0, MAX_PLACEMENT_ROWS)
        .map((y) => [
          y.key,
          y.shape,
          y.name,
          y.kind,
          y.svg,
          y.x0,
          y.y0,
          y.width,
          y.height,
          y.hidden ? 1 : 0,
          JSON.stringify(y.tags),
          y.placements,
        ]),
    });
  }
  if (r.placements.length) {
    sheets.push({
      name: 'Placements',
      columns: [
        { name: 'Key', type: 'text' },
        { name: 'X', type: 'number' },
        { name: 'Y', type: 'number' },
        { name: 'Rotation', type: 'number' },
        { name: 'Xscale', type: 'number' },
        { name: 'Yscale', type: 'number' },
        { name: 'Layer', type: 'text' },
        { name: 'Handle', type: 'text' },
        { name: 'Tags', type: 'text' },
      ],
      rows: r.placements
        .slice(0, MAX_PLACEMENT_ROWS)
        .map((p) => [
          p.key,
          p.x,
          p.y,
          p.rotation,
          p.xscale,
          p.yscale,
          p.layer,
          p.handle,
          JSON.stringify(p.tags),
        ]),
    });
  }
  return {
    facts: r.symbolFacts,
    placementsCapped: r.placementsCapped || r.placements.length > MAX_PLACEMENT_ROWS,
    error: r.symbolsError,
  };
}

/** What the description says of the symbols tabs: what each holds, how to
 *  place an SVG, and what was not drawn or kept. */
function shapesClaim(grids: DwgGrids): string {
  if (!grids.sheets.some((s) => s.name === 'Shapes')) return '';
  return (
    ` Shapes has one row per model-space LINE, CIRCLE, ARC, ELLIPSE, SPLINE and polyline:` +
    ` Kind, Layer, Handle, Path its exact outline as an SVG path in drawing units` +
    ` (y up; arcs and splines as curves, where Segments keeps chords) and its box` +
    ` Min X Min Y Max X Max Y` +
    (grids.shapesCapped ? `${TRUNCATED}.` : `.`)
  );
}

function symbolsClaim(grids: DwgGrids): string {
  const y = grids.symbols;
  const has = (name: string) => grids.sheets.some((s) => s.name === name);
  if (!y) return '';
  if (y.error) return ` The symbols pass failed (${y.error}): no Symbols or Placements.`;
  if (!has('Symbols')) return '';
  const f = y.facts;
  const gaps: string[] = [];
  if (f) {
    if (f.drawErrors) gaps.push(`${f.drawErrors} failed to draw`);
    const capped = f.notDrawn.tooLarge + f.notDrawn.totalCap + f.notDrawn.time;
    if (capped) gaps.push(`${capped} not drawn at a cap`);
  }
  return (
    ` Symbols has one row per block shape a model-space INSERT uses: Key is the` +
    ` exact shape (a hash of the block's geometry, of its name for a block of more` +
    ` than 5,000 entities, which has no Shape and no SVG; unique in this table), Shape the` +
    ` turn-free one (the same symbol at another turn, size or mirror has the same` +
    ` Shape: for grouping only), Name the block's name in the file (a label, never an` +
    ` identity), Kind symbol or label (a block of attribute definitions and text` +
    ` only, not drawn), SVG the block drawn once, whose viewBox (0 0 W H) maps to the box` +
    ` X0 Y0 Width Height in block units with the insertion point at 0,0: its top left` +
    ` is X0, Y0 + Height (y up in the block, down in the SVG), Hidden 1 where this drawing shows none of the block (its` +
    ` layers are off or frozen; the SVG draws it with its layers on), Tags its` +
    ` attribute tags as JSON, and Placements its INSERT count` +
    (gaps.length ? ` (SVG is empty where a symbol ${gaps.join(', ')})` : '') +
    `.` +
    (has('Placements')
      ? ` Placements has one row per model-space INSERT (an array INSERT: one per` +
        ` copy, under its Handle): Key joins Symbols; X Y is where the insertion point` +
        ` lands, then Rotation (degrees, counter-clockwise) and Xscale Yscale (a mirror` +
        ` is a negative scale); Tags its attribute values as a JSON object by tag` +
        (y.placementsCapped ? `${TRUNCATED}.` : `.`)
      : '') +
    (f?.unkeyed
      ? ` ${f.unkeyed} INSERTs of an empty or missing block have no row in either tab.`
      : '')
  );
}

/**
 * The bones tabs, appended after the registry tabs (whose names and columns
 * never change: tables and agents depend on them). Segments is the network's
 * edges, Nodes its vertices (Node 1 / Node 2 join them), Inserts every block
 * reference (Handle joins Blocks), Circuits one row per `Circuit <name>`
 * circuit and only on drawings that have such layers.
 */
function bonesSheets(r: DwgRender, sheets: ParsedSheet[]): DwgGridsGeometry | null {
  if (!r.geometry && !r.geometryError) return null;
  if (r.segments.length) {
    sheets.push({
      name: 'Segments',
      columns: [
        { name: 'Layer', type: 'text' },
        { name: 'Handle', type: 'text' },
        { name: 'Type', type: 'text' },
        { name: 'Part', type: 'number' },
        { name: 'X1', type: 'number' },
        { name: 'Y1', type: 'number' },
        { name: 'X2', type: 'number' },
        { name: 'Y2', type: 'number' },
        { name: 'Length', type: 'number' },
        { name: 'Node 1', type: 'number' },
        { name: 'Node 2', type: 'number' },
        { name: 'Run', type: 'number' },
      ],
      rows: r.segments
        .slice(0, MAX_SEGMENT_ROWS)
        .map((g) => [
          g.layer,
          g.handle,
          g.type,
          g.part,
          g.x1,
          g.y1,
          g.x2,
          g.y2,
          g.length,
          g.n1,
          g.n2,
          g.run,
        ]),
    });
  }
  if (r.nodes.length) {
    sheets.push({
      name: 'Nodes',
      columns: [
        { name: 'Node', type: 'number' },
        { name: 'X', type: 'number' },
        { name: 'Y', type: 'number' },
        { name: 'Degree', type: 'number' },
        { name: 'Kind', type: 'text' },
        { name: 'Block', type: 'text' },
        { name: 'Block handle', type: 'text' },
        { name: 'Layers', type: 'text' },
      ],
      rows: r.nodes
        .slice(0, MAX_NODE_ROWS)
        .map((n) => [n.id, n.x, n.y, n.degree, n.kind, n.block, n.blockHandle, n.layers]),
    });
  }
  if (r.inserts.length) {
    sheets.push({
      name: 'Inserts',
      columns: [
        { name: 'Block', type: 'text' },
        { name: 'Layer', type: 'text' },
        { name: 'Handle', type: 'text' },
        { name: 'X', type: 'number' },
        { name: 'Y', type: 'number' },
        { name: 'Rotation', type: 'number' },
        { name: 'Scale X', type: 'number' },
        { name: 'Scale Y', type: 'number' },
        { name: 'Min X', type: 'number' },
        { name: 'Min Y', type: 'number' },
        { name: 'Max X', type: 'number' },
        { name: 'Max Y', type: 'number' },
        { name: 'Attributes', type: 'number' },
      ],
      rows: r.inserts
        .slice(0, MAX_INSERT_ROWS)
        .map((i) => [
          i.block,
          i.layer,
          i.handle,
          i.x,
          i.y,
          i.rotation,
          i.scaleX,
          i.scaleY,
          i.minX,
          i.minY,
          i.maxX,
          i.maxY,
          i.attribs,
        ]),
    });
  }
  if (r.circuits.length) {
    sheets.push({
      name: 'Circuits',
      columns: [
        { name: 'Circuit', type: 'text' },
        { name: 'Parent', type: 'text' },
        { name: 'Kind', type: 'text' },
        { name: 'Layers', type: 'text' },
        { name: 'Entities', type: 'number' },
        { name: 'Segments', type: 'number' },
        { name: 'Length', type: 'number' },
        { name: 'Deadleg segments', type: 'number' },
        { name: 'Deadleg length', type: 'number' },
        { name: 'Runs', type: 'number' },
        { name: 'Tees', type: 'number' },
        { name: 'Ends', type: 'number' },
        { name: 'End points', type: 'text' },
        { name: 'Line numbers', type: 'text' },
        { name: 'Nearby text', type: 'text' },
      ],
      rows: r.circuits
        .slice(0, MAX_CIRCUIT_ROWS)
        .map((c) => [
          c.circuit,
          c.parent,
          c.kind,
          c.layers,
          c.entities,
          c.segments,
          c.length,
          c.deadlegSegments,
          c.deadlegLength,
          c.runs,
          c.tees,
          c.ends,
          c.endPoints,
          c.lineNumbers,
          c.nearbyText,
        ]),
    });
  }
  return {
    snapTolerance: r.geometry?.snapTolerance ?? null,
    nearDistance: r.geometry?.nearDistance ?? null,
    sheets: r.geometry?.sheets ?? 0,
    skipped: r.geometry?.skipped ?? {},
    segmentsCapped: r.segmentsCapped || r.segments.length > MAX_SEGMENT_ROWS,
    nodesCapped: r.nodesCapped || r.nodes.length > MAX_NODE_ROWS,
    insertsCapped: r.insertsCapped || r.inserts.length > MAX_INSERT_ROWS,
    circuitsCapped: r.circuitsCapped || r.circuits.length > MAX_CIRCUIT_ROWS,
    error: r.geometryError,
  };
}

const TRUNCATED = ' (TRUNCATED at its cap: the drawing has more)';

/**
 * The auto-table description for a DWG/DXF/DGN registry workbook: what each tab
 * holds and, as plainly, what it does not. A capped tab says TRUNCATED; a
 * tab that is absent claims nothing.
 */
export function dwgTableDescription(ext: CadExt, grids: DwgGrids): string {
  const has = (name: string) => grids.sheets.some((s) => s.name === name);
  // Honesty over confidence: a capped registry must not claim "every".
  const textsClaim = grids.capped
    ? `Texts holds the annotation strings the registry kept (TRUNCATED at` +
      ` its cap: the drawing carries more)`
    : `Texts is every annotation string`;
  const blocksClaim = has('Blocks')
    ? ` Blocks has one row per attribute-bearing block with one column per` +
      ` attribute tag, so tags of the same block stay together (a LineNumber` +
      ` block's LINENO and CIRCUIT are one row)` +
      (grids.blocksCapped
        ? ` (TRUNCATED: the drawing has more blocks or rarer tags than kept).`
        : `.`)
    : '';
  const head =
    `${makerOf(formatOf(ext))} ${formatOf(ext)} model-space registry. Layers counts entities per layer;` +
    ` ${textsClaim} with its layer and model-space X/Y` +
    ` (drawing units), its Height (drawing units), Rotation (degrees counter-clockwise)` +
    ` and Width (an MTEXT's box width; 0 no wrap; empty for a one-line text), each empty` +
    ` when the reader did not give it; Counts totals entities by type.${blocksClaim}`;
  const g = grids.geometry;
  if (!g || (!has('Segments') && !has('Nodes') && !has('Inserts'))) {
    const why = g?.error ? ` (the geometry pass failed: ${g.error})` : '';
    return (
      `${head} Vector geometry beyond text and block positions is not in this table${why}.` +
      symbolsClaim(grids) +
      shapesClaim(grids)
    );
  }
  const tol = g.snapTolerance ?? 0;
  const parts: string[] = [];
  if (has('Segments')) {
    const skipped = Object.entries(g.skipped)
      .filter(([type]) => type !== 'unreadable')
      .map(([type, n]) => `${n} ${type}`);
    parts.push(
      ` Segments is every LINE on every layer (pipe, leader, border and all), each vertex` +
        ` pair of a polyline, and each ARC, by its two end points in model space (X1 Y1 X2` +
        ` Y2, drawing units); its Layer says which are a circuit's pipe. A bulged` +
        ` polyline segment or an ARC is recorded by its chord, with its true arc Length.` +
        ` SPLINE, ELLIPSE, CIRCLE, hatches and the lines inside blocks are not segments` +
        (skipped.length ? ` (this drawing has ${skipped.join(', ')} left out)` : '') +
        `. A segment that another segment ends on is split there, so one handle can be` +
        ` several rows. Node 1 and Node 2 are Nodes ids; Run numbers the connected runs` +
        (g.segmentsCapped ? `${TRUNCATED}.` : `.`),
    );
  }
  if (has('Nodes')) {
    parts.push(
      ` Nodes is where segment ends meet: ends within ${tol} drawing units are one node` +
        (g.sheets > 1
          ? ` (this model space holds ${g.sheets} sheets and each sheet scales its own` +
            ` tolerance; ${tol} is the largest sheet's),`
          : `,`) +
        ` and lines that only cross, with no end at the crossing, are NOT joined. Degree` +
        ` counts the segment ends there; Kind is end (1), joint (2), tee (3 or more) or block` +
        ` (a pipe end joined to another pipe end through a small block such as a valve or` +
        ` reducer, named in Block; an end that touches one block keeps Kind end with the` +
        ` block named)` +
        (g.nodesCapped ? `${TRUNCATED}.` : `.`),
    );
  }
  if (has('Inserts')) {
    parts.push(
      ` Inserts is every block reference, with or without attributes: insertion X/Y,` +
        ` rotation, scale and the axis-aligned box of the block's own geometry (text left` +
        ` out); Handle joins it to Blocks` +
        (g.insertsCapped ? `${TRUNCATED}.` : `.`),
    );
  }
  if (has('Circuits')) {
    parts.push(
      ` Circuits has one row per circuit drawn on "Circuit <name>" layers: the -DL (-DLn)` +
        ` and -Bnn-DL layers are that circuit's deadlegs (Deadleg segments and length), a` +
        ` -Dnn layer is read as a deadleg too but that is a GUESS from its suffix, -Bnn is` +
        ` a branch of the circuit, and -IPn is an injection point with its own row and its` +
        ` Parent. Segments` +
        ` and Length cover the main layer; Runs, Tees and Ends cover the circuit with its` +
        ` deadlegs; End points says what each end meets (another layer, a block, or open);` +
        ` Line numbers are line-number blocks that name the circuit or sit within` +
        ` ${g.nearDistance ?? 0} drawing units of it, with their handles; Nearby text is` +
        ` every label that close. This is one drawing: a circuit that continues on another` +
        ` sheet ends here` +
        (g.circuitsCapped ? `${TRUNCATED}.` : `.`),
    );
  }
  return head + parts.join('') + symbolsClaim(grids) + shapesClaim(grids);
}

/**
 * The Blocks tab: one row per attribute-bearing INSERT, one column per
 * attribute TAG, so a LineNumber block's LINENO and CIRCUIT sit in the same
 * row (`SELECT "LINENO", "CIRCUIT" FROM "Blocks" WHERE "Block" =
 * 'LineNumber'`). Tags are the union across blocks, most frequent first,
 * capped at MAX_BLOCK_TAG_COLUMNS; a block lacking a tag gets ''.
 */
function blocksSheet(r: DwgRender): { sheet: ParsedSheet | null; capped: boolean } {
  if (!r.blocks.length) return { sheet: null, capped: false };
  const tagCounts = new Map<string, number>();
  for (const b of r.blocks) {
    for (const [tag, v] of Object.entries(b.attribs)) {
      if (v) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }
  const tags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag);
  const kept = tags.slice(0, MAX_BLOCK_TAG_COLUMNS);
  // Column names must be unique, case-insensitively, against the fixed ones too.
  const taken = new Set(BLOCK_FIXED_COLUMNS.map((c) => c.toLowerCase()));
  const tagColumns = kept.map((tag) => {
    let name = tag;
    for (let n = 1; taken.has(name.toLowerCase()); n++) {
      name = n === 1 ? `${tag} (attribute)` : `${tag} (attribute ${n})`;
    }
    taken.add(name.toLowerCase());
    return name;
  });
  return {
    sheet: {
      name: 'Blocks',
      columns: [
        { name: 'Block', type: 'text' },
        { name: 'Layer', type: 'text' },
        { name: 'Handle', type: 'text' },
        { name: 'X', type: 'number' },
        { name: 'Y', type: 'number' },
        ...tagColumns.map((name) => ({ name, type: 'text' as const })),
      ],
      rows: r.blocks
        .slice(0, MAX_BLOCK_ROWS)
        .map((b) => [
          b.block,
          b.layer,
          b.handle,
          b.x,
          b.y,
          ...kept.map((t) => (Object.hasOwn(b.attribs, t) ? b.attribs[t]! : '')),
        ]),
    },
    capped: r.blocks.length > MAX_BLOCK_ROWS || tags.length > kept.length,
  };
}

/**
 * Registry workbook tabs for the auto-table pass: Layers, Texts (with model
 * coordinates), Blocks (attribute tags kept together per block), entity-type
 * Counts, and the bones: Segments, Nodes, Inserts and (on circuitized
 * drawings) Circuits.
 */
export async function parseDwgToGrids(bytes: Buffer): Promise<DwgGrids> {
  return parseCadToGrids(bytes, 'DWG');
}

/** DXF twin of {@link parseDwgToGrids} — same tabs, DXF sniff. */
export async function parseDxfToGrids(bytes: Buffer): Promise<DwgGrids> {
  return parseCadToGrids(bytes, 'DXF');
}

/**
 * The registry workbook of a DWG, DXF or DGN file, as the auto-import pass and
 * the dwg-reindex maintenance task both build it: the sniff for the
 * format, the tabs (one parser exchange) and the table description. No
 * tabs when the bytes are not that format. One code path for the first
 * import and every rebuild, so a rebuilt table is the table a fresh upload
 * would get.
 */
export async function cadRegistryWorkbook(
  bytes: Buffer,
  ext: CadExt,
  /** `symbols: false`: no Symbols or Placements, for a drawing's Table
   *  (`dwg-reindex --table`): they belong in the file's database alone. */
  opts: { symbols?: boolean } = {},
): Promise<{ grids: DwgGrids; description: string | undefined }> {
  // parseCadToGrids returns no sheets on a sniff miss.
  const grids = await parseCadToGrids(bytes, formatOf(ext), opts.symbols !== false);
  return {
    grids,
    description: grids.sheets.length > 0 ? dwgTableDescription(ext, grids) : undefined,
  };
}

/* ------------------------------------------------------------------ images */

async function explainCadImageMiss(bytes: Buffer, format: CadFormat): Promise<string> {
  if (!sniffFor(format, bytes)) return `not ${format} bytes (sniff miss)`;
  const key = dwgHash(bytes);
  const entry = renderMemo.get(key);
  if (entry) {
    // Settled by the time this runs (the image pass awaited the same promise).
    const res = await entry.promise;
    if (res.ok) {
      if (res.value.renderError) return `CAD render failed: ${res.value.renderError}`;
      if (!res.value.png) return 'the CAD tier shipped the registry but no render and no reason';
      return 'a render exists for these bytes (not a miss)';
    }
  }
  const failure = failureMemo.get(key);
  if (failure) return `parser exchange failed (${failure})`;
  return 'no parser exchange was recorded for these bytes';
}

/**
 * Why {@link extractDwgImages} came back empty for these bytes, answered from
 * the memos alone: NEVER a fresh parser exchange (this runs after the image
 * pass on the same bytes, so retrying here would double a failed upload).
 * Feeds the extractor's zero-candidate `extract_images` trace step.
 */
export async function explainDwgImageMiss(bytes: Buffer): Promise<string> {
  return explainCadImageMiss(bytes, 'DWG');
}

/** DXF twin of {@link explainDwgImageMiss}. */
export async function explainDxfImageMiss(bytes: Buffer): Promise<string> {
  return explainCadImageMiss(bytes, 'DXF');
}

/** Why a CAD file got no picture, by its extension. */
export async function explainCadFileImageMiss(bytes: Buffer, ext: CadExt): Promise<string> {
  return explainCadImageMiss(bytes, formatOf(ext));
}

async function extractCadImages(bytes: Buffer, format: CadFormat): Promise<EmbeddedImage[]> {
  if (!sniffFor(format, bytes)) return [];
  const res = await fetchDwgRender(bytes);
  // The parser busy or restarting: the extract retries, rather than
  // completing a drawing with no picture.
  if (!res.ok && (res.code === 'busy' || res.code === 'unavailable')) {
    throw new ParserError(res.code, `${format} render failed (${res.code}): ${res.message}`, {
      retryable: true,
      terminal: false,
    });
  }
  if (!res.ok || !res.value.png) return [];
  return [
    {
      // sha256 + sniffed ext + dimensions, same helper as every other pass.
      ...describeImageBytes(res.value.png, 'png'),
      bytes: res.value.png,
      ordinal: 1,
      altText: 'Model space',
      // Bypasses the size floors like DWF sheet renders do — a drawing's one
      // render is content by construction, never decoration.
      essential: true,
      provenance: 'sidecar_render',
    },
  ];
}

/**
 * The model-space render as a single essential image node. Unlike DWF there
 * is no thumbnail fallback tier inside the file: a failed render yields []
 * and the file simply has no image child: the honest
 * outcome, and the extract-images trace records the reason upstream.
 */
export async function extractDwgImages(bytes: Buffer): Promise<EmbeddedImage[]> {
  return extractCadImages(bytes, 'DWG');
}

/** DXF twin of {@link extractDwgImages}. */
export async function extractDxfImages(bytes: Buffer): Promise<EmbeddedImage[]> {
  return extractCadImages(bytes, 'DXF');
}

/** The model-space picture of a CAD file, by its extension. */
export async function extractCadFileImages(bytes: Buffer, ext: CadExt): Promise<EmbeddedImage[]> {
  return extractCadImages(bytes, formatOf(ext));
}
