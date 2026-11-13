/**
 * circuit_trace, the read: the DWG, DXF and DGN files this CALLER may read, and each
 * one's rows of a circuit, from its bones tabs.
 *
 * A file is one sheet, and its id is the sheet's one id: the trace's keys, the
 * answers' row and seal, and a canvas's `trace.tables` (SheetInput.tableId holds
 * it). So no drawing is traced twice, and an answer filed while a file reads its
 * old Table still applies once its database is built.
 *
 * Rights come from the ordinary scoped reads, never a side door: the list is a
 * `nodes` query in the request's scope, as file_list's is, and the one refusal
 * every reader of a file's rows shares (@mantle/files file-data.ts) runs in one
 * step over the whole list. A refused file is left out and said so, even with an
 * old Table. A file with a database reads it. Any other reads its old Table
 * through `tableSqlSurface`, in the same scope, until that Table goes. The SQL
 * below reads the same tabs from either.
 */
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db, nodes, EXTRACT_SKIPPED_KEY, extractSkippedSql } from '@mantle/db';
import { errorMessage, isUuid } from '@mantle/std';
import { nodeUrl } from '@mantle/content';
import { tableSqlSurface } from '@mantle/content/table-storage';
import {
  fileDataListKeys,
  fileDataRefusals,
  fileDbSqlitePath,
  fileSha256Of,
  type FileDataRow,
} from '@mantle/files';
import { describeWorkbook, runTableSql, type WorkbookTabRef } from '@mantle/tabledb';
import {
  layersOf,
  BRIDGE_REL,
  NEAR_REL,
  trimBounds,
  type BlockRow,
  type InsertRow,
  type NodeRow,
  type SegRow,
  type SheetInput,
  type SourceState,
  type TextRow,
} from './walk';
import { DWG_ANSWERS_KEY, DWG_SOURCE_SHA_KEY } from '@mantle/files/dwg';
import { CAD_NAME_PATTERN } from '@mantle/files/slug';
import { SHAPES } from '@mantle/files/shapes';
import { noDatabaseWords } from '../builtins-file-sql';
import { storedChecksOf, type StoredCheck } from './check';
import { circuitKey } from './check-keys';

/** Drawing files looked at per call (the newest first). */
export const MAX_TABLES = 200;
/** Segment rows read per sheet for one circuit. */
export const MAX_SEGMENTS = 6000;
/** Rows per query (table_sql's own ceiling). */
const PAGE = 1000;
/** Neighbourhood rows (texts, inserts, blocks) per sheet. */
const MAX_NEAR_ROWS = 3000;
/** Segment rows on other layers read per sheet (the network the circuit's
 *  pieces are joined through). */
export const MAX_NETWORK = 12000;

/** The tabs and columns it reads: the circuit-v1 shape, one home. The
 *  statements below read Segments, Nodes, Inserts and Texts by position, in
 *  the shape's order. */
const shapeTab = (name: string) => SHAPES['circuit-v1'].tabs.find((t) => t.name === name)!;
/** Segments' columns read every time; `Part` is asked for with hasColumn. */
const SEGMENT_COLUMNS = shapeTab('Segments').neededColumns;
const NODE_COLUMNS = shapeTab('Nodes').columns;
const INSERT_COLUMNS = shapeTab('Inserts').columns;
const TEXT_COLUMNS = shapeTab('Texts').columns;
/** Blocks is read whole: these are its own columns, the rest are tags. */
const BLOCK_COLUMNS = shapeTab('Blocks').columns;

export type CandidateSheet = {
  /** The drawing file's id: the sheet's one id. */
  id: string;
  title: string;
  /** An old Table's description. A database's own is in its `_meta`. */
  description: string | null;
  sourceFileId: string | null;
  /** The sha256 of the bytes the rows were built from, cut to REVISION_CHARS:
   *  the revision a stored answer belongs to. A database's name holds it. For
   *  an old Table it is the stamp, null for one imported before the stamp. */
  revision?: string | null;
  /** The full sha256 (the image check compares the bytes it crops). */
  sourceSha?: string | null;
  /** Whether the file still holds those bytes. Always `current` for a database.
   *  An old Table is `stale` once its file was replaced in place, and
   *  `unstamped` when it predates the stamp. */
  source?: SourceState;
  /** The old Table this sheet reads while its file has no database. */
  oldTableId?: string | null;
};

