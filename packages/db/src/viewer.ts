/**
 * The access adapter's viewer scope (member logins Phase 0b, plan section 2b;
 * workspaces from W1 on).
 *
 * One idea: no permission check per tool. A scoped caller's queries run as
 * the workspace LOGIN role (`mantle_view_user`) with its workspaces set on
 * the transaction, and row level security drops every row those workspaces
 * do not hold. `db` (client.ts) reads the scope from this AsyncLocalStorage
 * on every property access, so everything inside `withViewer(actsFor, fn)`
 * is filtered with no code change.
 *
 * Rules:
 *  - No scope = the admin pool (system work).
 *  - A scope is never widened or swapped: a nested scope reads the same or
 *    less (runInViewerScope, runInTurnScope).
 *  - A real LOGIN role, never a role switch on the superuser connection: a
 *    `SET ROLE` there is not a lock (`SET ROLE NONE` escapes it).
 *  - The role password is derived from MANTLE_MASTER_KEY (HKDF, fixed
 *    label), so there is no new secret and no compose or .env change.
 *    `ensureViewerRoles` (viewer-roles.ts) sets it at every migrate.
 *  - A `db.transaction` opened OUTSIDE a scope keeps its admin connection: a
 *    withViewer inside that callback does not change `tx`.
 *
 * The tier levels (admin, team, client, public) decide no read (workspaces
 * W8c): the level roles are retired (viewer-roles.ts RETIRED_POOL_ROLES) and
 * hold no grant and no policy (migration 0273). Their helpers went in arch
 * A7.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  runAsActor,
  currentActor,
  loginActor,
  systemActor,
  systemUnder,
  runInActorSlot,
  setSlotActor,
  slotActor,
  type Actor,
} from './actor';
import { hkdfSync } from 'node:crypto';
import { env } from '@mantle/config';
import { RuntimeFaultError, UUID_RE } from '@mantle/std';
import { WORKSPACE_AREAS, type WorkspaceArea } from '@mantle/client-types/dto/workspaces';
import { noteFailOpen } from './fail-open';

/**
 * A personal-space scope (member logins Phase 2, plan section 2b): the code
 * inside acts for ONE space, on the space role (`mantle_view_space`).
 */
export type SpaceScope = {
  spaceId: string;
  /** The login acting (the member, or the owner an agent works for). */
  loginId: string;
};

/**
 * A workspace scope (workspaces W1, plan section 2.1): the code inside reads
 * what the workspaces in `ws` hold, on the workspace role
 * (`mantle_view_user`), and may edit as a Moderator of `modWs`. `kind` says
 * who the work is for: a signed-in user, an assistant turn (its own
 * workspace only), or a public link.
 */
export type ScopeKind = 'user' | 'assistant' | 'link';
export type WorkspaceScope = {
  kind: ScopeKind;
  /** The login acting (the user, or the user an assistant answers). */
  loginId: string | null;
  /** The workspaces this work reads. */
  ws: readonly string[];
  /** The workspaces where the login is a Moderator (a subset of `ws`). */
  modWs: readonly string[];
  /** A link scope only (plan 8.1, R6): the node ids the link serves next to
   *  its own item. The scope reads no workspace; code that serves a link
   *  checks this list. */
  served?: readonly string[];
};

/**
 * Who a viewer scope acts for (plan R6). `withViewer` builds the scope from
 * it: a login (a member, a client, an MCP login, an API key, a linked brain
 * acting as its user) reads the union of that login's workspaces; an
 * assistant (the bot channel) reads its own workspace (none without an id
 * or a workspace); a public link reads no workspace, only its served list.
 */
export type ViewerFor =
  | { login: string; app?: AppRunFor }
  | { agent: string | null }
  | { link: { served: readonly string[] } };

/**
 * A login running an APP (plan R2; W5b2 part B fix round 1, H1). The app's
 * database is shared by every holder, so a run must never read what one
 * holder reads and another does not. The scope is the app's holder
 * workspaces other than Admin, met with the runner's own workspaces, never
 * the runner's whole union:
 * - `{ id }`: a brain app; its holders come from its grants. An app with
 *   no live holder beyond Admin (it runs here only at team rules, the
 *   author ceiling) reads nothing: until 0286 it read the built-in Team
 *   workspace, which is a normal workspace now. An id that is not an app
 *   reads nothing too (fix round 2, L1). Two or more holders beyond Admin
 *   read nothing: the row rule reads any workspace of the scope, not
 *   "every one of them", so no scope expresses their common items yet.
 * - `{ team: true }`: a run at team rules with no brain holders (a member's
 *   own space app, an admin's test run of one): reads nothing (the Team
 *   workspace until 0286).
 * A runner outside the holder reads nothing. No Moderator rights beyond the
 * scope.
 */
export type AppRunFor = { id: string } | { team: true };

/** What the current code runs as: system work (no scope) or a workspace
 *  scope. (The level scope of the tier model went in W8c.) */
export type CurrentScope = { kind: 'system' } | ({ kind: ScopeKind } & WorkspaceScope);

/** `tx`: a scope that must run in one transaction (its settings are
 *  transaction-local) carries it here; `db` returns it for every query.
 *  `system`: a system transaction (runInSystemTx), or asSystem's mask. */
type Scope = {
  system?: true;
  space?: SpaceScope;
  ws?: WorkspaceScope;
  tx?: unknown;
  hooks?: TxHooks;
  /** A system transaction's own (withSystemTx): what a nested call must
   *  match to reuse it (arch A2b, plan 20.2). */
  nest?: SystemTxNest;
  /** A turn scope (workspaces W4b): no transaction of its own; every query
   *  opens a short one on the workspace role (client.ts). */
  perQuery?: true;
  /** A REQUEST scope (workspaces W6a): the session guard entered it for the
   *  rest of the request (enterRequestScope). Reads run as a turn scope's
   *  do; see RequestScopeMode for writes and drafts. */
  request?: RequestScopeMode;
};

/**
 * How a request scope treats writes and drafts (workspaces W6a, plan 2.3):
 *  - `writes`: a mutating request (POST, PUT, PATCH, DELETE). Writes stay on
 *    the system pool with their rule in the statement (plan 2.3): in any
 *    request scope `db` sends insert, update, delete and a writing
 *    `execute` there, and a mutating request's transactions too
 *    (client.ts); withSystemTx and the heads helpers stay open.
 *  - `drafts`: whether `readsDrafts()` says yes (an Admin user's editor
 *    reads the draft of an item it may write; the rule is in each query).
 */
export type RequestScopeMode = { writes: boolean; drafts: boolean };

/** What the session guard did for this request (the W6a route sweep reads
 *  it): entered the login's scope, let an Admin user through on the system
 *  pool (a management area, or an Admin write), or nothing yet. */
export type RequestOutcome =
  | { kind: 'user'; loginId: string; writes: boolean }
  // A member route (/api/member/*, kept until the UI reads the normal
  // routes): its handler holds its own rule, a withViewer per read as since
  // W5b2, and its writes on the system pool.
  | { kind: 'own-rule'; loginId: string }
  | {
      kind: 'system';
      why: 'area' | 'admin-write' | 'login-self';
    };

