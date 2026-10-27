/**
 * The image check overview of a traced P&ID canvas (DWG bones phase 6 v2):
 * what the app shows beside a saved drawing, outside its frame, and what
 * present_get returns as `image_checks`. One read, no spend.
 *
 * The canvas's data block is read once (size first, one linear scan: the
 * template's own reader), and only a `pid` drawing that names its source
 * (`trace`: the circuit and the drawing tables circuit_trace read) gets an
 * overview. Each named table is looked up in the caller's scope and its
 * Checks tab read through the table_sql surface as the caller, so a table
 * the viewer cannot read adds nothing. Per guess, the latest sealed row at
 * the table's current revision (check.ts latestChecks): the answer, the
 * alternative after a no, the reason, the model, the time and the crops'
 * file ids (ordinary Files, opened with the viewer's own rights).
 *
 * An image check is a help, not a guarantee (IMAGE_CHECK_NOTE): this is an
 * overview of what a vision model answered, never a verdict on the drawing,
 * and nothing here compares it with the drawing's own words.
 */
import type {
  PresentCheckItemDTO,
  PresentChecksDTO,
  PresentCircuitChecksDTO,
} from '@mantle/client-types';
import { cropIdsOf, latestChecks, type CheckKind, type StoredCheck } from './check';
import { dwgTablesByIds, readCircuitChecks, type CandidateTable } from './read';
import { IMAGE_CHECK_NOTE } from './workflow';

/** The longest canvas source read for an overview: the canvas cap (the
 *  HTTP save takes 1.1 MB). A larger one is no traced drawing. */
export const OVERVIEW_SOURCE_MAX = 1_100_000;
/** Answers listed per circuit (the counts cover them all). */
export const OVERVIEW_ITEMS_MAX = 200;
/** Circuits a canvas's data names (one today: a trace is one circuit). */
const CIRCUITS_MAX = 4;

const KINDS: readonly CheckKind[] = ['join', 'end', 'link', 'valve'];
const clip = (s: string | undefined, n: number) => (s ?? '').slice(0, n);

/** What a canvas's data says of its source: the circuit and its tables,
 *  or null when it is no traced pid drawing. */
export function traceSourceOf(data: unknown): { circuit: string; tables: string[] } | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (d.template !== 'pid') return null;
  const t = d.trace as { circuit?: unknown; tables?: unknown } | undefined;
  if (!t || typeof t !== 'object' || typeof t.circuit !== 'string' || !t.circuit.trim())
    return null;
  const tables = Array.isArray(t.tables)
    ? t.tables.filter((x): x is string => typeof x === 'string').slice(0, 40)
    : [];
  return { circuit: t.circuit.trim().slice(0, 80), tables };
}

/**
 * The data block of a canvas source, parsed once, or null: the source is
 * held to OVERVIEW_SOURCE_MAX first, then the template's reader finds the
 * one block (an indexOf scan, linear) and parses its JSON.
 */
export async function canvasDataOf(source: string): Promise<unknown> {
  if (source.length > OVERVIEW_SOURCE_MAX) return null;
  if (!source.includes('<meta name="diagram:template"')) return null;
  const { readCanvasData } = await import('@mantle/diagram-templates');
  try {
    return readCanvasData(source);
  } catch {
    return null;
  }
}

export type OverviewDeps = {
  tables?: (ownerId: string, ids: readonly string[]) => Promise<CandidateTable[]>;
  checks?: (
    ownerId: string,
    t: CandidateTable,
    circuit: string,
  ) => Promise<{ rows: StoredCheck[]; cut: boolean } | null>;
};