/** Characters of the file's sha256 kept as its revision. */
export const REVISION_CHARS = 16;

/** A DWG, DXF or DGN file, by the filename or the title: a drive-synced file has no
 *  `data.filename`. DWF stays out, as it has no bones tabs. */
const IS_DRAWING = sql`lower(coalesce(${nodes.data}->>'filename', ${nodes.title})) ~ ${CAD_NAME_PATTERN}`;

/** A drawing never read: it came before its format had a reader (an old DGN)
 *  and holds a current `no_parser` stamp, so it has no rows. It is still a
 *  drawing (it gives its "gives no sheet" line), but it sorts last, so it
 *  cannot crowd readable drawings out of the window. A write to the file makes
 *  the stamp stale, and the file is read again (docs/parser.md). */
const NEVER_READ = sql`(${nodes.data}->${EXTRACT_SKIPPED_KEY}::text->>'reason' = 'no_parser' AND ${extractSkippedSql()}) IS TRUE`;

/** An old Table of a drawing: auto-imported, the description the CAD pass
 *  writes ("AutoCAD DWG model-space registry", "MicroStation DGN ..."). */
const IS_OLD_DRAWING_TABLE = and(
  eq(nodes.type, 'table'),
  sql`'auto-import' = ANY(${nodes.tags})`,
  sql`${nodes.data}->>'description' ilike '% model-space registry%'`,
);

/** The stamp against the file's current bytes. No hash of the file is
 *  `unreadable`: the revision could not be checked, never read as current. */
export function sourceStateOf(stamped: string | null, fileSha: string | null): SourceState {
  if (!stamped) return 'unstamped';
  if (!fileSha) return 'unreadable';
  return fileSha !== stamped ? 'stale' : 'current';
}

/** The drawing's name as a sheet is called, from either data source, so its
 *  questions read the same before and after its database is built. */
function sheetTitle(row: FileDataRow): string {
  const { filename } = (row.data ?? {}) as Record<string, unknown>;
  const name = typeof filename === 'string' ? filename : row.title;
  return name.replace(new RegExp(CAD_NAME_PATTERN, 'i'), '').trim() || row.title;
}

/** A file row as a sheet read from its own database. */
function databaseSheet(row: FileDataRow): CandidateSheet {
  // A sheet's row passed the refusal, so its sha256 is a valid one.
  const sha = fileSha256Of(row) as string;
  return {
    id: row.id,
    title: sheetTitle(row),
    description: null,
    sourceFileId: row.id,
    revision: sha.slice(0, REVISION_CHARS),
    sourceSha: sha,
    source: 'current',
  };
}

/** The drawing file rows the caller's scope reads: keys, not the whole `data`. */
async function drawingRows(ownerId: string, where: SQL | undefined, cap: number) {
  return db
    .select({ id: nodes.id, path: nodes.path, title: nodes.title, data: fileDataListKeys() })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), eq(nodes.type, 'file'), IS_DRAWING, where))
    .orderBy(NEVER_READ, desc(nodes.updatedAt))
    .limit(cap);
}

/** Of these files, the old Table each reads, as the caller's scope reads it:
 *  the newest, and a read-only copy only when nothing else names the file. */
async function oldTables(ownerId: string, fileIds: readonly string[]) {
  const fileOf = sql<string>`${nodes.data}->>'sourceFileId'`;
  const rows = !fileIds.length
    ? []
    : await db
        .select({
          id: nodes.id,
          fileId: fileOf,
          description: sql<string | null>`${nodes.data}->>'description'`,
          stamped: sql<string | null>`${nodes.data}->>${DWG_SOURCE_SHA_KEY}::text`,
        })
        .from(nodes)
        .where(and(eq(nodes.ownerId, ownerId), IS_OLD_DRAWING_TABLE, inArray(fileOf, [...fileIds])))
        .orderBy(sql`coalesce(${nodes.data} ? 'snapshot_of', false)`, desc(nodes.updatedAt));
  const out = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!out.has(r.fileId)) out.set(r.fileId, r);
  return out;
}

/** Drawings the caller knows only by an old Table: the scope reads the Table and
 *  not its file. A count, as the file's name is not this caller's to read. */
