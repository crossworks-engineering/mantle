/**
 * circuit_trace, the read: the DWG/DXF auto-import tables this CALLER may
 * read that carry a circuit, and that circuit's rows from their bones tabs.
 *
 * Rights come from the ordinary scoped reads, never a side door: the list
 * is a `nodes` query in the request's scope (row level security filters a
 * workspace scope to what it reads, as table_list's does), and each table's
 * workbook is opened through `tableSqlSurface`, the table_sql path, which
 * answers null for a table the caller cannot read. A table the scope does
 * not return is never opened, so its rows cannot reach the trace.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { db, nodes } from '@mantle/db';
import { nodeUrl } from '@mantle/content';
import { tableSqlSurface } from '@mantle/content/table-storage';
import { runTableSql, type WorkbookTabRef } from '@mantle/tabledb';
import {
  layersOf,
  NEAR_REL,
  trimBounds,
  type BlockRow,
  type InsertRow,
  type NodeRow,
  type SegRow,
  type SheetInput,
  type TextRow,
} from './walk';

/** Tables looked at per call (the newest first). */
export const MAX_TABLES = 200;
/** Segment rows read per sheet for one circuit. */
export const MAX_SEGMENTS = 6000;
/** Rows per query (table_sql's own ceiling). */
const PAGE = 1000;
/** Neighbourhood rows (texts, inserts, blocks) per sheet. */
const MAX_NEAR_ROWS = 1000;

export type CandidateTable = {
  id: string;
  title: string;
  description: string | null;
  sourceFileId: string | null;
};

/** The DWG/DXF registry tables the caller's scope reads (auto-imported, the
 *  description the DWG pass writes), newest first. */
export async function dwgTables(
  ownerId: string,
): Promise<{ tables: CandidateTable[]; more: boolean }> {
  const rows = await db
    .select({ id: nodes.id, title: nodes.title, data: nodes.data })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'table'),
        sql`'auto-import' = ANY(${nodes.tags})`,
        sql`${nodes.data}->>'description' ilike 'AutoCAD %model-space registry%'`,
      ),
    )
    .orderBy(desc(nodes.updatedAt))
    .limit(MAX_TABLES + 1);
  return {
    more: rows.length > MAX_TABLES,
    tables: rows.slice(0, MAX_TABLES).map((r) => {
      const d = (r.data ?? {}) as Record<string, unknown>;
      return {
        id: r.id,
        title: r.title,
        description: typeof d.description === 'string' ? d.description : null,
        sourceFileId: typeof d.sourceFileId === 'string' ? d.sourceFileId : null,
      };
    }),
  };
}

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? NaN));
const text = (v: unknown) => (v === null || v === undefined ? '' : String(v));

type Sql = (q: string) => Promise<{ columns: string[]; rows: unknown[][]; truncated: boolean }>;

function asObjects(r: { columns: string[]; rows: unknown[][] }): Record<string, unknown>[] {
  return r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
}

/** The near distance the DWG pass used, from the table description
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
 * One table's rows for `circuit`, or `skip` when the circuit is not on it
 * (or the caller cannot open it), `no-bones` when the drawing has the
 * circuit's layers but its table predates the bones tabs.
 */