/** The overview of a canvas's data (null: no traced pid drawing). */
export async function checksOverviewOf(
  ownerId: string,
  data: unknown,
  deps: OverviewDeps = {},
): Promise<PresentChecksDTO> {
  const none: PresentChecksDTO = {
    traced: false,
    note: IMAGE_CHECK_NOTE,
    circuits: [],
    limits: [],
  };
  const src = traceSourceOf(data);
  if (!src) return none;
  const limits: string[] = [];
  const tables = await (deps.tables ?? dwgTablesByIds)(ownerId, src.tables);
  const missing = src.tables.length - tables.length;
  if (missing > 0)
    limits.push(
      `${missing} of the drawing's ${src.tables.length} drawing table${src.tables.length === 1 ? '' : 's'} could not be read (gone, or not shared with you); their checks are not listed.`,
    );
  const items: PresentCheckItemDTO[] = [];
  const counts = { checked: 0, no: 0, unsure: 0 };
  for (const t of tables) {
    const read = await (deps.checks ?? readCircuitChecks)(ownerId, t, src.circuit).catch(
      () => null,
    );
    if (!read) {
      limits.push(`${t.title}: its Checks tab could not be read.`);
      continue;
    }
    if (read.cut)
      limits.push(
        `${t.title}: more image checks of this circuit than one read takes; only the first were read.`,
      );
    const { byKey, stale, unsealed } = latestChecks(t.id, read.rows, t.revision ?? null);
    if (stale)
      limits.push(
        `${t.title}: ${stale} check${stale === 1 ? '' : 's'} of an earlier revision of the drawing ${stale === 1 ? 'is' : 'are'} kept in its Checks tab, not listed.`,
      );
    if (unsealed)
      limits.push(
        `${t.title}: ${unsealed} row${unsealed === 1 ? '' : 's'} in its Checks tab ${unsealed === 1 ? 'carries' : 'carry'} no circuit_verify seal (typed or changed by hand): not listed.`,
      );
    for (const r of byKey.values()) {
      const answer = r.answer === 'yes' || r.answer === 'no' ? r.answer : 'unsure';
      if (answer === 'yes') counts.checked += 1;
      else if (answer === 'no') counts.no += 1;
      else counts.unsure += 1;
      const cell = cropIdsOf(r.crops ?? '');
      items.push({
        kind: (KINDS as readonly string[]).includes(r.kind) ? (r.kind as CheckKind) : 'end',
        tableId: t.id,
        sheet: clip(t.title, 200),
        question: clip(r.question, 600),
        answer,
        ...(answer === 'no' && r.alt ? { alternative: clip(r.alt, 40) } : {}),
        reason: clip(r.reason, 300),
        model: clip(r.model, 120),
        checkedAt: clip(r.checkedAt, 40),
        crops: cell.crops.slice(0, 8),
        ...(cell.overview ? { overview: cell.overview } : {}),
      });
    }
  }
  // Sheet order as the trace named them, then the newest first.
  const order = new Map(tables.map((t, i) => [t.id, i]));
  items.sort(
    (a, b) =>
      (order.get(a.tableId) ?? 0) - (order.get(b.tableId) ?? 0) ||
      (a.checkedAt < b.checkedAt ? 1 : a.checkedAt > b.checkedAt ? -1 : 0),
  );
  const circuit: PresentCircuitChecksDTO = {
    circuit: src.circuit,
    counts,
    items: items.slice(0, OVERVIEW_ITEMS_MAX),
    ...(items.length > OVERVIEW_ITEMS_MAX ? { more: items.length - OVERVIEW_ITEMS_MAX } : {}),
  };
  return {
    traced: true,
    note: IMAGE_CHECK_NOTE,
    circuits: [circuit].slice(0, CIRCUITS_MAX),
    limits,
  };
}

/** The overview of one canvas, read in the caller's scope, or null when
 *  the caller reads no canvas of that id (a 404, as any present route). */
export async function presentChecksOverview(
  ownerId: string,
  presentId: string,
  deps: OverviewDeps = {},
): Promise<PresentChecksDTO | null> {
  const { getPresent } = await import('@mantle/content/presents');
  const p = await getPresent(ownerId, presentId);
  if (!p) return null;
  return checksOverviewOf(ownerId, await canvasDataOf(p.source), deps);
}
