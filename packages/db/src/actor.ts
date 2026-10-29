/**
 * Who a statement runs as (workspaces arch plan v2, section 4 and 20.3;
 * A2a). Every process entry binds its actor once, at its entry
 * (docs/process-inventory.md lists them); everything it awaits carries it. The database learns it as
 * mantle.actor and mantle.write_mode, set by mantle_set_actor (migration
 * 0275) on the app's system pool only, from gateway/actor-sql.ts.
 *
 * The kinds (plan 4.1, 20.3 item 15):
 *  - login(rw): a signed-in user, a read-write key, a peer acting as a login
 *    with Write on. login(ro): a read-only key, a peer with Write off.
 *    login(owner): the owner cases the guide names (the Admin assistant with
 *    no user, a run with no login, the owner's Telegram bot).
 *  - assistant: a workspace assistant with no user asking. Writes nothing.
 *  - link: an open public link. contact: a contact share (writes its app's
 *    data when the share allows it).
 *  - system(reason): a process, an Admin area route, a named repair.
 *  - peer(share): a peer without "Acts as", read-only.
 *
 * A statement with no actor is a miss (actor_check_misses), in TypeScript
 * here and in SQL (the item tables' write triggers). In warn it only logs;
 * in on it is refused: ActorMissingError here, 42501 no_actor in SQL
 * (migration 0277).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { env } from '@mantle/config';
import { RuntimeFaultError, UUID_RE } from '@mantle/std';
import { systemDbCallerOf } from './viewer';

export type WriteMode = 'rw' | 'ro';

export type Actor =
  | { kind: 'login'; mode: 'rw' | 'ro' | 'owner'; loginId: string }
  | { kind: 'assistant'; agentId: string | null }
  | { kind: 'link' }
  | { kind: 'contact'; canWrite: boolean }
  /** `mode: 'ro'`: system work done inside a read-only caller (a read key's
   *  area route, an asSystem in its request) stays read only (systemUnder). */
  | { kind: 'system'; reason: string; mode?: 'ro' }
  | { kind: 'peer'; peerId: string | null };

/** A system reason: lower case, `:` between parts (worker:extract,
 *  repair:page-block-ids). The same pattern as mantle_set_actor's. */
export const SYSTEM_REASON_RE = /^[a-z][a-z0-9:._/@-]{0,119}$/;

/** login(rw | ro | owner) for `loginId`. */
export function loginActor(loginId: string, mode: 'rw' | 'ro' | 'owner' = 'rw'): Actor {
  if (!UUID_RE.test(loginId)) throw new Error('loginActor: loginId must be a uuid');
  return Object.freeze({ kind: 'login', mode, loginId: loginId.toLowerCase() });
}

/** system(reason). */
export function systemActor(reason: string): Actor {
  if (!SYSTEM_REASON_RE.test(reason)) {
    throw new Error(`systemActor: not a reason: ${reason.slice(0, 40)}`);
  }
  return Object.freeze({ kind: 'system', reason });
}

/**
 * system(reason) for work done on behalf of `outer` (the caller's actor):
 * read only when the caller is a read-only caller from outside, so leaving
 * the caller's scope never turns one into a writer. Those callers are
 * login(ro) (a read key, a peer with Write off), a public link and a
 * contact share without can_write. An assistant with no user still does its own system work (its
 * traces, its turn's rows), as a peer(share) does its audit row: they keep
 * write mode rw here. A named repair or backfill does not use this: it
 * writes for any caller (runReadPathWrite, plan 20.3 item 8).
 */
export function systemUnder(reason: string, outer: Actor | null): Actor {
  const actor = systemActor(reason);
  if (outer && narrowsSystemWork(outer)) return Object.freeze({ ...actor, mode: 'ro' as const });
  return actor;
}

/** The read-only callers whose system work stays read only (systemUnder). */
function narrowsSystemWork(outer: Actor): boolean {
  switch (outer.kind) {
    case 'login':
      return outer.mode === 'ro';
    case 'link':
      return true;
    case 'contact':
      return !outer.canWrite;
    case 'system':
      return outer.mode === 'ro';
    default:
      return false;
  }
}

/** What the actor may write: login(ro), assistant, link, peer and a contact
 *  share without can_write read only (plan 4.1). */
