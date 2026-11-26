/**
 * Price the stored model-call steps that were recorded at $0 though the
 * call was paid (docs/spend-recording.md, "Backfill of old $0 steps").
 *
 * Until 2026-11-26 a call could be recorded with its tokens and a cost of 0:
 * an adapter left the provider's billed cost behind, or the price table had
 * no row for the id the route recorded. The fix prices new calls. This task
 * is for the rows already stored: for each step with usage, a recorded cost
 * of exactly 0, and a price by TODAY'S rules, it writes the cost and adds
 * the same amount to every stored total built from that step.
 *
 * The cost it writes is the LIST PRICE from the stored token counts
 * (`priceUsage`, the live path's own code), never the billed cost: the bill
 * is gone, and a list price knows no discount, no cache write and no price
 * tier. Each step it changes is marked (`meta.cost_backfill`: the amount,
 * the basis `list_price`, the time), so the change can be found, counted
 * and undone. A cost above 0 is never touched.
 *
 * What it leaves at $0, and counts:
 * - a free route (the `local` provider, a `:free` id);
 * - a step with a timed-out call (no usage came back);
 * - a model with no price row (still unpriced);
 * - a step whose few tokens round to $0;
 * - a step of the shape from before the one recorder (tokens on the meta,
 *   no `cost_micro_usd` key). Its cost reached the trace total by another
 *   path, so a write here could count it twice.
 *
 * Stored copies of a cost, and what happens to each:
 * - `trace_steps.meta.cost_micro_usd`: written, with the mark;
 * - `traces.cost_micro_usd`: plus the sum of its steps' amounts;
 * - `run_items.cost_micro_usd` (a copy of the item's trace total, by
 *   `trace_ref`): plus the same;
 * - `runs.spent_micro_usd` (the sum of its items' costs): plus the same. No
 *   pause is raised here; a running run over its budget pauses at its next
 *   item, as the engine always does;
 * - `meta.child_cost_micro_usd` on a parent's delegation step, and a cost
 *   written into a step's output or a pending question: left. Each is a
 *   note of what was known at that moment, nothing sums it, and the child
 *   trace it points at holds the corrected total.
 * Token counts and the member token budget are never changed.
 *
 * It runs while the box works: a keyset walk over `trace_steps` by id, one
 * short transaction per batch, and only steps of a trace that closed more
 * than an hour ago (the live recorder writes a running trace's totals as
 * absolute values, and a run item copies its trace's cost just after the
 * close). Stop it at any point and run it again: a marked step is never
 * read twice, so a second run changes nothing.
 *
 * Output is counts, model ids and provider ids only: safe on a client box.
 */
import { and, inArray, sql, type SQL } from 'drizzle-orm';
import { db, runItems, runs, traces, traceSteps } from '@mantle/db';
import { isFreeCall, priceUsage, type UnitKind } from '@mantle/tracing';

/** The meta key of the mark. Its value: `{ micro_usd, basis, at }`. */
export const MARK = 'cost_backfill';
/** What a backfilled cost is: the list price of the stored token counts. */
export const BASIS = 'list_price';

/** The two constants as SQL literals (the same text; a test holds them equal). */
const MARK_SQL = sql`'cost_backfill'`;
const BASIS_SQL = sql`'list_price'`;

const UNIT_KINDS: readonly UnitKind[] = ['characters', 'audio_seconds', 'images'];

/** One stored step, as the walk reads it. */
export type StepRow = {
  id: string;
  traceId: string;
  meta: Record<string, unknown>;
  /** `input.provider`: the route a step names in its input, for a meta from
   *  before the recorder wrote `provider`. */
  inputProvider: string | null;
  startedAt: Date | string | null;
};

/** Why a step stays as it is. */
export type Leave =
  | 'has_cost'
  | 'old_shape'
  | 'timed_out'
  | 'no_model'
  | 'no_usage'
  | 'free'
  | 'unpriced'
  | 'rounds_to_zero';

export type StepUsage = {
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
};

export type Choice =
  ({ act: 'price'; microUsd: number } & StepUsage) | ({ act: 'leave'; why: Leave } & StepUsage);