async function drawingsOnlyByOldTable(ownerId: string): Promise<number> {
  const named = await db
    .selectDistinct({ fileId: sql<string | null>`${nodes.data}->>'sourceFileId'` })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), IS_OLD_DRAWING_TABLE));
  const ids = named.flatMap(({ fileId }) => (isUuid(fileId) ? [fileId] : []));
  if (!ids.length) return 0;
  const readable = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), eq(nodes.type, 'file'), inArray(nodes.id, ids)));
  return ids.length - readable.length;
}

/**
 * The drawings the caller's scope reads, newest first, each as one sheet to read.
 * `gaps`: a line for each one that gives no sheet (refused, or with neither a
 * database nor an old Table), and a count for each kind no name can be given of,
 * so a trace never looks complete when it is not.
 */
export async function dwgSheets(
  ownerId: string,
): Promise<{ sheets: CandidateSheet[]; gaps: string[]; more: boolean }> {
  const found = await drawingRows(ownerId, undefined, MAX_TABLES + 1);
  const rows = found.slice(0, MAX_TABLES);
  const refusals = await fileDataRefusals(ownerId, rows);
  const databases = new Map<string, boolean>();
  for (const row of rows) {
    if (!refusals.has(row.id)) {
      databases.set(row.id, (await fileDbSqlitePath(row.id, fileSha256Of(row))) !== null);
    }
  }
  const old = await oldTables(
    ownerId,
    [...databases].filter(([, has]) => !has).map(([id]) => id),
  );
  const sheets: CandidateSheet[] = [];
  const gaps: string[] = [];
  // A count, not a line each: an attachment's name is not this caller's to read.
  let attachments = 0;
  for (const row of rows) {
    const refused = refusals.get(row.id);
    const table = old.get(row.id);
    if (refused?.code === 'email-attachment') attachments += 1;
    else if (refused) gaps.push(`${sheetTitle(row)}: left out of this trace. ${refused.message}`);
    else if (databases.get(row.id)) sheets.push(databaseSheet(row));
    else if (table) {
      const stamped = table.stamped || null;
      sheets.push({
        ...databaseSheet(row),
        description: table.description,
        oldTableId: table.id,
        revision: stamped ? stamped.slice(0, REVISION_CHARS) : null,
        sourceSha: stamped,
        source: sourceStateOf(stamped, fileSha256Of(row) as string),
      });
    } else {
      gaps.push(
        `${sheetTitle(row)}: gives no sheet, so if it carries this circuit the trace is missing it. ${await noDatabaseWords(row)}`,
      );
    }
  }
  // First, so the cap on these lines cannot cut them.
  const tableOnly = await drawingsOnlyByOldTable(ownerId);
  if (tableOnly) {
    gaps.unshift(
      `${tableOnly} drawing${tableOnly === 1 ? '' : 's'} left out of this trace: this caller reads an old Table of ${tableOnly === 1 ? 'it' : 'them'} but not the file. Ask for read access to the file.`,
    );
  }
  if (attachments) {
    gaps.unshift(
      `${attachments} email attachment${attachments === 1 ? '' : 's'} left out of this trace: this caller may not read them.`,
    );
  }
  return { sheets, gaps, more: found.length > MAX_TABLES };
}

/**
 * The drawings a saved canvas names, in its order, for its answers (the overview
 * reads no rows). A new canvas names file ids. An old one names old Tables, each
 * mapped to its file through the table's `sourceFileId`, as the caller's scope
 * reads it. An id that is no uuid, no such drawing, not readable or refused is
 * left out.
 */
export async function dwgSheetsByIds(
  ownerId: string,
  ids: readonly string[],
): Promise<CandidateSheet[]> {
  const want = [...new Set(ids.filter((id) => isUuid(id)))].slice(0, MAX_TABLES);
  if (!want.length) return [];
  const olds = await db
    .select({ id: nodes.id, fileId: sql<string | null>`${nodes.data}->>'sourceFileId'` })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), IS_OLD_DRAWING_TABLE, inArray(nodes.id, want)));
  const fileOf = new Map(olds.map((t) => [t.id, t.fileId]));
  // A table whose data holds no uuid names no file.
  const fileIds = [...new Set(want.map((id) => (fileOf.has(id) ? fileOf.get(id) : id)))].filter(
    (id): id is string => isUuid(id),
  );
  if (!fileIds.length) return [];
  const rows = await drawingRows(ownerId, inArray(nodes.id, fileIds), fileIds.length);
  const refusals = await fileDataRefusals(ownerId, rows);
  const byId = new Map(rows.filter((r) => !refusals.has(r.id)).map((r) => [r.id, r]));
  return fileIds.flatMap((id) => {
    const row = byId.get(id);
    return row ? [databaseSheet(row)] : [];
  });
}