export function writeModeOf(actor: Actor): WriteMode {
  switch (actor.kind) {
    case 'login':
      return actor.mode === 'ro' ? 'ro' : 'rw';
    case 'contact':
      return actor.canWrite ? 'rw' : 'ro';
    case 'system':
      return actor.mode === 'ro' ? 'ro' : 'rw';
    default:
      return 'ro';
  }
}

/** The mantle.actor value (migration 0275's format). */
export function actorSetting(actor: Actor): string {
  switch (actor.kind) {
    case 'login':
      return `login:${actor.mode}:${actor.loginId}`;
    case 'assistant':
      return `assistant:${actor.agentId ?? 'none'}`;
    case 'link':
      return 'link';
    case 'contact':
      return `contact:${actor.canWrite ? 'rw' : 'ro'}`;
    case 'system':
      return `system:${actor.reason}`;
    case 'peer':
      return `peer:${actor.peerId ?? 'none'}`;
  }
}

/** What a binding returns: a thenable `fn` result comes back as the
 *  promise started inside the binding (startedInside), anything else as
 *  it is. */
export type Bound<T> = T extends PromiseLike<infer U> ? Promise<U> : T;

const actorStore = new AsyncLocalStorage<Actor>();

/** An entry whose caller is known only later (an HTTP request: the session
 *  guard or a share gate names it): one mutable slot per entry. */
const actorSlots = new AsyncLocalStorage<{ actor: Actor }>();

/**
 * Run an entry whose actor is named later (setSlotActor), starting as
 * `initial`: the HTTP gate (its request slot) with system(http:no-login), the /s page.
 * An actor bound around it does not reach in: the entry names its own.
 */
export function runInActorSlot<T>(initial: Actor, fn: () => T): T {
  return actorStore.exit(() => actorSlots.run({ actor: initial }, fn));
}

/** Name the current entry's actor (see runInActorSlot). No-op outside one. */
export function setSlotActor(actor: Actor): void {
  const slot = actorSlots.getStore();
  if (slot) slot.actor = actor;
}

/** The current entry's slot actor, or null. */
export function slotActor(): Actor | null {
  return actorSlots.getStore()?.actor ?? null;
}

/**
 * Run `fn` as `actor`: every statement it sends, after any await, carries
 * it. A process entry calls this once, at its entry; deferred work (a run,
 * a heartbeat, a pending call, a Telegram turn) binds the login it runs for,
 * as that login is NOW. An inner binding replaces an outer one.
 */
export function runAsActor<T>(actor: Actor, fn: () => T): Bound<T> {
  return actorStore.run(actor, () => startedInside(fn()));
}

/** runAsActor(system(reason), fn): a process's own work. */
export function runAsSystem<T>(reason: string, fn: () => T): Bound<T> {
  return runAsActor(systemActor(reason), fn);
}

/**
 * A drizzle query is a lazy thenable: it runs when awaited, and the actor is
 * read when it runs. One returned from a binding would run after the binding
 * ended, as the caller. So a thenable result is started here, inside it.
 */
function startedInside<T>(value: T): Bound<T> {
  const then = (value as { then?: unknown } | null)?.then;
  if (typeof then !== 'function') return value as Bound<T>;
  return new Promise((resolve, reject) => {
    (value as PromiseLike<unknown>).then(resolve, reject);
  }) as Bound<T>;
}

/**
 * Run `fn` with no actor, as a process entry starts. Two callers: tests of
 * an entry (the entry must bind its own; a test otherwise runs as
 * system(test), see enterTestActor), and the box mode timer
 * (gateway/check-mode.ts, started by gateway/pools.ts), which must not keep
 * the actor of the statement that opened the pool. Pinned by
 * eslint-rules/actor-binders.mjs.
 */
export function runWithoutActor<T>(fn: () => T): T {
  return actorStore.exit(() => actorSlots.exit(fn));
}

/** The system reason whose work runs at a declared full-route spot now
 *  (viewer.ts onFullSystemRoute). */
const fullRouteSpots = new AsyncLocalStorage<string>();

/** Run `fn` at a declared full-route spot of the system reason `reason`
 *  (viewer.ts onFullSystemRoute only): the actor's SET then carries
 *  `mantle.route` = 'full' (fullRouteSpotNow). */
export function runOnFullRouteSpot<T>(reason: string, fn: () => T): T {
  return fullRouteSpots.run(reason, fn);
}