/** A stored count: a whole number of 0 or more, else 0. Never a guess. */
function count(v: unknown): number {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** Pure: the route, the model and the token counts a stored step holds. */
export function usageOf(row: Pick<StepRow, 'meta' | 'inputProvider'>): StepUsage {
  const meta = row.meta ?? {};
  return {
    // The provider the recorder wrote; before it did, the route in the
    // step's input, or the adapter's name (`openrouter-vision`: its first
    // word).
    provider:
      text(meta.provider) || text(row.inputProvider) || text(meta.adapter).split('-')[0] || '',
    model: text(meta.model),
    tokensIn: count(meta.tokens_in ?? meta.tokensIn),
    tokensOut: count(meta.tokens_out ?? meta.tokensOut),
  };
}

/**
 * Pure: what to do with one stored step. The price is the live recorder's
 * own (`priceUsage`), on the step's summed usage and its model.
 */
export function chooseForStep(row: Pick<StepRow, 'meta' | 'inputProvider'>): Choice {
  const meta = row.meta ?? {};
  const usage = usageOf(row);
  const { provider, model, tokensIn, tokensOut } = usage;
  const leave = (why: Leave): Choice => ({ act: 'leave', why, ...usage });

  if (MARK in meta || count(meta.cost_micro_usd) > 0) return leave('has_cost');
  // No recorded cost at all: the shape from before the one recorder.
  if (!('cost_micro_usd' in meta)) return leave('old_shape');
  if (count(meta.timed_out) > 0) return leave('timed_out');
  const kind = UNIT_KINDS.find((k) => count(meta[k]) > 0);
  const units = kind ? { kind, count: count(meta[kind]) } : undefined;
  if (tokensIn + tokensOut === 0 && !units) return leave('no_usage');
  if (!model) return leave('no_model');
  if (isFreeCall(provider, model)) return leave('free');
  const { costMicroUsd, priced } = priceUsage({
    capability: 'chat',
    provider,
    model,
    inputTokens: tokensIn,
    outputTokens: tokensOut,
    cacheReadTokens: count(meta.cache_read),
    ...(units ? { units } : {}),
  });
  if (!priced) return leave('unpriced');
  if (costMicroUsd <= 0) return leave('rounds_to_zero');
  return { act: 'price', microUsd: costMicroUsd, ...usage };
}

/** One line of the report: a provider and model, summed. */
export type ModelLine = StepUsage & { steps: number; microUsd: number };

export type Tally = {
  /** Steps the walk read (candidates only, never the whole table). */
  read: number;
  /** To price (dry run) or priced (apply), per provider and model. */
  price: Map<string, ModelLine>;
  /** Not priced, with usage, per reason, provider and model: `unpriced`,
   *  `old_shape`, `no_model`. */
  cannot: Map<string, ModelLine & { why: Leave }>;
  /** Steps left for another reason, by reason. */
  left: Partial<Record<Leave, number>>;
  traces: Set<string>;
  first: Date | null;
  last: Date | null;
};

export function newTally(): Tally {
  return {
    read: 0,
    price: new Map(),
    cannot: new Map(),
    left: {},
    traces: new Set(),
    first: null,
    last: null,
  };
}

const CANNOT: ReadonlySet<Leave> = new Set(['unpriced', 'old_shape', 'no_model']);

function addLine<T extends ModelLine>(map: Map<string, T>, key: string, make: () => T, c: Choice) {
  const line = map.get(key) ?? make();
  line.steps += 1;
  line.tokensIn += c.tokensIn;
  line.tokensOut += c.tokensOut;
  if (c.act === 'price') line.microUsd += c.microUsd;
  map.set(key, line);
}

/** Pure: add one step's choice to the tally. */
export function tallyStep(t: Tally, row: StepRow, c: Choice): void {
  t.read += 1;
  const zero = { provider: c.provider, model: c.model, tokensIn: 0, tokensOut: 0, steps: 0 };
  if (c.act === 'price') {
    addLine(t.price, `${c.provider}\n${c.model}`, () => ({ ...zero, microUsd: 0 }), c);
    t.traces.add(row.traceId);
    const at = row.startedAt ? new Date(row.startedAt) : null;
    if (at && !Number.isNaN(at.getTime())) {
      if (!t.first || at < t.first) t.first = at;
      if (!t.last || at > t.last) t.last = at;
    }
  } else if (CANNOT.has(c.why)) {
    const key = `${c.why}\n${c.provider}\n${c.model}`;
    addLine(t.cannot, key, () => ({ ...zero, microUsd: 0, why: c.why }), c);
  } else {
    t.left[c.why] = (t.left[c.why] ?? 0) + 1;
  }
}

export function totalMicroUsd(t: Tally): number {
  let sum = 0;
  for (const l of t.price.values()) sum += l.microUsd;
  return sum;
}

const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(4)}`;
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : 'none');

const WHY_TEXT: Partial<Record<Leave, string>> = {
  unpriced: 'no price row',
  old_shape: 'old shape, no recorded cost',
  no_model: 'no model on the step',
  free: 'free route',
  timed_out: 'timed out',
  rounds_to_zero: 'rounds to $0',
  no_usage: 'no usage',
  has_cost: 'has a cost',
};

/** Pure: the report. Numbers, provider ids and model ids only. */
export function reportLines(
  t: Tally,
  verb: 'to price' | 'priced' | 'to undo' | 'undone',
): string[] {
  const out: string[] = [];
  const steps = [...t.price.values()].reduce((a, l) => a + l.steps, 0);
  out.push(`steps read: ${t.read}`);
  out.push(`date range of the steps ${verb}: ${day(t.first)} to ${day(t.last)}`);
  out.push(`${verb}, per provider and model (list price, not the billed cost):`);
  const lines = [...t.price.values()].sort((a, b) => b.microUsd - a.microUsd);
  for (const l of lines) {
    out.push(
      `  ${l.provider || '(no provider)'}  ${l.model}  steps ${l.steps}  tokens in ${l.tokensIn}  out ${l.tokensOut}  ${usd(l.microUsd)}`,
    );
  }
  if (lines.length === 0) out.push('  none');
  if (t.cannot.size > 0) {
    out.push('not priced, left at $0, per reason, provider and model:');
    const cannot = [...t.cannot.values()].sort((a, b) => b.tokensIn - a.tokensIn);
    for (const l of cannot) {
      out.push(
        `  ${WHY_TEXT[l.why]}  ${l.provider || '(no provider)'}  ${l.model || '(no model)'}  steps ${l.steps}  tokens in ${l.tokensIn}  out ${l.tokensOut}`,
      );
    }
  }
  const left = Object.entries(t.left)
    .map(([why, n]) => `${WHY_TEXT[why as Leave] ?? why} ${n}`)
    .join('; ');
  if (left) out.push(`left as they are: ${left}`);
  out.push(`total ${verb}: ${steps} steps in ${t.traces.size} traces, ${usd(totalMicroUsd(t))}`);
  return out;
}

/** Optional bounds of a run. `until` is exclusive. */
export type Bounds = { since?: Date; until?: Date; model?: string };

function boundsSql(b: Bounds): SQL {
  const parts: SQL[] = [];
  if (b.since) parts.push(sql`and s.started_at >= ${b.since.toISOString()}::timestamptz`);
  if (b.until) parts.push(sql`and s.started_at < ${b.until.toISOString()}::timestamptz`);
  if (b.model) parts.push(sql`and s.meta->>'model' = ${b.model}`);
  return parts.length > 0 ? sql.join(parts, sql` `) : sql``;
}

const SELECT = sql`select s.id, s.trace_id as "traceId", s.meta,
                          s.input->>'provider' as "inputProvider", s.started_at as "startedAt"
                     from trace_steps s`;

/** The next page of steps to look at, by id: a recorded cost of exactly 0,
 *  or tokens with no recorded cost (counted, never priced); not marked; of
 *  a trace that closed more than an hour ago. */
async function candidatePage(after: string | null, limit: number, b: Bounds): Promise<StepRow[]> {
  return (await db.execute(sql`
    ${SELECT}
     join traces t on t.id = s.trace_id
    where ${after ? sql`s.id > ${after}::uuid` : sql`true`}
      and not s.meta ? ${MARK_SQL}
      and (s.meta->>'cost_micro_usd' = '0'
           or (not s.meta ? 'cost_micro_usd' and (s.meta ? 'tokens_in' or s.meta ? 'tokensIn')))
      and t.finished_at < now() - interval '1 hour'
      ${boundsSql(b)}
    order by s.id
    limit ${limit}
  `)) as unknown as StepRow[];
}

/** The next page of marked steps, by id. */
async function markedPage(after: string | null, limit: number, b: Bounds): Promise<StepRow[]> {
  return (await db.execute(sql`
    ${SELECT}
    where ${after ? sql`s.id > ${after}::uuid` : sql`true`}
      and s.meta ? ${MARK_SQL}
      ${boundsSql(b)}
    order by s.id
    limit ${limit}
  `)) as unknown as StepRow[];
}

/** What the batches of a run changed. A trace, run item or run whose
 *  steps fell in two batches is counted once per batch. */
export type Written = {
  steps: number;
  microUsd: number;
  traces: number;
  runItems: number;
  runs: number;
};

type Amount = { id: string; microUsd: number };

const NOTHING: Written = { steps: 0, microUsd: 0, traces: 0, runItems: 0, runs: 0 };

/** A map of id to amount as one jsonb value, read by a row's own id: the
 *  amount of that row, as text. One value for the whole batch. */
function amountOf(map: Map<string, number>, id: unknown): SQL {
  return sql`(${JSON.stringify(Object.fromEntries(map))}::jsonb->>(${id}::text))`;
}

/**
 * Write one batch, in one short transaction, so a step and the totals built
 * from it move together or not at all. `sign` +1 writes the prices and adds
 * them to the totals; -1 is the undo: the cost back to 0, the mark gone, the
 * mark's amount out of every total.
 *
 * A step is priced only while its cost is still 0 and it has no mark (two
 * runs at once cannot price it twice), and undone only while its cost is
 * still exactly what its mark records.
 */
async function writeBatch(rows: readonly Amount[], sign: 1 | -1): Promise<Written> {
  if (rows.length === 0) return { ...NOTHING };
  const byStep = new Map(rows.map((r) => [r.id, r.microUsd]));
  const amount = amountOf(byStep, traceSteps.id);
  const op = sign === 1 ? sql`+` : sql`-`;
  return db.transaction(async (tx) => {
    const changed = await tx
      .update(traceSteps)
      .set({
        meta:
          sign === 1
            ? sql`${traceSteps.meta} || jsonb_build_object(
                    'cost_micro_usd', ${amount}::bigint,
                    ${MARK_SQL}, jsonb_build_object(
                      'micro_usd', ${amount}::bigint,
                      'basis', ${BASIS_SQL},
                      'at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))`
            : sql`(${traceSteps.meta} - ${MARK_SQL}) || jsonb_build_object('cost_micro_usd', 0)`,
      })
      .where(
        and(
          inArray(
            traceSteps.id,
            rows.map((r) => r.id),
          ),
          sign === 1
            ? sql`${traceSteps.meta}->>'cost_micro_usd' = '0' and not ${traceSteps.meta} ? ${MARK_SQL}`
            : sql`${traceSteps.meta}->${MARK_SQL}->>'micro_usd' = ${amount}
                  and ${traceSteps.meta}->>'cost_micro_usd' = ${amount}`,
        ),
      )
      .returning({ id: traceSteps.id, traceId: traceSteps.traceId });
    if (changed.length === 0) return { ...NOTHING };

    // The trace totals: each trace by the sum of its changed steps.
    const byTrace = new Map<string, number>();
    let microUsd = 0;
    for (const c of changed) {
      const a = byStep.get(c.id) ?? 0;
      microUsd += a;
      byTrace.set(c.traceId, (byTrace.get(c.traceId) ?? 0) + a);
    }
    const traceIds = [...byTrace.keys()];
    const moved = await tx
      .update(traces)
      .set({
        costMicroUsd: sql`${traces.costMicroUsd} ${op} ${amountOf(byTrace, traces.id)}::bigint`,
      })
      .where(inArray(traces.id, traceIds))
      .returning({ id: traces.id });

    // The copies of a trace total: the run item that took it (by trace_ref)
    // and its run's spent amount. The run row first, as the engine locks.
    const items = await tx
      .select({ id: runItems.id, runId: runItems.runId, traceRef: runItems.traceRef })
      .from(runItems)
      .where(inArray(runItems.traceRef, traceIds));
    const byRun = new Map<string, number>();
    for (const i of items) {
      byRun.set(i.runId, (byRun.get(i.runId) ?? 0) + (byTrace.get(i.traceRef ?? '') ?? 0));
    }
    if (items.length > 0) {
      await tx
        .update(runs)
        .set({
          spentMicroUsd: sql`${runs.spentMicroUsd} ${op} ${amountOf(byRun, runs.id)}::bigint`,
        })
        .where(inArray(runs.id, [...byRun.keys()]));
      const delta = sql`${amountOf(byTrace, runItems.traceRef)}::bigint`;
      await tx
        .update(runItems)
        .set({
          costMicroUsd:
            sign === 1
              ? sql`coalesce(${runItems.costMicroUsd}, 0) + ${delta}`
              : // An item with no cost holds NULL, never 0 (the engine's rule).
                sql`nullif(coalesce(${runItems.costMicroUsd}, 0) - ${delta}, 0)`,
        })
        .where(
          inArray(
            runItems.id,
            items.map((i) => i.id),
          ),
        );
    }
    return {
      steps: changed.length,
      microUsd,
      traces: moved.length,
      runItems: items.length,
      runs: byRun.size,
    };
  });
}