type RequestSlot = {
  scope: Scope | null;
  outcome: RequestOutcome | null;
  /** The scopes withViewer built in this request, by who they act for: the
   *  lookup runs once per request, not once per call (W6a; the W5b2 member
   *  search cost). */
  memo: Map<string, Promise<WorkspaceScope>>;
  /** Tests and development only: the reads a member route ('own-rule')
   *  sent to the system pool, by calling file (the W6a route sweep). */
  systemReads?: string[];
  /** Tests and development only: the writes a request scope sent to the
   *  system pool through `db` (insert, update, delete, a mutating request's
   *  transaction), by calling file (W6a fix round 1, L2). */
  systemWrites?: string[];
  /** Where a create in this request lands (W6b): see CreateHome. */
  createHome?: CreateHome;
};

/**
 * Where a new item lands (workspaces W6b, plan 15 and 21.8 row 7), set on
 * the system transactions as mantle.create_ws and mantle.private_ws (the
 * database's mantle_default_home reads them). `createWs`: the workspace the
 * login creates in (it moderates it; checked by the caller). `privateWs`:
 * set for a non-Admin login: then the folder's home when the item lands in
 * a folder it may edit, else this private workspace, never Admin.
 */
export type CreateHome = {
  createWs: string | null;
  privateWs: string | null;
  /** No extractor notify for what is made (mantle.ingest_notify off): a
   *  read-only copy the migration makes (S3), never a user's create. */
  quiet?: boolean;
  /** Keys merged into the data of every item made (mantle.create_stamp,
   *  0267's create stamp trigger), in the insert itself: a snapshot copy's
   *  snapshot_of and extract_skipped (W6b fix round 1, M4). */
  stamp?: Readonly<Record<string, unknown>>;
};

/**
 * What an open system transaction (or a nested savepoint of one) was opened
 * with (arch A2b, plan 20.2): a nested withSystemTx reuses it only for the
 * same actor and create home. `busy`: a nested call runs on it now (a
 * second one at the same time is refused). `done`: it ended (a nested call
 * after that is refused). `saves`: the nested calls (savepoints) of the
 * whole outer transaction so far, shared by every level (A2b1 fix round 2,
 * L2). Set and read by client.ts only.
 */
export type SystemTxNest = {
  readonly actor: string;
  readonly home: string;
  busy: boolean;
  done: boolean;
  readonly saves: { n: number };
};

/** Work a scope's transaction owes the world outside the database, run once
 *  it ends: `commit` after a commit, `rollback` after a rollback. */
export type TxHooks = { commit: (() => unknown)[]; rollback: (() => unknown)[] };

export function newTxHooks(): TxHooks {
  return { commit: [], rollback: [] };
}

/** Run hooks: commit hooks in order, rollback hooks newest first (each
 *  undoes the work after the one before it: two renames of one file in a
 *  transaction that rolls back go back last first; A3b part 2 fix round 1,
 *  L2). Each is best effort: the transaction has already ended, so a
 *  failing hook is logged, never thrown. */
export async function runTxHooks(list: (() => unknown)[], what: string): Promise<void> {
  const ordered = what === 'rollback' ? [...list].reverse() : list;
  for (const fn of ordered) {
    try {
      await fn();
    } catch (err) {
      console.error(`[db] ${what} hook failed:`, err instanceof Error ? err.message : err);
    }
  }
}

/**
 * Run `fn` once the current scope's transaction COMMITS (a personal space:
 * `withSpace` is one transaction, and `db.transaction` inside it is only a
 * savepoint). Outside such a scope there is no open transaction to wait for,
 * so `fn` runs now. For effects outside the database that must never outrun
 * the rows they belong to, such as unlinking a deleted item's bytes: a later
 * failure rolls the delete back and the bytes are still there.
 */
export async function afterCommit(fn: () => unknown): Promise<void> {
  const hooks = active()?.hooks;
  if (hooks) hooks.commit.push(fn);
  else await fn();
}

/**
 * Run `fn` if the current scope's transaction ROLLS BACK: cleanup for bytes
 * written next to rows that never commit (a create inside a personal space).
 * Outside such a scope the write has already committed, so this does nothing.
 */
export function afterRollback(fn: () => unknown): void {
  active()?.hooks?.rollback.push(fn);
}

const store = new AsyncLocalStorage<Scope>();

/** The store value of code that left every scope (`asSystem`): it masks a
 *  request scope around it, which `store.exit` could not (the request
 *  scope lives in its own slot). Never returned by `active()`. */
const SYSTEM_EXIT: Scope = Object.freeze({ system: true as const });

/** One slot per HTTP request (workspaces W6a): the HTTP gate opens it
 *  around each handler (runInRequestSlot); the session guard fills it
 *  (enterRequestScope) and the scope holds for the rest of the request. */
const requestSlots = new AsyncLocalStorage<RequestSlot>();

/** The scope the current code runs in: an explicit one (withViewer,
 *  withSpace, a turn, a transaction), else the request's, else none.
 *  `asSystem` masks both. */
function active(): Scope | undefined {
  const s = store.getStore();
  if (s) return s === SYSTEM_EXIT ? undefined : s;
  return requestSlots.getStore()?.scope ?? undefined;
}

/**
 * Run one HTTP handler with a request slot (workspaces W6a). Only the HTTP
 * gate calls this, as its caller's enterScope inside enterCall (A4 step 1);
 * the session guard fills the slot (enterRequestScope).
 */
export function runInRequestSlot<T>(
  fn: () => T,
  opts: { memo?: Map<string, Promise<WorkspaceScope>>; startsAs?: Actor } = {},
): T {
  // Arch A2a: a request runs as system(http:no-login) until the session
  // guard or a share broker names its caller. A4 step 3a: the gate passes
  // the row's actor (the same system(http:no-login) for every manifest
  // route) and the memo its login lookup seeded (withRequestScopeMemo).
  return runInActorSlot(opts.startsAs ?? systemActor('http:no-login'), () =>
    requestSlots.run({ scope: null, outcome: null, memo: opts.memo ?? new Map() }, fn),
  );
}

/** A request's memo before its slot opens (arch A4 step 3a). */
const pendingMemos = new AsyncLocalStorage<Map<string, Promise<WorkspaceScope>>>();

/**
 * Run `fn` with `memo` as the request's memo of built scopes, before its
 * request slot opens (arch A4 step 3a): the gate finds the request's login
 * (whose read seeds the login's scope, seedLoginScope) before enterCall
 * opens the slot, and hands the same memo to the slot (runInRequestSlot),
 * so the guard looks nothing up twice.
 */
export function withRequestScopeMemo<T>(
  memo: Map<string, Promise<WorkspaceScope>>,
  fn: () => T,
): T {
  return pendingMemos.run(memo, fn);
}

/** The current request's memo of built scopes (withViewer), or null
 *  outside a request. */
export function requestScopeMemo(): Map<string, Promise<WorkspaceScope>> | null {
  return requestSlots.getStore()?.memo ?? pendingMemos.getStore() ?? null;
}

/**
 * Name who the current request runs as (arch A2a): the HTTP gate starts
 * it as system(http:no-login); the session guard or a share gate names the
 * caller once it knows it. No-op outside a request (an actor slot).
 */
export function setRequestActor(actor: Actor): void {
  setSlotActor(actor);
}

/** Name a login the guard let through as the request's actor, keeping the
 *  mode the guard already named for that login (a read-only key). */
function nameRequestLogin(loginId: string): void {
  if (!UUID_RE.test(loginId)) return;
  const id = loginId.toLowerCase();
  const had = slotActor();
  if (had?.kind === 'login' && had.loginId === id) return;
  setSlotActor(loginActor(id, 'rw'));
}

/** Whether the current code runs inside a request slot (an HTTP handler). */
export function hasRequestSlot(): boolean {
  return requestSlots.getStore() !== undefined;
}

