/**
 * A read in part, said out loud (docs/files.md, "Read in part"): the one
 * shape every reader uses to say it took only some of an input, so no cut
 * of the content is silent. The owner's rule (2026-11-19): everything that
 * is uploaded is consumed in full; until each cap is gone, a cut is at least
 * never hidden.
 *
 * A node keeps its cuts in `data.read_cut`, one entry per kind of cut, by
 * its key (the reason, with `:<part>` when one file can have several, as
 * one Agent's text each):
 *
 *   { "sheet_rows": { "what": "rows", "read": 5000, "total": 12000, "limit": 5000 } }
 *
 *  - `what`: the unit counted (rows, sheets, characters, pictures, ...);
 *  - `read`: how many the read took (or let through, for a picture gate);
 *  - `total`: how many there were, when the reader knows (`atLeast`: at
 *    least that many, the reader stopped counting);
 *  - `limit`: the cap that cut it, when there is one number.
 *
 * The extractor writes it at the end of a read (./read-cut-sink.ts collects
 * what the readers said during it); new bytes and a reindex drop it with the
 * other byte keys. A file with any entry is `partial` (./extraction-status.ts),
 * and the hint of each entry is one sentence for a person and an agent.
 *
 * Pure, with no imports: the extraction state, the parser job and the tests
 * share it.
 */

/** One kind of cut, as stored in `data.read_cut[key]`. */
export type ReadCutValue = {
  what: string;
  read: number;
  total?: number;
  /** `total` is a lower bound: the reader stopped counting. */
  atLeast?: true;
  limit?: number;
};

/** The stored map: key (the reason, or `<reason>:<part>`) to its cut. */
export type ReadCuts = Record<string, ReadCutValue>;

/** One cut as a person and an agent see it: its key, the counts and the
 *  sentence that says what was left out. */
export type ReadCutView = ReadCutValue & { key: string; hint: string };

const n = (v: number): string => v.toLocaleString('en-US');

/** The left-out count, never below 0. */
const left = (c: ReadCutValue): number => Math.max(0, (c.total ?? c.read) - c.read);

/** `read of total` or, with no total, `the first read`. */
const ofTotal = (c: ReadCutValue): string =>
  c.total !== undefined
    ? `${n(c.read)} of ${c.atLeast ? 'at least ' : ''}${n(c.total)}`
    : `the first ${n(c.read)}`;

const limitText = (c: ReadCutValue, unit: string, fallback: string): string =>
  c.limit !== undefined ? `${n(c.limit)} ${unit}` : fallback;

/** A picture gate's sentence: how many of how many were left out, and why. */
const pictures =
  (why: (c: ReadCutValue) => string) =>
  (c: ReadCutValue): string =>
    `${n(left(c))} of ${n(c.total ?? c.read)} pictures were left out: ${why(c)}. They are not in search.`;