export type BackfillOptions = {
  /** `price`: write list prices. `undo`: take the marked ones out again. */
  mode: 'price' | 'undo';
  /** false (the default of the CLI): read and count, change nothing. */
  apply: boolean;
  bounds?: Bounds;
  /** Steps per page and per transaction. */
  batch?: number;
  /** Called after each page of an apply, with the running totals. */
  onBatch?: (done: Written) => void;
};

export type BackfillResult = { tally: Tally; written: Written };

export const DEFAULT_BATCH = 1000;
export const MAX_BATCH = 5000;

/**
 * Walk the steps once, by id. A dry run changes nothing. An apply writes
 * one transaction per page; a stop between pages loses nothing, and the next
 * run goes on with what is left.
 */
export async function runSpendBackfill(opts: BackfillOptions): Promise<BackfillResult> {
  const bounds = opts.bounds ?? {};
  const batch = Math.min(MAX_BATCH, Math.max(1, Math.floor(opts.batch ?? DEFAULT_BATCH)));
  const tally = newTally();
  const total: Written = { steps: 0, microUsd: 0, traces: 0, runItems: 0, runs: 0 };
  let after: string | null = null;
  for (;;) {
    const page: StepRow[] =
      opts.mode === 'price'
        ? await candidatePage(after, batch, bounds)
        : await markedPage(after, batch, bounds);
    if (page.length === 0) break;
    after = page[page.length - 1]!.id;
    const todo: Array<{ id: string; microUsd: number }> = [];
    for (const row of page) {
      if (opts.mode === 'undo') {
        // The mark is the record: its amount is what comes out.
        const mark = row.meta[MARK] as { micro_usd?: unknown } | undefined;
        const microUsd = count(mark?.micro_usd);
        tallyStep(tally, row, { ...usageOf(row), act: 'price', microUsd });
        if (microUsd > 0) todo.push({ id: row.id, microUsd });
        continue;
      }
      const choice = chooseForStep(row);
      tallyStep(tally, row, choice);
      if (choice.act === 'price') todo.push({ id: row.id, microUsd: choice.microUsd });
    }
    if (opts.apply && todo.length > 0) {
      const w = await writeBatch(todo, opts.mode === 'price' ? 1 : -1);
      for (const k of Object.keys(total) as Array<keyof Written>) total[k] += w[k];
      opts.onBatch?.({ ...total });
    }
    if (page.length < batch) break;
  }
  return { tally, written: total };
}