/**
 * Enter `ws` for the rest of the request (workspaces W6a, plan 2.4): every
 * `db` read after this, after any await, runs on the workspace role in its
 * own short transaction that sets the scope (as a turn scope). Called by the
 * session guard, before the handler touches the database. False outside a
 * request slot (a test calling a handler directly, a worker): the caller
 * decides (the guard refuses a non-Admin login then). The same scope again
 * is a no-op; another scope throws (a scope is never swapped or widened).
 */
export function enterRequestScope(ws: WorkspaceScope, mode: RequestScopeMode): boolean {
  const slot = requestSlots.getStore();
  if (!slot) return false;
  if (slot.scope?.ws) {
    if (sameWorkspaceScope(slot.scope.ws, ws)) return true;
    throw new RuntimeFaultError('enterRequestScope: this request already runs in another scope');
  }
  if (store.getStore() && store.getStore() !== SYSTEM_EXIT) {
    throw new RuntimeFaultError('enterRequestScope: only outside any other scope');
  }
  slot.scope = Object.freeze({
    ws,
    perQuery: true as const,
    request: Object.freeze({ ...mode }),
  });
  slot.outcome = { kind: 'user', loginId: ws.loginId ?? '', writes: mode.writes };
  if (ws.loginId) nameRequestLogin(ws.loginId);
  return true;
}

/** Record that the guard let this request through on the system pool (the
 *  route sweep asserts it is an Admin user's). No-op outside a slot. */
export function noteRequestSystem(why: Extract<RequestOutcome, { kind: 'system' }>['why']): void {
  const slot = requestSlots.getStore();
  if (!slot || slot.scope) return;
  slot.outcome = { kind: 'system', why };
  // Arch A2a (plan 4.1): an Admin area route and the login's own things run
  // as system(reason); an Admin user's write or read on the system pool
  // stays its login (named by the guard).
  if (why === 'area') setSlotActor(systemUnder('http:admin-area', slotActor()));
  else if (why === 'login-self') setSlotActor(systemUnder('http:login-self', slotActor()));
}

/**
 * The scope a write request is checked in, and the one a login's write runs
 * in on the write role (arch A2b2b; the login write gateway's one rule,
 * loginWriteRoute): the write scope of a scope whose reads are scoped too,
 * a login's mutating request scope (W6b; an Admin user's since F4) or an
 * Admin turn (W7a), else null. Masked by asSystem and by any other scope
 * (their transactions are not this request's writes). Before F4 an Admin
 * user's write request ran on the system pool with only its write scope
 * noted (its reads unscoped), so its edits met no edit check (A8 finding
 * F4); it now enters its request scope as every login's does.
 */
export function requestWriteScope(): WorkspaceScope | null {
  const s = store.getStore();
  // An Admin turn (W7a): its writes are checked in its own scope.
  if (s) return s !== SYSTEM_EXIT && s.perQuery && s.ws && s.request?.writes ? s.ws : null;
  const slot = requestSlots.getStore();
  if (!slot) return null;
  return slot.scope?.ws && slot.scope.request?.writes ? slot.scope.ws : null;
}

/** The request write scope withSystemPoolInWriteScope carries. */
const systemPoolScope = new AsyncLocalStorage<WorkspaceScope>();

/**
 * Run `fn` on the system pool with the request's write scope set on each of
 * its transactions (client.ts db reads carriedWriteScope):
 * an Admin user's role change from the workspace screen (adminRoleChange),
 * whose request runs in its login's scope but whose writes reach tables the
 * write role holds no right on (auth.users, sessions, push devices). Its
 * reads run on the system pool; the workspace definer inside a transaction
 * checks the scope's login. Only inside a request's write scope.
 */
export function withSystemPoolInWriteScope<T>(fn: () => Promise<T>): Promise<T> {
  const scope = requestWriteScope();
  if (!scope) return Promise.reject(new RuntimeFaultError('no request write scope to carry'));
  return systemPoolScope.run(scope, fn);
}

/** The scope withSystemPoolInWriteScope carries now, or null. */
export function carriedWriteScope(): WorkspaceScope | null {
  return systemPoolScope.getStore() ?? null;
}

/** Record where this request's creates land (W6b; see CreateHome). No-op
 *  outside a slot. */
export function noteRequestCreateHome(home: CreateHome): void {
  const slot = requestSlots.getStore();
  if (slot) slot.createHome = Object.freeze({ ...home });
}

const createHomes = new AsyncLocalStorage<CreateHome>();

/** Run `fn` with its creates landing in `home` (W6b; the member app tools,
 *  outside an HTTP request). Kept through asSystem: it names a place, it
 *  grants nothing. */
export function withCreateHome<T>(home: CreateHome, fn: () => T): T {
  return createHomes.run(Object.freeze({ ...home }), fn);
}

/** Where a create lands now: withCreateHome's, else this request's (unless
 *  masked by another scope), else null. */
export function currentCreateHome(): CreateHome | null {
  const own = createHomes.getStore();
  if (own) return own;
  if (store.getStore()) return null;
  return requestSlots.getStore()?.createHome ?? null;
}

/**
 * Tests and development only (W6a fix round 1, L2): note a write a request
 * scope sends to the system pool through `db` or a system transaction
 * (withSystemTx and the heads helpers, fix round 2), with the file that
 * sent it: the first frame outside @mantle/db (bestEffortWrite and the
 * heads helpers are only the way there). The route sweep pins the list.
 */
export function noteRequestSystemWrite(what: string): void {
  const slot = requestSlots.getStore();
  // A mutating request's writes are its job (a member's own write since
  // W6b): only a READ request's are pinned.
  if (!slot?.scope || slot.scope.request?.writes || store.getStore() || !strictTurnExits()) return;
  const stack = (new Error().stack ?? '')
    .split('\n')
    .filter((line, i) => i === 0 || !line.replace(/\\/g, '/').includes('packages/db/src/'))
    .join('\n');
  (slot.systemWrites ??= []).push(`${what} ${systemDbCallerOf(stack) ?? '?'}`);
}

/** The writes noteRequestSystemWrite noted in the current request. */
export function requestSystemWrites(): readonly string[] {
  return requestSlots.getStore()?.systemWrites ?? [];
}

/** Record that the guard let a member route's handler hold its own rule
 *  (RequestOutcome 'own-rule'). No-op outside a slot. */
export function noteRequestOwnRule(loginId: string): void {
  const slot = requestSlots.getStore();
  if (!slot || slot.scope) return;
  slot.outcome = { kind: 'own-rule', loginId: loginId.toLowerCase() };
  nameRequestLogin(loginId);
}

/**
 * Tests and development only (W6a, the route sweep): note a read a member
 * route ('own-rule') sends to the system pool, outside any withViewer or
 * other scope, with the file that sent it. client.ts calls it on every
 * read handle `db` hands out; anywhere else it is a no-op.
 */
export function noteOwnRuleSystemRead(what: string): void {
  const slot = requestSlots.getStore();
  if (!slot || slot.outcome?.kind !== 'own-rule' || active() || !strictTurnExits()) return;
  (slot.systemReads ??= []).push(`${what} ${systemDbCallerOf(new Error().stack ?? '') ?? '?'}`);
}

/** The reads noteOwnRuleSystemRead noted in the current request. */
export function ownRuleSystemReads(): readonly string[] {
  return requestSlots.getStore()?.systemReads ?? [];
}

/** What the guard did for the current request, or null (no slot, no
 *  guard yet). */