/** The sentence of each known cut, by its reason (the key before any `:`). */
const HINTS: Readonly<Record<string, (c: ReadCutValue) => string>> = {
  // A scan read in part (the PDF OCR's `ocr.pages_*`, folded in here).
  ocr_pages: (c) => `Only ${ofTotal(c)} pages were read. The other pages are not in search.`,
  // Pictures the PDF reader left out (`data.images`, folded in here).
  pictures: (c) =>
    `${ofTotal(c)} pictures kept. The others are not in search: a raised picture cap and a new read fetch those the cap left out.`,
  // A book's pages left to vision with no page picture yet (`data.images`
  // part `pages`, G1).
  page_pictures: (c) =>
    `${n(c.read)} of ${n(c.total ?? c.read)} pages left to vision are read. The others keep their OCR text only: run the Agent pdf-page-read on the book to read them.`,
  text_store: (c) =>
    `${ofTotal(c)} characters of its text are kept for file_read (a ${limitText(c, 'character', '1,000,000-character')} limit). Search covers all of it.`,
  sheet_rows: (c) =>
    `${ofTotal(c)} rows are in its text (at most ${limitText(c, 'rows', '5,000 rows')} a sheet). The other rows are not in search; file_sql reads them from the file's database when it has one.`,
  sheet_columns: (c) =>
    `${ofTotal(c)} columns are in its text (at most ${limitText(c, 'columns', '256 columns')} a sheet). The other columns are not in search.`,
  sheet_text: (c) =>
    `${ofTotal(c)} sheets are in its text (a ${limitText(c, 'character', '1,000,000-character')} limit for a workbook). The other sheets are not in search.`,
  legacy_cells: (c) =>
    `${ofTotal(c)} sheets were read: the others are past the ${limitText(c, 'cell', '1,000,000-cell')} limit of a legacy spreadsheet. Save it as .xlsx and upload it to read them.`,
  markup_bytes: (c) =>
    `Only ${ofTotal(c)} bytes were read (a ${limitText(c, 'byte', '32 MB')} limit for HTML and XML). The rest is not in search.`,
  database_size: (c) =>
    `No database was built: the file is ${n(c.total ?? 0)} bytes, past the ${limitText(c, 'byte', '32 MB')} limit, so file_sql has no rows of it. Its text is read as usual.`,
  database_rows: (c) =>
    `No database was built: its sheets hold ${n(c.total ?? 0)} rows, past the ${limitText(c, 'row', 'import')} limit, so file_sql has no rows of it. Its text is read as usual.`,
  cad_texts: (c) =>
    `${ofTotal(c)} texts of the drawing were read (a ${limitText(c, 'text', '20,000-text')} limit). The others are not in search.`,
  cad_text_length: (c) =>
    `${n(left(c))} of ${n(c.total ?? c.read)} texts of the drawing were longer than ${limitText(c, 'characters', '512 characters')} and were cut to that length.`,
  cad_layers: (c) =>
    `${ofTotal(c)} layers of the drawing were read (a ${limitText(c, 'layer', '1,000-layer')} limit).`,
  cad_labels: (c) =>
    `${ofTotal(c)} distinct labels are in its text (a ${limitText(c, 'character', '12,000-character')} budget). The others are in the file's database only (file_sql).`,
  cad_blocks_cap: (c) =>
    `${ofTotal(c)} attribute blocks of the drawing were read (a ${limitText(c, 'block', '20,000-block')} limit).`,
  cad_geometry: (c) =>
    `${n(left(c))} of ${n(c.total ?? c.read)} geometry lists of the drawing (segments, nodes, inserts, circuits, placements, shapes) stopped at their size budget.`,
  cad_blocks: (c) =>
    `${ofTotal(c)} distinct block lines are in its text (a ${limitText(c, 'character', '24,000-character')} budget). The others are in the file's database only (file_sql).`,
  dwf_sheets: (c) =>
    `${ofTotal(c)} sheets of the plot set were read (a ${limitText(c, 'sheet', '64-sheet')} limit). The other sheets are not in search.`,
  dwf_scan: (c) =>
    `${n(left(c))} of ${n(c.total ?? c.read)} sheets were scanned in part (a drawing stream past 16 MB, or past 500 layers or 2,000 distinct labels on a sheet).`,
  dwf_labels: (c) =>
    `${ofTotal(c)} distinct labels are in its text (8,000 characters a sheet). The others are in the file's database only (file_sql).`,
  layer_list: (c) =>
    `${ofTotal(c)} layers are in its layer list (a ${limitText(c, 'layer', '400-layer')} limit).`,
  agent_text: (c) =>
    `${ofTotal(c)} characters of an Agent's fields are in its text (a ${limitText(c, 'character', '64,000-character')} limit). file_sql reads every row.`,
  vision_answer: (c) =>
    `${n(left(c))} picture ${left(c) === 1 ? 'description' : 'descriptions'} stopped at the model's answer limit${c.limit !== undefined ? ` (${n(c.limit)} tokens)` : ''}: the end of what ${left(c) === 1 ? 'it shows is' : 'they show is'} not in search.`,
  pictures_small: pictures(() => 'under 200 pixels on a side, taken for icons or decoration'),
  pictures_metafile: pictures(() => 'Windows metafiles (EMF or WMF), which no browser shows'),
  pictures_unreadable: pictures(() => 'not in a picture format the brain reads'),
  pictures_tiny: pictures(() => 'too few bytes to judge as a picture'),
  pictures_large: pictures(
    () => 'each past 32 MB, or past the 256 MB of pictures one drawing may hold',
  ),
  description: (c) =>
    c.read === 0
      ? `Its description (${n(c.total ?? 0)} characters) was left out: the feed was too large to send with it.`
      : `${ofTotal(c)} characters of its description were kept (a ${limitText(c, 'character', '4,000-character')} limit).`,
};

function generic(c: ReadCutValue): string {
  return `${ofTotal(c)} ${c.what} were read. The rest is not in search.`;
}