/** Whether the current work runs at a declared full-route spot: only while
 *  the actor the spot kept is still the one bound (code that binds another
 *  actor inside it is that actor's own work). */
export function fullRouteSpotNow(): boolean {
  const reason = fullRouteSpots.getStore();
  if (reason === undefined) return false;
  const actor = currentActor();
  return actor?.kind === 'system' && actor.reason === reason;
}

/** The actor the current code runs as: the nearest binding, else the
 *  entry's slot (an HTTP request: the gate, the session guard and
 *  the share gate name it), else an operator script's own, else none. */
export function currentActor(): Actor | null {
  return actorStore.getStore() ?? actorSlots.getStore()?.actor ?? scriptActor();
}

let scriptActorMemo: Actor | null | undefined;

/**
 * An operator script (plan 4.3: server/web/scripts/*, maintain, the root
 * scripts) runs as system(script:<file name>): the process's main file is
 * a scripts/ file. Read once. Servers, workers and tests are none.
 */
export function scriptActor(): Actor | null {
  if (scriptActorMemo !== undefined) return scriptActorMemo;
  const main = (process.argv[1] ?? '').replace(/\\/g, '/');
  const m = /\/scripts\/([a-z0-9][a-z0-9._-]*?)\.(ts|mts|mjs|js)$/i.exec(main);
  const name = m ? `script:${m[1]!.toLowerCase()}` : null;
  scriptActorMemo = name && SYSTEM_REASON_RE.test(name) ? systemActor(name) : null;
  return scriptActorMemo;
}

// ── The check (warn only in A2a) ────────────────────────────────────────────

export type ActorCheckMode = 'off' | 'warn' | 'on';

const RANK: Record<ActorCheckMode, number> = { off: 0, warn: 1, on: 2 };

function parseMode(v: string | null | undefined): ActorCheckMode {
  const s = (v ?? '').trim().toLowerCase();
  return s === 'warn' || s === 'on' ? s : 'off';
}

/** The box's mode, from mantle_actor_check_mode(); read by
 *  gateway/check-mode.ts. */
let boxMode: ActorCheckMode = 'off';

/** Set by gateway/check-mode.ts after it read the box's mode. */
export function noteBoxActorCheckMode(mode: string | null): void {
  boxMode = parseMode(mode);
}

/** gateway/pools.ts, when its pool closes: the next pool reads the mode afresh,
 *  and until then the process uses MANTLE_ACTOR_CHECK alone. */
export function forgetBoxActorCheckMode(): void {
  boxMode = 'off';
}

/**
 * The check's mode for this process: the box's (mantle.actor_check, read
 * from the database), raised by MANTLE_ACTOR_CHECK (a test run sets warn),
 * never lowered: the greatest(box, session) rule of the heads check.
 */
export function actorCheckMode(): ActorCheckMode {
  const own = parseMode(env('MANTLE_ACTOR_CHECK'));
  return RANK[own] > RANK[boxMode] ? own : boxMode;
}

/** A statement that found no actor. */
export type ActorMiss = { source: 'ts' | 'sql'; check: string; actor: string; detail: string };

/** The actor of a test's own work (see enterTestActor). */
export const TEST_ACTOR: Actor = Object.freeze({ kind: 'system', reason: 'test' });

/**
 * Tests only (vitest.setup.ts, in its beforeAll and beforeEach): a test is
 * the process entry of what it runs, as system(test). The binding reaches
 * what the test starts as an entry's does (what it awaits, its timers, its
 * detached promises); work that does not descend from the test (a pooled
 * socket's events, a module's own timer) has none, as in production. No-op
 * outside NODE_ENV=test.
 */
export function enterTestActor(): void {
  if (env('NODE_ENV') === 'test') actorStore.enterWith(TEST_ACTOR);
}

/** A longer stack than the default ten frames, to find the caller. */
export function longStack(): string {
  const old = Error.stackTraceLimit;
  Error.stackTraceLimit = 60;
  try {
    return new Error().stack ?? '';
  } finally {
    Error.stackTraceLimit = old;
  }
}

const recorded: ActorMiss[] = [];
/** The narrow role's miss check (plan v3.2 S7a): deduped by actor too. */
const NARROW_CHECKS: ReadonlySet<string> = new Set(['narrow-denied']);
const loggedKeys = new Map<string, number>();
let missLogger: ((m: ActorMiss) => void) | null = null;