export function currentRequestOutcome(): RequestOutcome | null {
  return requestSlots.getStore()?.outcome ?? null;
}

/** The request scope's mode when the current code runs in it directly (not
 *  in a narrower scope entered inside it), else null. An Admin turn (W7a:
 *  the Admin assistant, the Admin MCP surface) carries one too: its writes
 *  go to the system pool as a mutating request's do. */
export function currentRequestMode(): RequestScopeMode | null {
  return active()?.request ?? null;
}

/** What the current code runs as (see CurrentScope). Never 'system' inside
 *  a workspace scope (plan T4). */
export function currentScope(): CurrentScope {
  const scope = active();
  if (scope?.ws) return { ...scope.ws };
  return { kind: 'system' };
}

/** Whether the current code is system work: outside every workspace scope
 *  (a system transaction counts). */
export function isSystemScope(): boolean {
  return currentScope().kind === 'system';
}

/** The areas an Admin workspace user manages (plan 2.4): WORKSPACE_AREAS in
 *  @mantle/client-types, the one list (A10 #13). */
export const SCOPE_AREAS = WORKSPACE_AREAS;
export type ScopeArea = WorkspaceArea;

/** The workspace scope the current code runs in, if any. */
export function currentWorkspaceScope(): WorkspaceScope | null {
  return active()?.ws ?? null;
}

/** The personal-space scope the current code runs in, if any. */
export function currentSpaceScope(): SpaceScope | null {
  return active()?.space ?? null;
}

/**
 * Whether the current code may read draft columns: the admin pool, or a
 * workspace scope whose request reads drafts (an Admin user's editor; the
 * rule is in each query, draft-read.ts).
 */
export function readsDrafts(): boolean {
  // A workspace scope reads published columns only (they are all the
  // workspace role is granted).
  const scope = active();
  if (scope?.ws) return scope.request?.drafts === true;
  return isSystemScope() || currentSpaceScope() !== null;
}

/**
 * Whether the current code runs unlimited: the system pool, outside every
 * workspace scope and every scope's own transaction. For the checks that
 * only ask "is this the owner's unlimited path?".
 */
export function isUnscoped(): boolean {
  const scope = active();
  if (!scope) return true;
  return !scope.ws && !scope.space && !scope.tx;
}

/** Whether the current code runs in a turn scope (per-query transactions). */
export function inTurnScope(): boolean {
  return active()?.perQuery === true;
}

/** The transaction the current scope runs in, if it carries one. */
export function currentScopeTx(): unknown {
  return active()?.tx ?? null;
}

/** Whether the current code runs inside a scope's own transaction (a
 *  personal space, withScope, withSystemTx): work it fires and forgets
 *  would outlive the transaction it is bound to. */
export function inScopeTransaction(): boolean {
  return currentScopeTx() !== null;
}

/**
 * The actor a workspace scope runs as (arch A2a), from the scope and the
 * actor around it: a user scope is its login (the mode the caller named for
 * that login kept, so a read-only key stays read-only); an assistant turn
 * that answers a login is that login; one that answers none is the
 * assistant, or login(owner) when its entry named that (the Admin assistant
 * with no user); a link scope is the link, or the contact share around it.
 */
function scopeActor(ws: WorkspaceScope): Actor {
  const outer = currentActor();
  if (ws.kind === 'link') {
    return outer?.kind === 'contact' || outer?.kind === 'link' ? outer : { kind: 'link' };
  }
  if (ws.loginId && UUID_RE.test(ws.loginId)) {
    const id = ws.loginId.toLowerCase();
    return outer?.kind === 'login' && outer.loginId === id ? outer : loginActor(id, 'rw');
  }
  if (outer?.kind === 'assistant' || (outer?.kind === 'login' && outer.mode === 'owner')) {
    return outer;
  }
  return { kind: 'assistant', agentId: null };
}

/** store.run for a workspace scope, with the scope's actor bound. */
function inScope<T>(scope: Scope, fn: () => T): T {
  return scope.ws
    ? (runAsActor(scopeActor(scope.ws), () => store.run(scope, fn)) as T)
    : store.run(scope, fn);
}

/**
 * Enter the scope `withViewer` built (client.ts, plan R6): `fn` and what it
 * awaits read on the workspace role, each query in its own short
 * transaction that sets the scope, as a turn scope does. It replaces a
 * system scope around it (a system transaction keeps its own `tx`). Inside
 * a workspace scope it runs `fn` as is when the scope is the same and is
 * refused otherwise (a scope is never widened or swapped). Only client.ts
 * calls this, with a validated, frozen scope.
 */
export function runInViewerScope<T>(ws: WorkspaceScope, fn: () => Promise<T>): Promise<T> {
  const open = active();
  if (open?.ws) {
    if (sameWorkspaceScope(open.ws, ws)) return fn();
    // Inside a request scope a narrower scope may be entered (an app run,
    // an assistant of one of the login's workspaces): it reads less, never
    // more (workspaces W6a).
    if (open.request && narrowsWorkspaceScope(open.ws, ws)) {
      return inScope({ ws, perQuery: true }, async () => await fn());
    }
    return Promise.reject(
      new RuntimeFaultError('withViewer: already inside another workspace scope'),
    );
  }
  // Awaited INSIDE the scope: a callback that returns a query builder (a
  // thenable, run when awaited) runs it here, not in the caller's scope
  // after this one has ended (ScopeLostError there).
  return inScope({ ws, perQuery: true }, async () => await fn());
}

/** Enter a workspace scope that runs in one transaction on the workspace
 *  role. Only client.ts calls this (`withScope`), with the transaction it
 *  opened and whose settings it set. */
export function runInWorkspaceTx<T>(
  scope: { ws: WorkspaceScope; tx: unknown; hooks: TxHooks },
  fn: () => Promise<T>,
): Promise<T> {
  if (active()) {
    return Promise.reject(new RuntimeFaultError('runInWorkspaceTx: only outside any other scope'));
  }
  return inScope({ ws: scope.ws, tx: scope.tx, hooks: scope.hooks }, fn);
}

/**
 * Enter a TURN scope (workspaces W4b): `fn` and everything it awaits read on
 * the workspace role, each query in its own short transaction that sets the
 * scope (client.ts). No transaction is held across the turn, so an LLM call
 * inside never holds one. Nested: the same scope runs `fn` as is; any other
 * scope (another workspace scope, a transaction) is refused, so a scope is never widened or swapped. Only
 * client.ts calls this (`withTurnScope`), with a validated, frozen scope.
 */
export function runInTurnScope<T>(
  ws: WorkspaceScope,
  fn: () => Promise<T>,
  writes?: RequestScopeMode,
): Promise<T> {
  const scope: Scope = writes
    ? { ws, perQuery: true, request: Object.freeze({ ...writes }) }
    : { ws, perQuery: true };
  const open = active();
  if (open) {
    if (open.perQuery && open.ws && sameWorkspaceScope(open.ws, ws)) return fn();
    // An assistant turn inside a request scope (or an Admin turn, W7a):
    // only one that reads within the login's own scope (its workspace is
    // one of the login's).
    if (open.request && open.ws && narrowsWorkspaceScope(open.ws, ws)) {
      return inScope(scope, fn);
    }
    return Promise.reject(new RuntimeFaultError('withTurnScope: already inside another scope'));
  }
  return inScope(scope, fn);
}