/** One drawing's answers about `circuit`, from its file row in the caller's
 *  scope, whichever data source the file reads. Null when the scope does not
 *  read the row. The cap on the row bounds them (checks-store.ts). */
export async function readCircuitChecks(
  ownerId: string,
  fileId: string,
  circuit: string,
): Promise<StoredCheck[] | null> {
  const [row] = await db
    .select({ answers: sql<unknown>`${nodes.data}->${DWG_ANSWERS_KEY}::text` })
    .from(nodes)
    .where(and(eq(nodes.id, fileId), eq(nodes.ownerId, ownerId), eq(nodes.type, 'file')))
    .limit(1);
  if (!row) return null;
  const asked = circuitKey(circuit);
  return storedChecksOf(row.answers).filter((c) => circuitKey(c.circuit ?? '') === asked);
}

/** A file's database as the reads below take it: what `tableSqlSurface` gives,
 *  from its `.sqlite`, with the description from `_meta`. A name that went since
 *  the list (a replace, a flip) is an error for the caller to say, not a sheet
 *  quietly gone. */
export async function fileDatabaseSurface(
  fileId: string,
  sha256: unknown,
): Promise<{ abs: string; tabs: WorkbookTabRef[]; description: string | null }> {
  const abs = await fileDbSqlitePath(fileId, sha256);
  if (!abs) throw new Error('its database is gone: it was replaced or set to stay out just now');
  const meta = await runTableSql(abs, `SELECT v FROM _meta WHERE k = 'description'`, { cap: 1 });
  const description = meta.rows[0]?.[0];
  return {
    abs,
    tabs: describeWorkbook(abs),
    description: typeof description === 'string' ? description : null,
  };
}

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
/** A stable row order for LIMIT/OFFSET pages: the row id every tab's view
 *  carries (hidden from its column list), so no row is read twice or
 *  skipped between pages. */
const ORDER = ` ORDER BY ${ident('_rid')}`;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? NaN));
const text = (v: unknown) => (v === null || v === undefined ? '' : String(v));

type Sql = (q: string) => Promise<{ columns: string[]; rows: unknown[][]; truncated: boolean }>;

function asObjects(r: { columns: string[]; rows: unknown[][] }): Record<string, unknown>[] {
  return r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
}

/** The near distance the DWG pass used, from the description
 *  ("within N drawing units of it"). */