/** gateway/pools.ts hands the writer of miss rows here (another connection). */
export function setActorMissLogger(fn: (m: ActorMiss) => void): void {
  missLogger = fn;
}

/**
 * Note a miss. Tests keep every one (takeActorMisses; vitest.setup.ts fails
 * the test). Elsewhere: one console line and one row per check and caller
 * an hour, the row written later on another connection (never in the
 * transaction that missed: 20.3 item 7).
 */
export function noteActorMiss(miss: ActorMiss): void {
  if (env('NODE_ENV') === 'test') {
    recorded.push(miss);
    return;
  }
  // The narrow checks name the reason in the actor: one row per reason, so
  // a second reason meeting the same table within the hour is not hidden.
  const key = NARROW_CHECKS.has(miss.check)
    ? `${miss.source}:${miss.check}:${miss.actor}:${miss.detail}`
    : `${miss.source}:${miss.check}:${miss.detail}`;
  const now = Date.now();
  const last = loggedKeys.get(key);
  if (last !== undefined && now - last < 3_600_000) return;
  if (loggedKeys.size > 5_000) loggedKeys.clear();
  loggedKeys.set(key, now);
  console.warn(`[db] actor miss (${miss.source}) ${miss.check}: ${miss.detail}`);
  missLogger?.(miss);
}

/** A statement with no actor bound, refused because the check is on. */
export class ActorMissingError extends RuntimeFaultError {
  readonly code = 'actor-missing';
  constructor(what: string) {
    super(`${what}: no actor is bound and the actor check is on; refused (docs/actors.md)`);
    this.name = 'ActorMissingError';
  }
}

/** The TypeScript check: a statement about to be sent with no actor bound
 *  is a miss. Off: nothing. Warn: logged. On: logged and refused
 *  (ActorMissingError), the same three steps as the SQL check. Until
 *  the pool's first mode read lands the mode is MANTLE_ACTOR_CHECK alone
 *  (the startup race; the SQL check reads the box itself). `what` names
 *  the handle (db.insert, withSystemTx…). Returns the actor, or null. */
export function checkActorBound(what: string): Actor | null {
  const actor = currentActor();
  if (actor) return actor;
  const mode = actorCheckMode();
  if (mode === 'off') return null;
  noteActorMiss({
    source: 'ts',
    check: what,
    actor: '',
    detail: systemDbCallerOf(withoutOwnFrames(longStack())) ?? 'unknown caller',
  });
  if (mode === 'on') throw new ActorMissingError(what);
  return null;
}

/** `stack` without this file's frames (longStack's, checkActorBound's and a
 *  binder's here), so the caller a miss names is the file outside it. */
function withoutOwnFrames(stack: string): string {
  return stack
    .split('\n')
    .filter((line) => !/packages\/db\/src\/actor\.ts/.test(line.replace(/\\/g, '/')))
    .join('\n');
}

/** Write-role gaps seen in tests (gateway/role-tx.ts noteWriteRoleDenial): a
 *  right the write role does not hold, what was denied. vitest.setup.ts
 *  fails a test on any. */
const writeRoleGaps: string[] = [];

/** Tests only (gateway/role-tx.ts): note a write-role gap. */
export function noteTestWriteRoleGap(what: string): void {
  writeRoleGaps.push(what);
}

/** Tests: the write-role gaps noted since the last call, cleared. */
export function takeWriteRoleGaps(): string[] {
  return writeRoleGaps.splice(0, writeRoleGaps.length);
}

/** Tests only (gateway/narrow-route.ts): the narrow route's denials and
 *  its uses by actor (plan v3.2 S7a), kept here, beside the write-role
 *  gaps, so the test setup reads them without loading the gateway. */
const narrowDenials: { actor: string; what: string }[] = [];
const narrowUses = new Map<string, number>();

/** Tests only (gateway/narrow-route.ts): note a narrow route denial. */
export function noteTestNarrowDenial(actor: string, what: string): void {
  narrowDenials.push({ actor, what });
}

/** Tests only (gateway/narrow-route.ts): count a narrow route use. */
export function noteTestNarrowUse(actor: string): void {
  narrowUses.set(actor, (narrowUses.get(actor) ?? 0) + 1);
}