/**
 * Whether a turn scope writes (plan v2 4.2; the A8 finding F2, owner
 * decision a): a turn that answers a login writes with that login's rights,
 * in the scope, as the login's mutating request does there (the login write
 * gateway, the scope on each short write transaction, the database's
 * checks against it); a turn that answers no login writes only when it acts
 * for the owner (the Admin assistant with no user). Any other turn with no
 * login only reads ("With no user an assistant only reads"). The one rule
 * of an assistant's own turn (agent-viewer.ts withAgentScope) and of an
 * approved pending call (pending-origin.ts originRunFor).
 */
export function turnScopeWrites(
  scope: Pick<WorkspaceScope, 'loginId'>,
  actsForOwner: boolean,
): boolean {
  return scope.loginId !== null || actsForOwner;
}

/** Whether `inner` reads and edits no more than `outer`: its workspaces
 *  and Moderator workspaces are subsets, and a user scope, or an assistant
 *  turn inside one, stays its login's (W7a fix round 1, M1: an assistant
 *  that answered another login, or none, took that login's areas and
 *  rows). */
export function narrowsWorkspaceScope(outer: WorkspaceScope, inner: WorkspaceScope): boolean {
  if ((inner.kind === 'user' || inner.kind === 'assistant') && inner.loginId !== outer.loginId) {
    return false;
  }
  if (inner.kind === 'link') return false;
  const ws = new Set(outer.ws);
  const mod = new Set(outer.modWs);
  return inner.ws.every((w) => ws.has(w)) && inner.modWs.every((w) => mod.has(w));
}

/** Two workspace scopes that read and write exactly the same. */
export function sameWorkspaceScope(a: WorkspaceScope, b: WorkspaceScope): boolean {
  const eqList = (x: readonly string[], y: readonly string[]) =>
    x.length === y.length && [...x].sort().every((v, i) => v === [...y].sort()[i]);
  return (
    a.kind === b.kind && a.loginId === b.loginId && eqList(a.ws, b.ws) && eqList(a.modWs, b.modWs)
  );
}

/**
 * Who a turn's rows belong to (workspaces W4b, R3): the workspace and the
 * login a run, a trace or a tool result is stamped with. Inside a turn scope
 * it is the scope's (one workspace); the Admin assistant, which stays on the
 * system pool until W6a, carries it here. Null = system work (Admin by the
 * stamp trigger's NULL rule). An agent with no workspace (a helper such as
 * the replay agent) run straight from a chat carries a stamp with no
 * workspace (W7c fix round 1, H1): only the login it answers, so a read of
 * per-login history knows whose it is.
 */
export type TurnStamp = { workspaceId: string | null; loginId: string | null };

const stampStore = new AsyncLocalStorage<TurnStamp>();

/** Run `fn` with `stamp` as the turn's stamp (the system-pool assistant). */
export function withTurnStamp<T>(stamp: TurnStamp, fn: () => Promise<T>): Promise<T> {
  return stampStore.run({ ...stamp }, fn);
}

/** The current turn's stamp: the turn scope's, else the carried one. The
 *  Admin assistant's turn (W7a) carries its stamp inside its scope: a turn
 *  that answers no login acts for the owner, but its rows stay unstamped
 *  by login, as they were on the system pool. */
export function currentTurnStamp(): TurnStamp | null {
  const ws = active()?.ws;
  const carried = stampStore.getStore() ?? null;
  if (ws) {
    if (ws.ws.length !== 1) return null;
    if (carried && carried.workspaceId === ws.ws[0]) return carried;
    return { workspaceId: ws.ws[0]!, loginId: ws.loginId };
  }
  return carried;
}

/**
 * Run `fn` on an ADMIN-pool transaction's own connection: every `db` query
 * inside uses `tx`, so work that holds a row lock in `tx` never needs a
 * second connection from the pool (team apps M3 re-audit: a member's
 * parallel app writes each held one connection for the lock and took more
 * for the work, and could empty the pool). With the transaction's `hooks`:
 * `afterCommit` and `afterRollback` inside wait for it to end (follow-up
 * low 1), never run early. Only client.ts calls this (`withSystemTx`).
 */
export function runInSystemTx<T>(
  scope: { tx: unknown; hooks: TxHooks; nest: SystemTxNest },
  fn: () => Promise<T>,
): Promise<T> {
  // A request scope around it is fine: a system transaction is the write
  // path of a mutating request (plan 2.3, the rule in the statement). So is
  // an open system transaction: a nested one is its savepoint (arch A2b,
  // client.ts nestedSystemTx).
  const open = active();
  if (open && !open.request && !(open.system && open.tx && open.nest)) {
    return Promise.reject(new RuntimeFaultError('runInSystemTx: only outside a viewer scope'));
  }
  return store.run({ system: true, tx: scope.tx, hooks: scope.hooks, nest: scope.nest }, fn);
}

/** The system transaction the current code runs in (runInSystemTx), or
 *  null: inside asSystem, a workspace scope or a space it is none. */
export function currentSystemTx(): { tx: unknown; hooks: TxHooks; nest: SystemTxNest } | null {
  const s = active();
  if (!s?.system || !s.tx || !s.nest || !s.hooks) return null;
  return { tx: s.tx, hooks: s.hooks, nest: s.nest };
}

