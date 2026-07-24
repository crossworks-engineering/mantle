/**
 * TEST-ONLY kit for the runs workflows (nothing in production imports it).
 *
 * Two pieces, both aimed at the bug class the slice-3 final audit found the
 * hard way (v0.157.14 F1/F4): a durable workflow is re-run FROM THE TOP on
 * crash recovery — journaled steps hand back recorded results, but ordinary
 * glue re-executes against the database as it is NOW. Glue that reads state
 * the workflow itself mutated therefore re-decides on replay, and the classic
 * symptom is a workflow that "succeeds" while silently dropping its work.
 *
 * 1. `makeJournal()` — a `DBOS.runStep` stand-in with real replay semantics.
 *    Pass 1 executes step bodies and records their results; a second call of
 *    the same impl with the SAME journal serves those results back instead of
 *    re-running them. That makes crash recovery reproducible in-process, with
 *    no DBOS, no Postgres and no LLM — so "does this survive a replay?" is an
 *    ordinary unit assertion. `crashAfter` throws once a named step commits,
 *    standing in for the process dying at exactly that instant.
 *
 * 2. `makeFakeDb()` — a drizzle-shaped double covering the query shapes these
 *    workflows use (`select().from().where()`, `update().set().where()
 *    .returning()`). Results are queued PER TABLE, so a test can hand the
 *    first and second read of the same table different rows — which is
 *    exactly how the world looks across a crash (the row the workflow claimed
 *    now reads as claimed). SQL correctness is not the point here and is
 *    covered against real Postgres by `packages/runs/src/engine.test.ts`.
 */

/** Marker thrown by a `crashAfter` journal: the process "died" after the
 *  named step committed. Tests catch it and then replay. */
export class CrashSignal extends Error {
  constructor(step: string) {
    super(`[test] simulated crash after step '${step}'`);
    this.name = 'CrashSignal';
  }
}

export type Journal = {
  /** `DBOS.runStep` stand-in — wire it into the DBOS mock. */
  runStep: <T>(fn: () => Promise<T>, opts: { name: string }) => Promise<T>;
  /** Start a fresh execution pass (call before each impl invocation). */
  beginPass: () => void;
  /** Step names whose BODY actually executed this pass (vs served from the
   *  journal) — the assertion surface for "it didn't re-run the side effect". */
  executed: string[];
  /** Step names served from the journal this pass (i.e. replayed). */
  replayed: string[];
  /** Every step name recorded so far, in order of first execution. */
  recordedSteps: () => string[];
};

export function makeJournal(opts: { crashAfter?: string } = {}): Journal {
  const recorded = new Map<string, unknown>();
  const order: string[] = [];
  let seen = new Map<string, number>();
  const journal: Journal = {
    executed: [],
    replayed: [],
    beginPass() {
      seen = new Map();
      journal.executed = [];
      journal.replayed = [];
    },
    recordedSteps: () => [...order],
    async runStep<T>(fn: () => Promise<T>, { name }: { name: string }): Promise<T> {
      // Per-pass ordinal: a step name invoked twice in one execution gets two
      // distinct journal slots, mirroring DBOS's sequence numbering.
      const n = (seen.get(name) ?? 0) + 1;
      seen.set(name, n);
      const key = `${name}#${n}`;
      if (recorded.has(key)) {
        journal.replayed.push(name);
        return recorded.get(key) as T;
      }
      const out = await fn();
      recorded.set(key, out);
      order.push(name);
      journal.executed.push(name);
      if (opts.crashAfter === name) throw new CrashSignal(name);
      return out;
    },
  };
  return journal;
}

/** A DBOS double: `runStep` routes to the journal, `registerWorkflow` is the
 *  identity (module load must not need a live DBOS), and the logger/span are
 *  inert. `span` is deliberately undefined — production code reaches it with
 *  `DBOS.span?.` and this keeps that optionality honest. */