/** Tests only (viewer.ts onFullSystemRoute): the full-route spots entered,
 *  in order (the area sweep pins each row's). */
const spotUses: string[] = [];

/** Tests only: note a full-route spot entered. */
export function noteTestSpotUse(spot: string): void {
  if (env('NODE_ENV') === 'test') spotUses.push(spot);
}

/** Tests: the full-route spots entered since the last call, cleared. */
export function takeSpotUses(): string[] {
  return spotUses.splice(0, spotUses.length);
}

/** Tests: the narrow route's denials since the last call, cleared. */
export function takeNarrowDenials(): { actor: string; what: string }[] {
  return narrowDenials.splice(0, narrowDenials.length);
}

/** Tests: the narrow route's uses by actor since the last call, cleared. */
export function takeNarrowUses(): Record<string, number> {
  const out = Object.fromEntries(narrowUses);
  narrowUses.clear();
  return out;
}

/** Tests: the misses noted since the last call, cleared. */
export function takeActorMisses(): ActorMiss[] {
  return recorded.splice(0, recorded.length);
}

/** A NOTICE from an item table's write trigger (migration 0275). */
export const SQL_MISS_PREFIX = 'mantle actor miss: ';

/** gateway/pools.ts's onnotice: a trigger's miss becomes a miss; anything
 *  else is printed as postgres.js prints notices by default. */
export function onPgNotice(notice: { message?: string; severity?: string }): void {
  const msg = notice.message ?? '';
  if (msg.startsWith(SQL_MISS_PREFIX)) {
    noteActorMiss({
      source: 'sql',
      check: msg.slice(SQL_MISS_PREFIX.length),
      actor: '',
      detail: '',
    });
    return;
  }
  console.log(notice);
}

// ── Writes inside read paths ────────────────────────────────────────────────

/**
 * Every write that runs inside a read request or a read tool, named and
 * pinned (the route sweep pins where each runs:
 * REQUEST_SCOPE_SYSTEM_WRITES in server/web/server/w6a-route-sweep.db.test.ts).
 * Each runs as system(<name>), so it writes (write mode rw) even for a
 * read-only key. The goal is to move each to a worker; the
 * scoreboard counts them (readPathWrites) and the count only goes down.
 */
export const READ_PATH_WRITES = {
  'repair:abandoned-traces':
    'GET /api/activity: close the caller’s running traces that never finished (server/web/lib/journey.ts)',
  'backfill:app-nav':
    'GET /api/app-nav, and GET /api/tree/apps, its marks and a folder create there, in a scope that holds the Admin workspace only: move the pre-tree sidebar layout into the tree, once (content tree/apps-nav.ts)',
  'backfill:app-marks':
    'GET /api/app-nav, and GET /api/tree/apps and its marks for any login: copy that login’s own app pins and opens into item_marks, once, and note it on the apps root row (content tree/apps-nav.ts)',
  'repair:kind-root':
    'GET /api/tree/:kind, /api/app-nav, and every kind’s create (A2b2b): make a kind’s missing root folder row (content kind-root.ts)',
  'backfill:doc-collections':
    'GET /api/docs/reader: register the default documentation collections (files docs.ts)',
  'repair:files-root':
    'GET /api/files/files: make the missing files root row (files ops/shared.ts)',
  'backfill:page-block-ids':
    'GET /api/pages/:id: store missing block ids, for a reader who may edit the page (content pages/read.ts)',
  'backfill:link-views':
    'GET /s/:token: count a public link’s view (content shares.ts, recordShareView); a link writes nothing itself (arch A3a)',
  'backfill:recall-prompt-embeddings':
    'recall_match and every Recall write: embed the brain’s prompt cards that have no vector yet (content recall.ts)',
  'repair:app-db':
    'app_data_schema and app_data_query on a login’s MCP (A5 step 4): make an app’s database registry row, bring it to its declared schema and set its viewer salt, once (content app-broker.ts, app-viewer.ts)',
} as const;

export type ReadPathWrite = keyof typeof READ_PATH_WRITES;

/** Run a pinned read-path write (READ_PATH_WRITES) as system(<name>). */
export function runReadPathWrite<T>(name: ReadPathWrite, fn: () => T): Bound<T> {
  return runAsActor(systemActor(name), fn);
}