/**
 * Why code inside a TURN scope may leave it for the system pool (workspaces
 * W4b fix round 1, M4). A turn scope fails closed: every `db` query runs on
 * the workspace role. There are two doors out to the admin pool: `asSystem`,
 * which inside a turn must name one of these reasons (each logged once per
 * process), and `systemDb`, the infrastructure handle (tool results, pending
 * calls, traces, logs), which inside a turn only the modules of
 * SYSTEM_DB_MODULES may use (assertSystemDbCaller, fix round 2). Keep both
 * lists small: a new entry is a new way out of the scope and needs review.
 *
 *  - `agent-workspace`: the workspace row and membership an assistant runs
 *    in (agent-viewer.ts), read before the scope is entered or re-entered.
 *  - `connector-binding`: a connector group's binding or OAuth config
 *    (dispatch.ts), infrastructure like its keys; the scope's own rule
 *    (connectorScopeRefused) decides whether the call runs.
 *  - `connector-call`: the remote MCP call, which reads and refreshes the
 *    connector's own credentials (api_keys); no brain content is read.
 *  - `heartbeat-own-row`: a heartbeat's control tools change the row of the
 *    heartbeat that is firing, and only that one (heartbeats/tools.ts).
 *  - `app-data`: the app_data tools on a login's own MCP
 *    (builtins-app-data.ts) run the app's SQLite work, its registry rows and
 *    its undo snapshot as the system, only after the lookup in the login's
 *    scope found the app (as the app brokers run that work). (The member's
 *    my_app_* tools, which used it for an app's files, builds and history,
 *    went with W7b: every login builds apps with the app tools in its own
 *    workspaces.)
 *  - `rule-in-query`: inside a REQUEST scope (W6a), the any-login routes
 *    that hold the workspace rule in their own SQL on the system pool (the
 *    shell, access keys, whoami, the chat routes): the rule is the query's,
 *    as it was before the request scope. Since arch A6 the grants and the
 *    workspace screens read in the scope (their definers, 0291) and no
 *    longer leave it by this reason.
 *  - `brain-bookkeeping`: the named system step (system-step.ts, F4 fix
 *    round 2): the brain-wide bookkeeping a write does after its item check
 *    (a table's history prune, an Admin scope's email attachment bytes, a
 *    file's derived items and drawings counted and its confirmed cascade,
 *    the files a flag change or a move re-indexes, an app's export sync).
 *    Each names its step; none answers the caller more than numbers, yes or
 *    no, or rows its scope reads.
 *  - `page-refold`: after a grant change, the derived text of every page
 *    the change reaches is folded again, pages the caller may not read or
 *    edit included (lib/grants.ts, arch A6): nothing goes back to the
 *    caller.
 *  - `admin-area`: a tool of an Admin area (@mantle/tools admin-gate.ts:
 *    the brain's settings, assistants, connectors, keys) in the Admin
 *    assistant's or the Admin MCP surface's scope (W7a), only AFTER the
 *    area check (scopeHasArea): its system tables (model pools, agents,
 *    tool groups, connectors, secrets, peers) are never granted to the
 *    workspace role. It reads no brain items there; brain_capacity counts
 *    them (two numbers, never a row), and secret_create makes the Secrets
 *    root (structure, no content). The scope it leaves is kept
 *    (scopeLeftForSystem): a turn started there answers that scope's login.
 *  - `keyword-candidates`: in a big workspace scope, the ids of the items
 *    whose text matches the caller's own terms, ranked (the text match is
 *    not leakproof, so under the row rule its index is never used); only the
 *    ids the scope reads are kept, re-read in the scope by id (searchNodes,
 *    W7a). No row leaves the system pool.
 *  - `app-trash`: a deleted app's snapshots, which the scope's row rule
 *    hides once the app's row is gone (0265), read only for the deleted
 *    apps whose home the caller moderates, checked first (app_deleted_list
 *    and app_undelete, W7b fix round 1).
 *  - `login-telegram`: a login's own Telegram chats (telegram_chats.login_id,
 *    W7d; until then 'owner-telegram', the anchor's history in its replay,
 *    W7c fix round 2): the Telegram tables are granted to no role. Read for
 *    the asking login only (replay, pairing, the operator tools), or for the
 *    login a rule in the query checks (a chat's workspace, a bot's
 *    Moderators, the login a queued call's approval card goes to), never
 *    another login's chat rows.
 *  - `audit-log`: the audit row of a connector call made over a login's
 *    MCP (mcp-core login-surface.ts): an admin table, written after the
 *    call, never read back in the scope (arch A2a named it).
 *  - `pending-approval`: an approved pending call leaves the scope of the
 *    path that approves it (a request's, an MCP connection's) only to enter
 *    the scope the call was asked in, met with its asker's rights now
 *    (@mantle/tools pending-approval.ts, arch A5 step 6c): it is judged
 *    again and runs there, never in the approver's scope. Nothing is read
 *    on the system pool on the way: the asked scope is entered at once (or,
 *    for a call asked in no scope, the call runs as it was asked).
 *
 * A request scope (W6a) is held to the same list: inside it, `asSystem`
 * names a reason and `systemDb` is for SYSTEM_DB_MODULES only.
 *
 * Retired in plan v3.2 S2b: 'workspace-write' (a change of a workspace's
 * row, look, landing app or archive is a definer call that checks the
 * acting login inside, 0309; lib/workspaces.ts).
 *
 * Retired in arch A6b (docs/actors.md): what each named is read in the
 * scope or by a narrow definer (0293), or is system work that never runs in
 * a scope (systemWork): 'kind-root', 'name-taken', 'export-link',
 * 'contact-sharing', 'login-names', 'owner-preferences', 'lexeme-stats',
 * 'workspace-resources', 'runs-scope-check', 'client-sourced-check',
 * 'client-sourced-mark', 'heartbeat-context'.
 */
export const AS_SYSTEM_TURN_REASONS = [
  'agent-workspace',
  'connector-binding',
  'connector-call',
  'heartbeat-own-row',
  'app-data',
  'rule-in-query',
  'admin-area',
  'keyword-candidates',
  'app-trash',
  'login-telegram',
  'audit-log',
  'pending-approval',
  'page-refold',
  'brain-bookkeeping',
] as const;

/**
 * Reasons of work that never runs inside a turn or request scope (arch
 * A2a: every call names its reason). Since A6b the product ones are
 * systemWork's (it refuses any scope), no longer asSystem calls; an
 * asSystem call inside a turn by one of them counts as unnamed
 * (TurnScopeExitError in tests).
 *
 *  - `login-notice`: the push worker builds a login's notice (a finished
 *    chat reply, a review result) from rows of that login only
 *    (login-notices.ts, systemWork).
 *  - `space-taken-authors`: no caller since A6b (takenFromOf, who wrote
 *    the items an Admin user took from a personal space, had none and was
 *    deleted with admin-space-taken.ts); the name is kept for the spaces
 *    family (W10).
 *  - `snapshot-copies`: the boot step that makes the read-only copies of
 *    snapshots (snapshot-copies.ts, systemWork), under its advisory lock.
 *  - `test`: a test's own setup, in test files only (eslint-rules/
 *    arch-lints.test.ts keeps it out of every counted file).
 */
export const AS_SYSTEM_OTHER_REASONS = [
  'login-notice',
  'space-taken-authors',
  'snapshot-copies',
  'test',
] as const;

export type AsSystemReason =
  (typeof AS_SYSTEM_TURN_REASONS)[number] | (typeof AS_SYSTEM_OTHER_REASONS)[number];

/**
 * The workspace system work: the reasons whose actor
 * (system:<reason>) a workspace definer takes from a caller with no acting
 * login. The SQL allowlist (mantle_ws_system_work, migration 0307) names
 * exactly these actors, one per real caller, each with the one definer it
 * calls (a listed actor on another definer is refused), each added in the
 * release that moves its caller (at most five). Only systemWork takes one (asSystem with
 * one fails typecheck), and systemWork refuses it inside any scope, request
 * or system exit, so these actors are never bound inside a request or turn.
 * eslint-rules/system-work-allowlist.mjs pins the files that pass one;
 * eslint-rules/arch-lints.test.ts refuses the strings anywhere else.
 *
 *  - `ws-clear-ticks`: pnpm -C server/web ws:clear-member-ticks
 *    (workspace-ticks.ts clearMemberTicks), on mantle_ws_set_moderator.
 *  - `boot:migrate-workspaces`: the boot step (server/main.ts: the
 *    assistant attach), on mantle_ws_attach_assistants. The first
 *    owner and onboarding attach in the login's own scope instead (the
 *    assistants area), never as system work: both run inside a request.
 */
export const WORKSPACE_SYSTEM_REASONS = ['ws-clear-ticks', 'boot:migrate-workspaces'] as const;

export type WorkspaceSystemReason = (typeof WORKSPACE_SYSTEM_REASONS)[number];

/** The login bound to this call: a login actor's, else the open scope's
 *  (an assistant turn names its login), else null (createHomeFallback). */
export function boundLoginId(): string | null {
  const actor = currentActor();
  if (actor?.kind === 'login') return actor.loginId;
  return currentWorkspaceScope()?.loginId?.toLowerCase() ?? null;
}

/** Whether `actor` is workspace system work (WORKSPACE_SYSTEM_REASONS). */
export function isWorkspaceSystemActor(actor: Actor | null): boolean {
  return (
    actor?.kind === 'system' &&
    (WORKSPACE_SYSTEM_REASONS as readonly string[]).includes(actor.reason)
  );
}

/** asSystem was called inside a turn scope without an allowlisted reason,
 *  or systemDb used there by a module off SYSTEM_DB_MODULES (`message`). */