export function nearFromDescription(description: string | null): number | null {
  const m = /within ([0-9.eE+-]+) drawing units of it/.exec(description ?? '');
  const v = m ? Number(m[1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : null;
}

export type SheetRead =
  | { kind: 'sheet'; sheet: SheetInput }
  | { kind: 'skip' }
  | { kind: 'no-bones'; title: string; tableId: string };

/**
 * One drawing's rows for `circuit`, from its database or its old Table, or
 * `skip` when the circuit is not on it (or the caller cannot open its old
 * Table), `no-bones` when the drawing has the circuit's layers but its rows
 * predate the bones tabs. The answers are read apart (readCircuitChecks).
 */
export async function readSheet(
  ownerId: string,
  t: CandidateSheet,
  circuit: string,
  deps: {
    /** The table_sql run (a test passes its own). */
    run?: (abs: string, q: string, cap: number) => ReturnType<typeof runTableSql>;
    /** The surface, null for an old Table the caller cannot read. */
    surface?: (
      ownerId: string,
      id: string,
    ) => Promise<{ abs: string; tabs: WorkbookTabRef[]; description?: string | null } | null>;
  } = {},
): Promise<SheetRead> {
  const run = deps.run ?? ((abs: string, q: string, cap: number) => runTableSql(abs, q, { cap }));
  const surface: {
    abs: string;
    tabs: WorkbookTabRef[];
    description?: string | null;
  } | null = deps.surface
    ? await deps.surface(ownerId, t.oldTableId ?? t.id)
    : t.oldTableId
      ? await tableSqlSurface(ownerId, t.oldTableId)
      : await fileDatabaseSurface(t.id, t.sourceSha);
  if (!surface) return { kind: 'skip' };
  const description = surface.description ?? t.description;
  /** A failure's words for the limits: never the path of a file on disk. */
  const words = (err: unknown) =>
    errorMessage(err).replaceAll(surface.abs, 'the rows').slice(0, 120);
  const tab = (name: string): WorkbookTabRef | undefined =>
    surface.tabs.find((x) => x.name === name);
  const q: Sql = async (statement) => {
    const r = await run(surface.abs, statement, PAGE);
    return { columns: r.columns, rows: r.rows, truncated: r.truncated };
  };
  const limits: string[] = [];
  /** Whether a tab has a column (an older table may lack a newer one). */
  const hasColumn = (t: WorkbookTabRef, name: string) =>
    !t.columns || t.columns.some((c) => c.name === name);
  /** Whether a query has a row past the first `n` (exactly `n` rows is
   *  not "more than n"). */
  const morePast = async (statement: string, n: number) =>
    (await q(`${statement} LIMIT 1 OFFSET ${n}`)).rows.length > 0;
  /** A part of the read the trace can do without (the network, the labels
   *  around it): a failure is said in limits, the sheet is still listed. */
  const optional = async (what: string, read: () => Promise<void>) => {
    try {
      await read();
    } catch (err) {
      limits.push(`${what} could not be read (${words(err)}); the trace goes on without it`);
    }
  };

  const layersTab = tab('Layers');
  const circuitsTab = tab('Circuits');
  const layerNames: string[] = [];
  if (layersTab) {
    const r = await q(
      `SELECT ${ident('Layer')} AS l FROM ${ident(layersTab.viewName)} WHERE lower(${ident('Layer')}) LIKE 'circuit%'`,
    );
    layerNames.push(...r.rows.map((row) => text(row[0])));
    if (r.truncated) limits.push('more than 1000 circuit layers; some were not looked at');
  }
  let circuitRows: Record<string, unknown>[] = [];
  if (circuitsTab) {
    await optional("the circuit's Circuits row", async () => {
      const parent = hasColumn(circuitsTab, 'Parent')
        ? ` OR lower(trim(${ident('Parent')})) = lower(${lit(circuit.trim())})`
        : '';
      const r = await q(
        `SELECT * FROM ${ident(circuitsTab.viewName)} WHERE lower(trim(${ident('Circuit')})) = lower(${lit(circuit.trim())})${parent}`,
      );
      circuitRows = asObjects(r);
    });
  }
  const own = layersOf(circuit, layerNames);
  const ownLayers = [...own.main, ...own.deadleg];
  if (ownLayers.length === 0 && circuitRows.length === 0) return { kind: 'skip' };
  const segTab = tab('Segments');
  if (!segTab || !tab('Nodes')) return { kind: 'no-bones', title: t.title, tableId: t.id };
  if (/TRUNCATED/.test(description ?? '')) {
    limits.push('its description says a tab is TRUNCATED: the drawing has more than its rows hold');
  }
  // Layers named on the Circuits row (a Layers tab cut at its cap).
  for (const row of circuitRows) {
    for (const l of text(row['Layers']).split(';')) {
      const name = l.trim();
      if (
        name &&
        !ownLayers.includes(name) &&
        layersOf(circuit, [name]).main.length + layersOf(circuit, [name]).deadleg.length
      ) {
        ownLayers.push(name);
      }
    }
  }

  // Segments on the circuit's layers, paged.
  const segments: SegRow[] = [];
  if (ownLayers.length) {
    const inList = ownLayers.map(lit).join(', ');
    const own = `SELECT ${SEGMENT_COLUMNS.map(ident).join(', ')} FROM ${ident(segTab.viewName)} WHERE ${ident('Layer')} IN (${inList})${ORDER}`;
    for (let offset = 0; offset < MAX_SEGMENTS; offset += PAGE) {
      const r = await q(`${own} LIMIT ${PAGE} OFFSET ${offset}`);
      for (const row of r.rows) {
        segments.push({
          layer: text(row[0]),
          handle: text(row[1]),
          x1: num(row[2]),
          y1: num(row[3]),
          x2: num(row[4]),
          y2: num(row[5]),
          length: num(row[6]),
          n1: num(row[7]),
          n2: num(row[8]),
        });
      }
      if (r.rows.length < PAGE) break;
      if (offset + PAGE >= MAX_SEGMENTS && (await morePast(own, MAX_SEGMENTS))) {
        limits.push(
          `the circuit has more than ${MAX_SEGMENTS} segments; the trace read the first ${MAX_SEGMENTS}`,
        );
      }
    }
  }
  if (segments.length === 0) {
    return {
      kind: 'sheet',
      sheet: emptySheet(t, layerNames, circuitRows, limits),
    };
  }

  // Nodes at those segments, then the other end of every block bridge.
  const nodesTab = tab('Nodes')!;
  const toNode = (row: unknown[]): NodeRow => ({
    id: num(row[0]),
    x: num(row[1]),
    y: num(row[2]),
    degree: num(row[3]),
    kind: text(row[4]),
    block: text(row[5]),
    blockHandle: text(row[6]),
    layers: text(row[7])
      .replace(/\s*…$/, '')
      .split(';')
      .map((l) => l.trim())
      .filter(Boolean),
  });
  const byId = new Map<number, NodeRow>();
  const ids = [...new Set(segments.flatMap((g) => [g.n1, g.n2]).filter(Number.isFinite))];
  for (let i = 0; i < ids.length; i += 500) {
    const r = await q(
      `SELECT ${NODE_COLUMNS.map(ident).join(', ')} FROM ${ident(nodesTab.viewName)} WHERE ${ident('Node')} IN (${ids.slice(i, i + 500).join(', ')})`,
    );
    for (const row of r.rows) byId.set(num(row[0]), toNode(row));
  }
  const bridgeHandles = [
    ...new Set(
      [...byId.values()]
        .filter((n) => n.kind === 'block' && n.blockHandle)
        .map((n) => n.blockHandle),
    ),
  ];
  for (let i = 0; i < bridgeHandles.length; i += 500) {
    const r = await q(
      `SELECT ${NODE_COLUMNS.map(ident).join(', ')} FROM ${ident(nodesTab.viewName)} WHERE ${ident('Block handle')} IN (${bridgeHandles
        .slice(i, i + 500)
        .map(lit)
        .join(', ')})`,
    );
    for (const row of r.rows) {
      const n = toNode(row);
      if (!byId.has(n.id)) byId.set(n.id, n);
    }
  }

  // The neighbourhood: the circuit's box, grown by the near distance.
  const xs = segments.flatMap((g) => [g.x1, g.x2]).filter(Number.isFinite);
  const ys = segments.flatMap((g) => [g.y1, g.y2]).filter(Number.isFinite);
  let near = nearFromDescription(description);
  if (!near) {
    // The CAD tier's own rule (dwg_bones.extent_diagonal): the box of the
    // middle 99% of every segment end point, so a stray entity far off
    // does not loosen it.
    const counted = await q(`SELECT count(*) FROM ${ident(segTab.viewName)}`);
    const n = 2 * num(counted.rows[0]?.[0] ?? 0);
    const [lo, hi] = trimBounds(n);
    const at = async (a: string, b: string, k: number) => {
      const r = await q(
        `SELECT v FROM (SELECT ${ident(a)} AS v FROM ${ident(segTab.viewName)} UNION ALL SELECT ${ident(b)} FROM ${ident(segTab.viewName)}) ORDER BY v LIMIT 1 OFFSET ${Math.max(0, Math.floor(k))}`,
      );
      return num(r.rows[0]?.[0] ?? 0);
    };
    const diag =
      n > 0
        ? Math.hypot(
            (await at('X1', 'X2', hi)) - (await at('X1', 'X2', lo)),
            (await at('Y1', 'Y2', hi)) - (await at('Y1', 'Y2', lo)),
          )
        : 0;
    near = Math.max((Number.isFinite(diag) ? diag : 0) * NEAR_REL, 1e-6);
  }
  const box = {
    minX: Math.min(...xs) - near,
    maxX: Math.max(...xs) + near,
    minY: Math.min(...ys) - near,
    maxY: Math.max(...ys) + near,
  };
  // The network around it: every other layer's segments within a bridge's
  // reach of the circuit (pieces of one circuit are joined through them),
  // and the labels and blocks that far out (equipment tags sit inside the
  // outline a run ends on, often further than `near` from the end).
  const reach = (near / NEAR_REL) * BRIDGE_REL;
  const wide = {
    minX: box.minX - reach,
    maxX: box.maxX + reach,
    minY: box.minY - reach,
    maxY: box.maxY + reach,
  };
  const inBox = `${ident('X')} BETWEEN ${wide.minX} AND ${wide.maxX} AND ${ident('Y')} BETWEEN ${wide.minY} AND ${wide.maxY}`;
  const network: SegRow[] = [];
  if (!hasColumn(segTab, 'Part')) {
    // An older bones table: every polyline reads as one straight piece, so
    // a polyline vessel is one long "line" (no outline), and a process line
    // drawn as one polyline is longer than a join may run along.
    limits.push(
      `its Segments tab has no Part column (a table indexed before it came in), so each polyline reads as one straight piece: equipment outlines and joins through polylines are mostly missed, and ends that would sit at equipment or links that would be certain read as open or guessed. An owner can rebuild the table to read it fully: pnpm maintain dwg-reindex --file=${t.sourceFileId ?? '<file id>'} --again (a dry run; add --apply to rebuild)`,
    );
  }
  await optional('the network around the circuit (other layers)', async () => {
    const notOwn = ownLayers.map(lit).join(', ');
    const [X1, X2, Y1, Y2] = ['X1', 'X2', 'Y1', 'Y2'].map(ident);
    const overlaps = `min(${X1}, ${X2}) <= ${wide.maxX} AND max(${X1}, ${X2}) >= ${wide.minX} AND min(${Y1}, ${Y2}) <= ${wide.maxY} AND max(${Y1}, ${Y2}) >= ${wide.minY}`;
    // Part (the polyline vertex pair) came in after the first bones
    // tables: an older table reads 0.
    const part = hasColumn(segTab, 'Part') ? ident('Part') : '0';
    const around = `SELECT ${SEGMENT_COLUMNS.map(ident).join(', ')}, ${part} FROM ${ident(segTab.viewName)} WHERE ${ident('Layer')} NOT IN (${notOwn}) AND ${overlaps}${ORDER}`;
    for (let offset = 0; offset < MAX_NETWORK; offset += PAGE) {
      let r: Awaited<ReturnType<Sql>>;
      try {
        r = await q(`${around} LIMIT ${PAGE} OFFSET ${offset}`);
      } catch (err) {
        // A page past the first fails: the rows read are real geometry and
        // are kept; the limit says the network is partial.
        if (!network.length) throw err;
        limits.push(
          `the network around the circuit (other layers) could only be read in part: the first ${network.length} segments, then a page failed (${words(err)}); the trace goes on with those, and pieces may stay unjoined where the rest would have joined them`,
        );
        return;
      }
      for (const row of r.rows) {
        network.push({
          layer: text(row[0]),
          handle: text(row[1]),
          x1: num(row[2]),
          y1: num(row[3]),
          x2: num(row[4]),
          y2: num(row[5]),
          length: num(row[6]),
          n1: num(row[7]),
          n2: num(row[8]),
          part: num(row[9]),
        });
      }
      if (r.rows.length < PAGE) break;
      if (offset + PAGE >= MAX_NETWORK && (await morePast(around, MAX_NETWORK))) {
        limits.push(
          `more than ${MAX_NETWORK} segments on other layers around the circuit; pieces may stay unjoined where the rest would have joined them`,
        );
      }
    }
  });

  /** Every row of a SELECT, a page at a time in a stable order, up to
   *  `max`; `cut` only when a row lies past `max`. */
  const paged = async (statement: string, max: number) => {
    const rows: unknown[][] = [];
    let columns: string[] = [];
    const ordered = `${statement}${ORDER}`;
    for (let offset = 0; offset < max; offset += PAGE) {
      const r = await q(`${ordered} LIMIT ${PAGE} OFFSET ${offset}`);
      columns = r.columns;
      rows.push(...r.rows);
      if (r.rows.length < PAGE) return { columns, rows, cut: false };
    }
    return { columns, rows, cut: await morePast(ordered, max) };
  };
  const inserts: InsertRow[] = [];
  const insTab = tab('Inserts');
  if (insTab)
    await optional('the blocks around the circuit (Inserts)', async () => {
      const handles = bridgeHandles.length
        ? ` OR ${ident('Handle')} IN (${bridgeHandles.map(lit).join(', ')})`
        : '';
      const r = await paged(
        `SELECT ${INSERT_COLUMNS.map(ident).join(', ')} FROM ${ident(insTab.viewName)} WHERE (${inBox})${handles}`,
        MAX_NEAR_ROWS,
      );
      for (const row of r.rows) {
        const opt = (v: unknown) => (v === null || v === '' || v === undefined ? null : num(v));
        inserts.push({
          block: text(row[0]),
          layer: text(row[1]),
          handle: text(row[2]),
          x: num(row[3]),
          y: num(row[4]),
          minX: opt(row[5]),
          minY: opt(row[6]),
          maxX: opt(row[7]),
          maxY: opt(row[8]),
        });
      }
      if (r.cut)
        limits.push(
          `more than ${MAX_NEAR_ROWS} blocks around the circuit; the rest were not looked at`,
        );
    });
  const texts: TextRow[] = [];
  const textTab = tab('Texts');
  if (textTab)
    await optional('the labels around the circuit (Texts)', async () => {
      const r = await paged(
        `SELECT ${TEXT_COLUMNS.map(ident).join(', ')} FROM ${ident(textTab.viewName)} WHERE ${inBox}`,
        MAX_NEAR_ROWS,
      );
      for (const row of r.rows)
        texts.push({ text: text(row[0]), layer: text(row[1]), x: num(row[2]), y: num(row[3]) });
      if (r.cut)
        limits.push(
          `more than ${MAX_NEAR_ROWS} labels around the circuit; the rest were not looked at`,
        );
    });
  const blocks: BlockRow[] = [];
  const blockTab = tab('Blocks');
  if (blockTab)
    await optional('the attribute blocks around the circuit (Blocks)', async () => {
      // The Blocks tab's X/Y is the insert's OCS point; the inserts read above
      // are by their WCS point, so their handles are asked for too (a mirrored
      // block's OCS point can sit outside the box). The walk places each
      // block at its Inserts point.
      const named = [
        ...circuitRows.flatMap((row) =>
          [...text(row['Line numbers']).matchAll(/\[([^\]]*)\]/g)].map((m) => m[1]!),
        ),
        ...inserts.map((i) => i.handle).filter(Boolean),
      ];
      const byHandle = named.length
        ? ` OR ${ident('Handle')} IN (${named.map(lit).join(', ')})`
        : '';
      const r = await paged(
        `SELECT * FROM ${ident(blockTab.viewName)} WHERE (${inBox})${byHandle}`,
        MAX_NEAR_ROWS,
      );
      for (const o of asObjects(r)) {
        const attribs: Record<string, string> = {};
        for (const [k, v] of Object.entries(o)) {
          if (BLOCK_COLUMNS.includes(k) || k.startsWith('_')) continue;
          if (v !== null && v !== '') attribs[k.replace(/ \(attribute( \d+)?\)$/, '')] = text(v);
        }
        blocks.push({
          block: text(o['Block']),
          layer: text(o['Layer']),
          handle: text(o['Handle']),
          x: num(o['X']),
          y: num(o['Y']),
          attribs,
        });
      }
      if (r.cut)
        limits.push(
          `more than ${MAX_NEAR_ROWS} attribute blocks around the circuit; the rest were not looked at`,
        );
    });

  return {
    kind: 'sheet',
    sheet: {
      tableId: t.id,
      title: t.title,
      sourceFileId: t.sourceFileId,
      revision: t.revision ?? null,
      sourceSha: t.sourceSha ?? null,
      source: t.source ?? 'unstamped',
      url: nodeUrl(t.id),
      circuitLayers: layerNames,
      circuitRows,
      segments,
      nodes: [...byId.values()],
      inserts,
      texts,
      blocks,
      near,
      network,
      limits,
    },
  };
}

function emptySheet(
  t: CandidateSheet,
  layers: string[],
  circuitRows: Record<string, unknown>[],
  limits: string[],
): SheetInput {
  return {
    tableId: t.id,
    title: t.title,
    sourceFileId: t.sourceFileId,
    circuitLayers: layers,
    circuitRows,
    segments: [],
    nodes: [],
    inserts: [],
    texts: [],
    blocks: [],
    near: 0,
    limits,
  };
}
