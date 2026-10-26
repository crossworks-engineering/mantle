/**
 * The fail-open branches (plan v3.2 S4a): the five places where code with no
 * system actor bound still gets a yes or the system pool. S4a only counts
 * them; S4b refuses them once every box reads 0. Each hit writes one miss
 * row (actor_check_misses, check 'fail-open:<site>', detail the calling
 * file), counted on the box by scripts/arch-scoreboard-box.sh.
 *
 * Cost: a hit asks one map, by site, before any stack is taken; a site
 * takes at most one stack a minute, so a busy branch never pays a stack
 * per call and a second caller of the same site is still found later. The
 * stack gives the calling file; one row per site and calling file an
 * hour in a process, marked only once a writer took it. Changes no answer:
 * it only writes rows.
 *
 * Imports nothing from this package (viewer.ts and the gateway modules both
 * call it; fail-open-sites.ts holds what makes a gateway/scope-answers.ts or
 * gateway/write-route.ts branch a hit).
 */
import { env } from '@mantle/config';

/** The sites, in the order of the plan's S4a list. `raw-write` has no
 *  caller: a scoped raw write goes to the write role, which refuses a
 *  table it holds no right on (gateway/write-route.ts). Kept so the row
 *  an image one release back writes still has its name. */
export const FAIL_OPEN_SITES = [
  'scope-holds-admin',
  'scope-has-area',
  'typed-write',
  'raw-write',
  'turn-exit',
  'system-db',
] as const;
export type FailOpenSite = (typeof FAIL_OPEN_SITES)[number];

/**
 * The tables a scoped typed write still sends to the system pool with no
 * scopedSystemWrite reason on their access matrix row, measured by the
 * full vitest run (docs/fail-open.md): each is to be moved (the write role,
 * systemDb, an Admin area's areaSystem) or named before S4b refuses it.
 * vitest.setup.ts fails a test whose typed-write hit names any other
 * table, so the list only goes down (fail-open.test.ts pins it).
 */
export const SCOPED_SYSTEM_WRITES_LEFT: readonly string[] = Object.freeze([
  // The approval queue: an asking turn parks its call, an approver decides
  // it (packages/tools pending-queue.ts, pending.ts, toolsmith/groups.ts).
  'public.pending_tool_calls',
  // The one conversation store: a login turn's rows over MCP
  // (packages/runtime agent/conversation.ts).
  'public.assistant_messages',
]);

/** The miss row of a hit, as mantle_actor_miss_log takes it (actor.ts
 *  ActorMiss): check 'fail-open:<site>', the actor's kind, the calling
 *  file. */
export type FailOpenRow = { source: 'ts'; check: string; actor: string; detail: string };

/** How long a site waits after a stack before it takes the next one. */
const STACK_EVERY_MS = 60_000;
/** How long a site and file wait before their row is written again, so a
 *  process that keeps hitting keeps showing in the box count's window (as
 *  actor.ts writes an actor miss at most once an hour per key). */
const ROW_EVERY_MS = 3_600_000;

const lastStack = new Map<FailOpenSite, number>();
const rowWritten = new Map<string, number>();
let rowWriter: ((row: FailOpenRow) => boolean) | null = null;
const testHits: { site: FailOpenSite; actor: string; table?: string }[] = [];

/** fail-open-sites.ts hands the writer of miss rows here (actor.ts's, the
 *  row written later on another connection); tests hand their own. It
 *  answers whether it took the row (false before the pool has a writer). */
export function setFailOpenWriter(fn: (row: FailOpenRow) => boolean): void {
  rowWriter = fn;
}

/**
 * Note a fail-open hit at `site`. `actor` is the bound actor's kind ('' for
 * none); the caller of a site with a system actor bound does not call this.
 * `caller` takes the stack and names the calling file; it runs only after
 * the site's map lookup lets it. `table`: the table a write site sent to
 * the system pool. Under vitest every hit is also kept, before the lookup
 * and with no stack (takeFailOpenHits); a hit never fails a test.
 */
export function noteFailOpen(
  site: FailOpenSite,
  actor: string,
  caller: () => string | null,
  table?: string,
): void {
  if (env('NODE_ENV') === 'test') testHits.push({ site, actor, ...(table ? { table } : {}) });
  const now = Date.now();
  const last = lastStack.get(site);
  if (last !== undefined && now - last < STACK_EVERY_MS) return;
  lastStack.set(site, now);
  // A raw write runs when its query is awaited, often with no app frame on
  // the stack: its table names it then.
  const file = caller() ?? (table ? `unknown caller, table ${table}` : 'unknown caller');
  const key = `${site}\0${file}`;
  const written = rowWritten.get(key);
  if (written !== undefined && now - written < ROW_EVERY_MS) return;
  // Marked only when a writer took the row: a hit before the pool exists
  // is written by a later one.
  if (!rowWriter?.({ source: 'ts', check: `fail-open:${site}`, actor, detail: file })) return;
  if (rowWritten.size > 5_000) rowWritten.clear();
  rowWritten.set(key, now);
}

/** Tests: every hit since the last call (site, actor kind, table). */
export function takeFailOpenHits(): { site: FailOpenSite; actor: string; table?: string }[] {
  return testHits.splice(0);
}

/**
 * The suite's rehearsal of S4b (vitest.setup.ts, after each test): the
 * tables of `hits` whose typed-write hit names no table still left to
 * decide (SCOPED_SYSTEM_WRITES_LEFT). A test with any fails. A named
 * table (scopedSystemWrite) is no hit for a login, so it is here only for
 * another actor's write.
 */
export function unnamedScopedWrites(
  hits: readonly { site: FailOpenSite; table?: string }[],
): string[] {
  return [
    ...new Set(
      hits
        .filter((h) => h.site === 'typed-write')
        .map((h) => h.table ?? '?')
        .filter((t) => !SCOPED_SYSTEM_WRITES_LEFT.includes(t)),
    ),
  ];
}

/** Tests: forget the lookups and the rows written (a fresh process). */
export function resetFailOpenForTest(): void {
  lastStack.clear();
  rowWritten.clear();
  testHits.length = 0;
}