export class TurnScopeExitError extends RuntimeFaultError {
  readonly code = 'turn-scope-exit';
  constructor(reason: string | undefined, message?: string) {
    super(
      message ??
        `asSystem inside a turn scope needs an allowlisted reason (AS_SYSTEM_TURN_REASONS); got ${
          reason ? `'${reason}'` : 'none'
        }. A turn never leaves its scope for the system pool unnamed.`,
    );
    this.name = 'TurnScopeExitError';
  }
}

const loggedTurnExits = new Set<string>();

/** Whether an unnamed exit from a turn scope throws: in tests and local
 *  development. In production it is logged and allowed for now (W4b fix
 *  round 1: about 80 call sites, not every one reached by a test yet). */
function strictTurnExits(): boolean {
  const mode = env('NODE_ENV');
  return mode === 'test' || mode === 'development';
}

/**
 * Run `fn` OUTSIDE any viewer scope, on the admin pool: the escape hatch for
 * the rare WRITE a limited caller needs (a heartbeat's control tools change
 * the firing heartbeat's own row). Never for reads. Few call sites,
 * each one audited; grep for `asSystem(` to list them.
 *
 * Every call names its `reason` (arch A2a: a type error without one), and
 * `fn` runs as the actor system(reason). Inside a turn scope (W4b) the
 * reason must be one of AS_SYSTEM_TURN_REASONS (logged once per reason);
 * any other throws TurnScopeExitError in tests and development, and is
 * logged (once per reason) in production.
 */
export function asSystem<T>(fn: () => Promise<T>, reason: AsSystemReason): Promise<T> {
  if (active()?.perQuery) {
    const listed =
      reason !== undefined && (AS_SYSTEM_TURN_REASONS as readonly string[]).includes(reason);
    if (!listed) {
      if (strictTurnExits()) return Promise.reject(new TurnScopeExitError(reason));
      // Allowed in production: counted (plan v3.2 S4a; S4b throws).
      noteFailOpen('turn-exit', active()?.ws?.kind ?? '', () =>
        systemDbCallerOf(new Error().stack ?? ''),
      );
      const key = `unlisted:${reason ?? ''}`;
      if (!loggedTurnExits.has(key)) {
        loggedTurnExits.add(key);
        console.error(`[db] ${new TurnScopeExitError(reason).message} Allowed in production.`, {
          stack: new Error().stack,
        });
      }
    } else if (!loggedTurnExits.has(reason)) {
      loggedTurnExits.add(reason);
      console.info(`[db] a turn scope leaves for the system pool: ${reason}`);
    }
  }
  // The scope this exit leaves (W7a fix round 2, N1): a nested assistant
  // turn started on the system pool answers the caller it left, never the
  // anchor (scopeLeftForSystem, agent-viewer.ts withAgentScope).
  const left = active()?.ws;
  // A plain-JS caller that passed none still runs (A2a changes no behaviour).
  // A read-only caller stays read only on the system pool (fix round, M1).
  const actor = systemUnder(
    typeof reason === 'string' && reason ? reason : 'unnamed',
    currentActor(),
  );
  if (left) return leftStore.run(left, () => runAsActor(actor, () => store.run(SYSTEM_EXIT, fn)));
  return runAsActor(actor, () => store.run(SYSTEM_EXIT, fn));
}

/**
 * System-pool work that never runs in a scope (arch A6b): a worker's, a
 * boot step's, or code reached only inside another named exit (an
 * Admin-area tool runs whole on the system pool). Such code called asSystem
 * as a precaution, though no caller ever ran it in a scope. On the system
 * pool (no scope, or a system transaction's) this runs `fn` exactly as
 * asSystem does (the actor system(reason), any transaction scope masked);
 * inside any other scope (a workspace's, a link's, a personal space's, a
 * request's) it refuses instead of leaving it, so a new caller in a scope
 * fails at once rather than widening its reads. It is no exit: it never
 * leaves a scope. Each file that calls it is pinned with its reasons
 * (eslint-rules/system-work-allowlist.mjs): a new caller needs review.
 */
export function systemWork<T>(
  fn: () => Promise<T>,
  reason: AsSystemReason | WorkspaceSystemReason,
): Promise<T> {
  // Workspace system work: never inside any scope, a system exit or
  // transaction included, nor inside a request.
  if (
    (WORKSPACE_SYSTEM_REASONS as readonly string[]).includes(reason) &&
    (store.getStore() !== undefined ||
      requestSlots.getStore() !== undefined ||
      leftStore.getStore() !== undefined)
  ) {
    return Promise.reject(
      new RuntimeFaultError(
        `workspace system work '${reason}' runs outside every scope and request only`,
      ),
    );
  }
  const open = active();
  if (open && !open.system) {
    return Promise.reject(
      new RuntimeFaultError(
        `system work '${reason}' runs on the system pool only, never in a scope`,
      ),
    );
  }
  const actor = systemUnder(reason, currentActor());
  return runAsActor(actor, () => store.run(SYSTEM_EXIT, fn));
}

/** The workspace scope the nearest asSystem left (see scopeLeftForSystem). */
const leftStore = new AsyncLocalStorage<WorkspaceScope>();

/**
 * The workspace scope that asSystem left to reach the system pool the
 * current code runs on (W7a fix round 2, N1), or null: no workspace scope is
 * open now and an asSystem call left one (a tool call's area work, a named
 * exit). Inside a scope entered since, null. An assistant turn started here
 * answers that scope's login (withAgentScope), so a tool that runs on the
 * system pool never turns its caller into the anchor.
 */
export function scopeLeftForSystem(): WorkspaceScope | null {
  if (active()?.ws) return null;
  return leftStore.getStore() ?? null;
}

/**
 * Run `fn` with no scope left behind (W7 integration fix 2, M5): inside it
 * scopeLeftForSystem is null, as on the tick. For work that must run by its
 * own rules whoever started it: a forced fire of an assistant of a
 * workspace other than Admin answers no login, never the login whose tool
 * call left its scope for the system pool. It opens no scope and widens
 * none: inside an open scope it changes nothing.
 */
export function withoutLeftScope<T>(fn: () => Promise<T>): Promise<T> {
  return leftStore.exit(fn);
}

/**
 * The modules that may use `systemDb` (workspaces W4b fix round 2): the same
 * list as eslint-rules/system-db-allowlist.mjs, which refuses the import
 * anywhere else (viewer.test.ts keeps the two equal). Test files may too.
 */
export const SYSTEM_DB_MODULES: readonly string[] = [
  'packages/db/src/',
  'packages/tracing/src/store.ts',
  'packages/tools/src/tool-results.ts',
  'packages/turn-stream/src/publish.ts',
  'packages/turn-stream/src/replay.ts',
  'packages/embeddings/src/index.ts',
  'packages/content/src/team-messages.ts',
  'packages/content/src/app-access-log.ts',
  'packages/content/src/share-access-log.ts',
  'packages/content/src/team-access-log.ts',
  'packages/content/src/member-turn-ledger.ts',
  'packages/runtime/src/agent/tool-loop/execute-call.ts',
  'server/web/lib/audit.ts',
  'packages/api-keys/src/index.ts',
];

/** The file that touched `systemDb`, from a stack taken in its proxy: the
 *  first frame outside this module, client.ts, a dependency (drizzle reads
 *  `this.session` on the proxy inside its own methods) and node's own code.
 *  Null when none names a file. */
