/**
 * Decision trace v1: the per-turn record of what each context stage
 * considered, kept and dropped, and why (types: ContextTrace in
 * @mantle/client-types). One builder serves the responder's auto-context
 * (loadConversationContext) and the search_chunks tool.
 *
 * Observation only. Nothing here may change what a caller sends to the model:
 * the builder reads the lists the stages produced and never hands one back.
 * Compact by design (ids, rounded numbers, reason codes; no text), so the
 * snapshot stays far under the tracing layer's 64 KB step ceiling.
 */
import type {
  ContextTrace,
  ContextTraceArm,
  ContextTraceRow,
  ContextTraceStage,
} from '@mantle/client-types';

/** Most rows one trace keeps. A full turn is about 10 facts + 8 prefs + 5
 *  hits + a passage pool of up to 100 + Journal picks; 150 full rows are
 *  under 32 KB of JSON (a usual turn is 30 to 60 rows, under 10 KB). Kept
 *  rows go first when the cap bites. */
export const TRACE_ROW_CAP = 150;

/** Passage provenance from searchChunksExplained (1-based arm ranks). */
export type ChunkArms = { vr?: number; kr?: number; rescued?: boolean };

export const round3 = (n: number | null | undefined): number | null =>
  typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The arm a passage came from, read off its ranks. */
export function armOf(a: ChunkArms | undefined): ContextTraceArm {
  if (!a) return 'vector';
  if (a.vr !== undefined && a.kr !== undefined) return 'both';
  if (a.kr !== undefined) return 'keyword';
  return 'vector';
}

/** The trace row fields for a passage's provenance. */
export function armFields(a: ChunkArms | undefined): Partial<ContextTraceRow> {
  return {
    arm: armOf(a),
    ...(a?.vr !== undefined ? { vr: a.vr } : {}),
    ...(a?.kr !== undefined ? { kr: a.kr } : {}),
    ...(a?.rescued ? { rescued: true as const } : {}),
  };
}

/** A Jev threshold as a reason code: `judge:<1.5`. */
export const judgeWhy = (threshold: number): string => `judge:<${round2(threshold)}`;

export class ContextTraceBuilder {
  private readonly rows = new Map<string, ContextTraceRow>();
  private readonly stages: ContextTrace['stages'] = [];
  private search: ContextTrace['search'];
  private readonly t0 = Date.now();
  private lapAt = Date.now();

  /** Milliseconds since the last lap (or the start), and restart the lap. */
  lap(): number {
    const now = Date.now();
    const ms = now - this.lapAt;
    this.lapAt = now;
    return ms;
  }

  /** Record a stage. `ms` defaults to the time since the last lap. */
  stage(name: ContextTraceStage, input: number, output: number, ms?: number, note?: string): void {
    this.stages.push({
      name,
      in: input,
      out: output,
      ms: ms ?? this.lap(),
      ...(note ? { note } : {}),
    });
  }

  setSearch(search: NonNullable<ContextTrace['search']>): void {
    this.search = search;
  }

  /** Add a candidate. A second add for the same block + key is ignored (the
   *  first sighting holds the rank and provenance). */
  add(row: ContextTraceRow): void {
    const id = `${row.b}|${row.k}`;
    if (this.rows.has(id)) return;
    this.rows.set(id, clean(row));
  }

  has(b: ContextTraceRow['b'], k: string): boolean {
    return this.rows.has(`${b}|${k}`);
  }

  /** Change a candidate's fields (the outcome, a score, a shadow verdict).
   *  An unknown key is ignored: a stage cannot invent a candidate here. */
  set(b: ContextTraceRow['b'], k: string, patch: Partial<ContextTraceRow>): void {
    const id = `${b}|${k}`;
    const row = this.rows.get(id);
    if (row) this.rows.set(id, clean({ ...row, ...patch }));
  }

  /** Drop a candidate at a stage, when it is still kept. Shadow mode records
   *  the verdict in `would` and leaves the outcome as it was. */
  drop(
    b: ContextTraceRow['b'],
    k: string,
    at: ContextTraceStage,
    why: string,
    mode: 'live' | 'shadow' = 'live',
  ): void {
    const row = this.rows.get(`${b}|${k}`);
    if (!row || row.out !== 'kept') return;
    if (mode === 'shadow') this.set(b, k, { would: why });
    else this.set(b, k, { out: 'dropped', at, why });
  }

  /** Attach a Jev score to a candidate. */
  score(b: ContextTraceRow['b'], k: string, s: number): void {
    this.set(b, k, { s: round2(s) });
  }

  toJSON(cap = TRACE_ROW_CAP): ContextTrace {
    const all = [...this.rows.values()];
    const kept = all.filter((r) => r.out === 'kept');
    const dropped = all.filter((r) => r.out !== 'kept');
    const rows = [...kept, ...dropped].slice(0, Math.max(0, cap));
    return {
      v: 1,
      stages: this.stages,
      ...(this.search ? { search: this.search } : {}),
      rows,
      ...(all.length > rows.length ? { more: all.length - rows.length } : {}),
      ms: Date.now() - this.t0,
    };
  }
}

/** Round the numbers and leave out empty optional fields. */
function clean(row: ContextTraceRow): ContextTraceRow {
  const out: ContextTraceRow = { b: row.b, k: row.k, out: row.out, at: row.at, why: row.why };
  if (row.arm) out.arm = row.arm;
  if (row.rank !== undefined) out.rank = row.rank;
  if (row.vr !== undefined) out.vr = row.vr;
  if (row.kr !== undefined) out.kr = row.kr;
  if (row.rescued) out.rescued = true;
  if (row.d !== undefined) out.d = round3(row.d);
  if (row.rd !== undefined && row.rd !== null) {
    const rd = round3(row.rd);
    if (rd !== null && rd !== out.d) out.rd = rd;
  }
  if (row.s !== undefined) out.s = row.s;
  if (row.would) out.would = row.would;
  return out;
}
