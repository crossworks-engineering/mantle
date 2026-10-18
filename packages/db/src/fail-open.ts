/**
 * The fail-open branches (plan v3.2 S4a): the six places where code with no
 * system actor bound still gets a yes or the system pool. S4a only counts
 * them; S4b refuses them once every box reads 0. Each hit writes one miss
 * row (actor_check_misses, check 'fail-open:<site>', detail the calling
 * file), counted on the box by scripts/arch-scoreboard-box.sh.
 *
 * Cost: a hit asks one map, by site, before any stack is taken; a site
 * takes at most one stack a minute, so a busy branch never pays a stack
 * per call and a second caller of the same site is still found later. The
 * stack gives the calling file; one row per site and calling file in a
 * process. Changes no answer: it only writes rows.
 *
 * Imports nothing from this package (viewer.ts and client.ts both call it;
 * fail-open-sites.ts holds what makes a client.ts branch a hit).
 */
import { env } from '@mantle/config';

/** The sites, in the order of the plan's S4a list. */
export const FAIL_OPEN_SITES = [
  'scope-holds-admin',
  'scope-has-area',
  'typed-write',
  'raw-write',
  'turn-exit',
  'system-db',
] as const;
export type FailOpenSite = (typeof FAIL_OPEN_SITES)[number];

/** The miss row of a hit, as mantle_actor_miss_log takes it (actor.ts
 *  ActorMiss): check 'fail-open:<site>', the actor's kind, the calling
 *  file. */
export type FailOpenRow = { source: 'ts'; check: string; actor: string; detail: string };

/** How long a site waits after a stack before it takes the next one. */
const STACK_EVERY_MS = 60_000;

const lastStack = new Map<FailOpenSite, number>();
const rowKeys = new Set<string>();
let rowWriter: ((row: FailOpenRow) => void) | null = null;
const testHits: { site: FailOpenSite; actor: string; table?: string }[] = [];

/** fail-open-sites.ts hands the writer of miss rows here (actor.ts's, the
 *  row written later on another connection); tests hand their own. */
export function setFailOpenWriter(fn: (row: FailOpenRow) => void): void {
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
  const file = caller() ?? 'unknown caller';
  const key = `${site}\0${file}`;
  if (rowKeys.has(key)) return;
  if (rowKeys.size > 5_000) rowKeys.clear();
  rowKeys.add(key);
  rowWriter?.({ source: 'ts', check: `fail-open:${site}`, actor, detail: file });
}

/** Tests: every hit since the last call (site, actor kind, table). */
export function takeFailOpenHits(): { site: FailOpenSite; actor: string; table?: string }[] {
  return testHits.splice(0);
}

/** Tests: forget the lookups and the rows written (a fresh process). */
export function resetFailOpenForTest(): void {
  lastStack.clear();
  rowKeys.clear();
  testHits.length = 0;
}