/** The reason of a key: the part before any `:`. */
export function readCutReason(key: string): string {
  const at = key.indexOf(':');
  return at < 0 ? key : key.slice(0, at);
}

/** The sentence of one cut. */
export function readCutHint(key: string, c: ReadCutValue): string {
  return (HINTS[readCutReason(key)] ?? generic)(c);
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** One stored value, checked, or null (never trusted as it comes). */
export function readCutValueOf(raw: unknown): ReadCutValue | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.what !== 'string' || !o.what || !isCount(o.read)) return null;
  return {
    what: o.what.slice(0, 40),
    read: o.read,
    ...(isCount(o.total) ? { total: o.total } : {}),
    ...(o.atLeast === true && isCount(o.total) ? { atLeast: true as const } : {}),
    ...(typeof o.limit === 'number' && Number.isFinite(o.limit) ? { limit: o.limit } : {}),
  };
}

/** The keys a stored map may hold: short, of letters, digits, `_`, `-`,
 *  `:` and `.` only. */
const KEY_RE = /^[a-z][a-z0-9_]*(?::[A-Za-z0-9_.-]{1,80})?$/;

/** The checked cuts of a stored `read_cut`, or of a parser answer's `cuts`;
 *  {} for anything else. */
export function readCutsOf(raw: unknown): ReadCuts {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: ReadCuts = {};
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (key.length > 120 || !KEY_RE.test(key)) continue;
    const c = readCutValueOf(v);
    if (c) out[key] = c;
  }
  return out;
}

/** The cuts that are details only (the owner, 2026-11-19: "No, details
 *  only"): pictures the size gate skipped as icons, bullets or small logos
 *  (`pictures_small`, `pictures_tiny`). They stay in a file's `cuts` with
 *  their sentence, but alone they never make it `partial` nor push the
 *  admins. Every other cut does. The SQL form (ops/queries.ts
 *  readCutMakesPartialSql) names the same reasons. */
export const DETAIL_ONLY_CUT_REASONS: readonly string[] = ['pictures_small', 'pictures_tiny'];

/** Whether a cut of this key makes the file `partial` (not a detail only). */
export function cutMakesPartial(key: string): boolean {
  return !DETAIL_ONLY_CUT_REASONS.includes(readCutReason(key));
}

/** True when a stored `read_cut` says anything was left out: a non-empty
 *  object. */
export function hasReadCut(raw: unknown): boolean {
  return (
    !!raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw as object).length > 0
  );
}

/** True when a stored `read_cut` holds a cut that makes the file `partial`
 *  (any key but the details only). The SQL form (ops/stale.ts,
 *  ops/queries.ts: readCutMakesPartialSql) is the same test. */
export function hasPartialReadCut(raw: unknown): boolean {
  return hasReadCut(raw) && Object.keys(raw as object).some(cutMakesPartial);
}

/** Two cuts of one key in one read (two sheets, two pictures): the counts
 *  added, the larger limit. */
export function addReadCut(a: ReadCutValue | undefined, b: ReadCutValue): ReadCutValue {
  if (!a) return { ...b };
  const total =
    a.total !== undefined || b.total !== undefined
      ? (a.total ?? a.read) + (b.total ?? b.read)
      : undefined;
  const limit =
    a.limit !== undefined || b.limit !== undefined
      ? Math.max(a.limit ?? -Infinity, b.limit ?? -Infinity)
      : undefined;
  return {
    what: a.what,
    read: a.read + b.read,
    ...(total !== undefined ? { total } : {}),
    ...(a.atLeast || b.atLeast ? { atLeast: true as const } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

/** The views of a stored map, in key order. */
export function readCutViews(cuts: ReadCuts): ReadCutView[] {
  // The folded-in entries first, in the order the file status said them
  // before (a scan's pages, the pictures kept, a book's page pictures), then
  // the readers' cuts by key.
  const rank = (k: string) => {
    const i = FOLDED_FIRST.indexOf(k);
    return i < 0 ? FOLDED_FIRST.length : i;
  };
  return Object.keys(cuts)
    .sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
    .map((key) => ({ key, ...cuts[key]!, hint: readCutHint(key, cuts[key]!) }));
}

/** The entries extraction-status.ts folds in from `ocr` and `data.images`. */
const FOLDED_FIRST: readonly string[] = ['ocr_pages', 'pictures', 'page_pictures'];