export function makeDbosMock(journal: Journal) {
  const logs: Array<{ level: string; message: string }> = [];
  return {
    logs,
    DBOS: {
      registerWorkflow: <T>(fn: T) => fn,
      runStep: journal.runStep,
      span: undefined as undefined,
      logger: {
        info: (m: string) => logs.push({ level: 'info', message: m }),
        warn: (m: string) => logs.push({ level: 'warn', message: m }),
        error: (m: string) => logs.push({ level: 'error', message: m }),
      },
    },
  };
}

export type Row = Record<string, unknown>;

export type FakeDb = {
  /** The object to hand production code as `db`. */
  db: unknown;
  /** Queue result batches for a table, consumed in order by successive reads. */
  queue: (table: string, ...batches: Row[][]) => void;
  /** Tables read/written this run, in order — lets a test assert ORDERING
   *  (e.g. that preconditions were read before the claim ran). */
  reads: string[];
  writes: Array<{ table: string; values: Row }>;
  /** Drizzle-shaped table sentinels to feed the `@mantle/db` mock. */
  table: (name: string) => { __table: string };
};

export function makeFakeDb(): FakeDb {
  const queues = new Map<string, Row[][]>();
  const reads: string[] = [];
  const writes: Array<{ table: string; values: Row }> = [];

  const nameOf = (t: unknown): string =>
    (t as { __table?: string })?.__table ?? String((t as { name?: string })?.name ?? 'unknown');

  const last = new Map<string, Row[]>();
  /** Successive reads of a table consume queued batches in order; once the
   *  queue is spent the LAST batch repeats. Repeating (rather than returning
   *  empty) matches a real database — reading the same row twice gives the
   *  same row — and keeps a test's assertions about BEHAVIOUR from turning
   *  into brittle assertions about how many reads the code happens to make. */
  const take = (table: string): Row[] => {
    reads.push(table);
    const q = queues.get(table);
    if (q && q.length > 0) {
      const batch = q.shift()!;
      last.set(table, batch);
      return batch;
    }
    return last.get(table) ?? [];
  };

  /** Awaitable query terminal: every chain we support resolves to Row[]. */
  const thenable = (produce: () => Row[]) => {
    const self: Record<string, unknown> = {
      then: (res: (v: Row[]) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve()
          .then(() => produce())
          .then(res, rej),
      // Chain links that don't change the fake's behaviour.
      where: () => self,
      limit: () => self,
      orderBy: () => self,
      for: () => self,
      returning: () => self,
      innerJoin: () => self,
      groupBy: () => self,
    };
    return self;
  };

  const db = {
    select: (_fields?: unknown) => ({
      from: (t: unknown) => thenable(() => take(nameOf(t))),
    }),
    update: (t: unknown) => ({
      set: (values: Row) => {
        writes.push({ table: nameOf(t), values });
        return thenable(() => take(nameOf(t)));
      },
    }),
    insert: (t: unknown) => ({
      values: (values: Row) => {
        writes.push({ table: nameOf(t), values });
        return thenable(() => []);
      },
    }),
    execute: () => Promise.resolve([]),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };

  return {
    db,
    queue: (table, ...batches) => queues.set(table, [...(queues.get(table) ?? []), ...batches]),
    reads,
    writes,
    table: (name: string) => ({ __table: name }),
  };
}

/** drizzle-orm double — these workflows only ever pass the results of `and` /
 *  `eq` / `sql` straight back into the (faked) query builder, so inert markers
 *  are enough and keep real drizzle's column validation out of the test. */
export function makeDrizzleMock() {
  const tag = (..._a: unknown[]) => ({ __expr: true });
  return {
    and: tag,
    eq: tag,
    inArray: tag,
    isNull: tag,
    lt: tag,
    asc: tag,
    desc: tag,
    sql: Object.assign((..._a: unknown[]) => ({ __sql: true }), {
      raw: (..._a: unknown[]) => ({ __sql: true }),
    }),
  };
}