export function systemDbCallerOf(stack: string): string | null {
  for (const line of stack.split('\n').slice(1)) {
    const m = /\(?((?:file:\/\/)?[^\s()]+?):\d+:\d+\)?\s*$/.exec(line.trim());
    if (!m) continue;
    const file = m[1]!.replace(/^file:\/\//, '').replace(/\\/g, '/');
    if (
      file.endsWith('packages/db/src/viewer.ts') ||
      file.endsWith('packages/db/src/client.ts') ||
      file.endsWith('packages/db/src/fail-open.ts') ||
      file.includes('/node_modules/') ||
      file.startsWith('node:')
    ) {
      continue;
    }
    return file;
  }
  return null;
}

/** The drizzle internals read on `systemDb` itself while a query it was
 *  asked for runs: `this.session` and `this.dialect`, and `this.authToken`,
 *  which `execute` reads only when the query is awaited, from a frame with
 *  no caller file. The check already ran when the caller touched the
 *  method, so these skip it (W5a audit W3): one stack per call, not
 *  several, in a turn. Nothing else: `$client` (the raw pool) and `_` stay
 *  checked, so code handed systemDb cannot reach the pool unchecked (fix
 *  round 2, L-2). */
const SYSTEM_DB_INTERNAL_PROPS: ReadonlySet<PropertyKey> = new Set([
  'session',
  'dialect',
  'authToken',
]);

/** Whether an access of `prop` on `systemDb` inside a turn scope is checked
 *  (assertSystemDbCaller): every one but drizzle's internals. */
export function systemDbAccessChecked(prop: PropertyKey): boolean {
  return !SYSTEM_DB_INTERNAL_PROPS.has(prop);
}

/** Whether `file` is one of SYSTEM_DB_MODULES (or a test file). */
export function isSystemDbModule(file: string): boolean {
  if (/\.test\.tsx?$/.test(file)) return true;
  return SYSTEM_DB_MODULES.some((p) => file.includes(`/${p}`) || file.startsWith(p));
}

/**
 * `systemDb` inside a turn scope (workspaces W4b fix round 2): the second
 * door out of the scope, so only SYSTEM_DB_MODULES may use it there (the
 * eslint rule holds the import; this holds the call, whatever path the
 * handle took). Anything else throws TurnScopeExitError in tests and local
 * development, and is logged once per calling file in production, as asSystem
 * does (M4). Outside a turn scope: nothing. client.ts calls it on every
 * access to `systemDb` in a turn scope; `stack` is for tests.
 */
export function assertSystemDbCaller(stack?: string): void {
  if (!active()?.perQuery) return;
  const caller = systemDbCallerOf(stack ?? new Error().stack ?? '');
  if (caller && isSystemDbModule(caller)) return;
  const message =
    `systemDb inside a turn scope is for the infrastructure modules of SYSTEM_DB_MODULES only; ` +
    `used from ${caller ?? 'an unknown file'}. A turn never reads past its scope on the admin pool.`;
  if (strictTurnExits()) throw new TurnScopeExitError(undefined, message);
  // Allowed in production: counted (plan v3.2 S4a; S4b throws).
  noteFailOpen('system-db', active()?.ws?.kind ?? '', () => caller);
  const key = `system-db:${caller ?? ''}`;
  if (!loggedTurnExits.has(key)) {
    loggedTurnExits.add(key);
    console.error(`[db] ${message} Allowed in production.`, { stack: new Error().stack });
  }
}

/**
 * Refuse to hand work to another process from inside a workspace scope. A
 * job runs later in a worker that does not inherit this scope, so it would
 * run unscoped. A workspace scope never hands work on without carrying it
 * (plan 5.4, U5): a caller that carries it checks with assertScopeCarried
 * instead.
 */
export function assertNoViewer(what: string): void {
  if (active()?.ws) {
    throw new Error(
      `${what} leaves this process and would run unscoped, but the caller runs in a workspace scope. ` +
        'Work queued from a workspace scope must carry that scope.',
    );
  }
}

/** The limited pools: the workspace role (workspaces W1), which reads, and
 *  the write role (workspaces arch A2b2), which writes under the same row
 *  rules. */
export type PoolRole = 'user' | 'write';

/** The retired roles: the personal-space role (W6b) and the three level
 *  roles (W8c). NOLOGIN, no grant and no policy (0273); they stay as roles
 *  because the old migrations name them. */
export type RetiredPoolRole = 'space' | 'team' | 'client' | 'public';

/** The Postgres role of the pool, or of a retired one. Not `mantle_team`:
 *  that name is already the team visitor cookie. The write role is
 *  `mantle_write_user`: 0277's gate and the plan (20.1) name it so. */
export function viewerRoleName(level: PoolRole | RetiredPoolRole): string {
  return level === 'write' ? 'mantle_write_user' : `mantle_view_${level}`;
}

/**
 * The role's password: HKDF-SHA256 over the master key with a fixed label per
 * level. Deterministic, so every process of a box derives the same value and
 * `ensureViewerRoles` can (re)set it at each migrate, after a restore, and
 * after a master-key change.
 */
export function viewerRolePassword(masterKey: string, level: PoolRole): string {
  if (!masterKey) throw new Error('MANTLE_MASTER_KEY must be set to derive viewer role passwords');
  const key = hkdfSync(
    'sha256',
    Buffer.from(masterKey, 'utf8'),
    Buffer.from('mantle-viewer-roles', 'utf8'),
    Buffer.from(`viewer-role:${level}`, 'utf8'),
    32,
  );
  return Buffer.from(key).toString('base64url');
}

/**
 * Per-database viewer logins (MANTLE_VIEWER_ROLES_PER_DATABASE=1), for a
 * brain on a Postgres cluster that other brains share (throwaway and e2e
 * brains on the workstation). The shared role is a cluster object with ONE
 * password, derived from one brain's master key: a second brain that reset
 * it broke the first ("password authentication failed for user
 * mantle_view_user"). In this mode the brain logs in as its own role,
 * `mantle_view_user_<database>`, whose only power is to become the shared
 * role (`SET role` at login, viewer-roles.ts). So `current_user`, the grants
 * and the row policies are the shared role's, as on a box with one brain.
 * That power is cluster-wide; what keeps it to its own brain is CONNECT: a
 * per-database brain's database admits only its own logins. Off (the
 * default) = the shared names, unchanged.
 *
 * The database name such a role carries: anything else fails loudly, since a
 * name that had to be mangled could collide with another brain's.
 */
export function viewerRoleDatabase(database: string): string {
  if (!/^[a-z0-9_]{1,40}$/.test(database)) {
    throw new Error(
      `per-database viewer roles need a database name of 1 to 40 characters from [a-z0-9_]; got "${database}"`,
    );
  }
  return database;
}

/** The role a limited pool logs in as: the shared role, or with `database`
 *  the brain's own per-database role (MANTLE_VIEWER_ROLES_PER_DATABASE). */
export function viewerLoginRoleName(
  level: PoolRole | RetiredPoolRole,
  database: string | null,
): string {
  return database === null
    ? viewerRoleName(level)
    : `${viewerRoleName(level)}_${viewerRoleDatabase(database)}`;
}

/** The connection URL for a limited level: the admin URL with the user and
 *  password swapped. Host, port, database and options stay. `perDatabase`
 *  logs in as the brain's own role for the URL's database. */
export function viewerDatabaseUrl(
  adminUrl: string,
  level: PoolRole,
  password: string,
  perDatabase = false,
): string {
  const u = new URL(adminUrl);
  u.username = viewerLoginRoleName(
    level,
    perDatabase ? decodeURIComponent(u.pathname.replace(/^\//, '')) : null,
  );
  u.password = password; // base64url: nothing to escape
  return u.toString();
}