export async function readSheet(
  ownerId: string,
  t: CandidateTable,
  circuit: string,
  run: (abs: string, q: string, cap: number) => ReturnType<typeof runTableSql> = (abs, q, cap) =>
    runTableSql(abs, q, { cap }),
): Promise<SheetRead> {
  const surface = await tableSqlSurface(ownerId, t.id);
  if (!surface) return { kind: 'skip' };
  const tab = (name: string): WorkbookTabRef | undefined =>
    surface.tabs.find((x) => x.name === name);
  const q: Sql = async (statement) => {
    const r = await run(surface.abs, statement, PAGE);
    return { columns: r.columns, rows: r.rows, truncated: r.truncated };
  };
  const limits: string[] = [];

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
    const r = await q(
      `SELECT * FROM ${ident(circuitsTab.viewName)} WHERE lower(trim(${ident('Circuit')})) = lower(${lit(circuit.trim())}) OR lower(trim(${ident('Parent')})) = lower(${lit(circuit.trim())})`,
    );
    circuitRows = asObjects(r);
  }
  const own = layersOf(circuit, layerNames);
  const ownLayers = [...own.main, ...own.deadleg];
  if (ownLayers.length === 0 && circuitRows.length === 0) return { kind: 'skip' };
  const segTab = tab('Segments');
  if (!segTab || !tab('Nodes')) return { kind: 'no-bones', title: t.title, tableId: t.id };
  if (/TRUNCATED/.test(t.description ?? '')) {
    limits.push(
      'its table description says a tab is TRUNCATED: the drawing has more than the table holds',
    );
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
    for (let offset = 0; offset < MAX_SEGMENTS; offset += PAGE) {
      const r = await q(
        `SELECT ${['Layer', 'Handle', 'X1', 'Y1', 'X2', 'Y2', 'Length', 'Node 1', 'Node 2'].map(ident).join(', ')} FROM ${ident(segTab.viewName)} WHERE ${ident('Layer')} IN (${inList}) LIMIT ${PAGE} OFFSET ${offset}`,
      );
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
      if (offset + PAGE >= MAX_SEGMENTS) {
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
  const nodeCols = ['Node', 'X', 'Y', 'Degree', 'Kind', 'Block', 'Block handle', 'Layers'];
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
      `SELECT ${nodeCols.map(ident).join(', ')} FROM ${ident(nodesTab.viewName)} WHERE ${ident('Node')} IN (${ids.slice(i, i + 500).join(', ')})`,
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
      `SELECT ${nodeCols.map(ident).join(', ')} FROM ${ident(nodesTab.viewName)} WHERE ${ident('Block handle')} IN (${bridgeHandles
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
  let near = nearFromDescription(t.description);
  if (!near) {
    // The sidecar's own rule (dwg_bones.extent_diagonal): the box of the
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
  const inBox = `${ident('X')} BETWEEN ${box.minX} AND ${box.maxX} AND ${ident('Y')} BETWEEN ${box.minY} AND ${box.maxY}`;

  const inserts: InsertRow[] = [];
  const insTab = tab('Inserts');
  if (insTab) {
    const handles = bridgeHandles.length
      ? ` OR ${ident('Handle')} IN (${bridgeHandles.map(lit).join(', ')})`
      : '';
    const r = await q(
      `SELECT ${['Block', 'Layer', 'Handle', 'X', 'Y', 'Min X', 'Min Y', 'Max X', 'Max Y'].map(ident).join(', ')} FROM ${ident(insTab.viewName)} WHERE (${inBox})${handles} LIMIT ${MAX_NEAR_ROWS}`,
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
    if (r.truncated)
      limits.push(
        `more than ${MAX_NEAR_ROWS} blocks around the circuit; the rest were not looked at`,
      );
  }
  const texts: TextRow[] = [];
  const textTab = tab('Texts');
  if (textTab) {
    const r = await q(
      `SELECT ${['Text', 'Layer', 'X', 'Y'].map(ident).join(', ')} FROM ${ident(textTab.viewName)} WHERE ${inBox} LIMIT ${MAX_NEAR_ROWS}`,
    );
    for (const row of r.rows)
      texts.push({ text: text(row[0]), layer: text(row[1]), x: num(row[2]), y: num(row[3]) });
    if (r.truncated)
      limits.push(
        `more than ${MAX_NEAR_ROWS} labels around the circuit; the rest were not looked at`,
      );
  }
  const blocks: BlockRow[] = [];
  const blockTab = tab('Blocks');
  if (blockTab) {
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
    const byHandle = named.length ? ` OR ${ident('Handle')} IN (${named.map(lit).join(', ')})` : '';
    const r = await q(
      `SELECT * FROM ${ident(blockTab.viewName)} WHERE (${inBox})${byHandle} LIMIT ${MAX_NEAR_ROWS}`,
    );
    for (const o of asObjects(r)) {
      const attribs: Record<string, string> = {};
      for (const [k, v] of Object.entries(o)) {
        if (['Block', 'Layer', 'Handle', 'X', 'Y'].includes(k) || k.startsWith('_')) continue;
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
    if (r.truncated)
      limits.push(
        `more than ${MAX_NEAR_ROWS} attribute blocks around the circuit; the rest were not looked at`,
      );
  }

  return {
    kind: 'sheet',
    sheet: {
      tableId: t.id,
      title: t.title,
      sourceFileId: t.sourceFileId,
      url: nodeUrl(t.id),
      circuitLayers: layerNames,
      circuitRows,
      segments,
      nodes: [...byId.values()],
      inserts,
      texts,
      blocks,
      near,
      limits,
    },
  };
}

function emptySheet(
  t: CandidateTable,
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
