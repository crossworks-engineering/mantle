/**
 * THE one ordered gate (workspaces arch plan v2, section 2, with 20.3; A3c,
 * the gate core). Every way in (an HTTP route, an MCP tool, an assistant
 * tool call, a recipe step, an app tool call, a job) runs the same eight
 * steps, always in this order, through enterCall:
 *
 *   1. Resolve the caller: a login (cookie, mobile bearer, API key, a peer
 *      acting as a login), a link or contact token, or a process.
 *   2. Bind the caller (currentCaller()).
 *   3. Look up the declared policy (a route row, a tool's policy, a runtime
 *      tool row's, a job's system reason); no entry: refused. Then bind the
 *      actor it implies (a public write route's or a job's named system
 *      actor; read only for a read) and the caller's scope.
 *   4. Narrow by surface: the read-only switch of the credential, a key's
 *      areas, a peer's risky tools, the member-app rules, spending on the
 *      owner's keys, the member turn caps.
 *   5. The Admin step, when the policy names one: the Admin workspace, an
 *      Admin area, or a kind of the Admin workspace only.
 *   6. The create-home intent, when the call may make an item
 *      (createHomeIntent, create-home.ts: ?ws=, the workspace argument, the
 *      folder, the private fallback).
 *   7. Run. The database has the last word: row rules on reads, triggers on
 *      writes.
 *   8. Map a refusal with the one mapper (mapAccessError, @mantle/std).
 *
 * Listing equals calling: what a caller may LIST is steps 3 to 5 of the
 * same functions (gateCheck), run without step 7.
 *
 * Layering (plan 20.3): this module holds the step order only. What a
 * policy is comes from the sources that register here (the route rows in
 * A4, the tool policies in A5, the runtime tool row functions of
 * @mantle/tools); the narrowers register from their own packages. Each has
 * a fixed place in the order (NARROWERS): a package adds a check, never a
 * step.
 *
 * A3c builds and proves this; the HTTP routes move onto it in A4, MCP
 * registration and dispatch in A5.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { AccessError, isAccessError, mapAccessError, type AccessRefusal } from '@mantle/std';
import { runAsActor, systemActor, SYSTEM_REASON_RE, type Actor } from './actor';
import { turnScopeProblem, withTurnScope } from './client';
import { createHomeIntent, type CreateAsk, type CreateFallback } from './create-home';
import { currentCreateHome, withCreateHome, type CreateHome, type WorkspaceScope } from './viewer';

export { AccessError, mapAccessError, type AccessRefusal } from '@mantle/std';

/** What a caller's scope holds of the Admin workspace: whether it holds
 *  it, and the Admin areas it may do. */
export type AdminView = { holdsAdmin: boolean; areas: ReadonlySet<string> };

/** How the caller came in. HTTP (A4): `token` is a short-lived signed
 *  token on the one path shape it opens (an asset `?at=`, a frame ticket,
 *  the render cookie); `public` is a public route the gate lets in without
 *  judging a credential (the route judges its own). */
export type CallerVia =
  | 'cookie'
  | 'bearer'
  | 'oauth'
  | 'key'
  | 'peer'
  | 'link'
  | 'contact'
  | 'turn'
  | 'app'
  | 'process'
  | 'token'
  | 'public';

/** The caller, resolved once at step 1. */
export type GateCaller = Readonly<{
  /** Who the caller runs as (actor.ts): a login's login(rw | ro | owner),
   *  the link, the contact share, an assistant, system(reason). */
  actor: Actor;
  via: CallerVia;
  /** The login acting, when there is one. */
  loginId?: string | null;
  /** The credential's write switch (a key's access, a peer's Write, an
   *  OAuth grant narrowed to reads). Absent: writes. */
  write?: boolean;
  /**
   * What the caller's scope holds of Admin (step 5), read at step 1. Null:
   * unscoped (a process, an Admin login on a brain not on workspaces): the
   * surface's own rules decide, as before. Absent: unknown, and a policy
   * that names an Admin step is refused (fail closed).
   */
  admin?: AdminView | null;
  /** The scope the call runs in, bound at step 3 (writes when the policy
   *  writes). Absent: the call runs in the scope around it. */
  scope?: WorkspaceScope | null;
  /** How the surface enters its scope, when not as a turn scope (an HTTP
   *  request enters its request slot, A4). Overrides `scope`. */
  enterScope?: <T>(writes: boolean, fn: () => Promise<T>) => Promise<T>;
  /** The create home's fallback (step 6), when the surface resolved it
   *  already (an MCP connection, once when it connects). */
  createFallback?: CreateFallback;
  /** How this entry names a create home (step 6). Absent: the generic
   *  rule (ownWork 'auto', writes only, a refusal refuses). */
  createHome?: CreateHomeRule;
  /** What the surface narrowers read (a key's areas, the risky tools a
   *  peer may call, an app run's rules). Opaque here. */
  facts?: Readonly<Record<string, unknown>>;
}>;

/** How an entry names a create home (step 6, createHomeStep). */
export type CreateHomeRule = Readonly<{
  /** The fallback's ownWork: true for a login outside Admin (its private
   *  workspace), false for an Admin user, 'auto' to ask the database. */
  ownWork: boolean | 'auto';
  /** The workspace this entry asks for on every call (an assistant turn:
   *  the assistant's own; null: none), instead of the call's own ask. */
  askEvery?: CreateAsk | null;
  /** Reads name a home too: the one the entry has, never made (an
   *  assistant turn). */
  reads?: boolean;
  /** A refusal or a database error names no home, and the database's own
   *  create checks decide, instead of refusing the call (an assistant turn). */
  soft?: boolean;
  /** Keep the home for the life of this object once final (an assistant
   *  turn: its scope; the private workspace is made at most once). */
  memo?: object;
}>;

/** The Admin step of a policy (step 5). */
export type PolicyScope =
  /** Anyone the narrowers let through. */
  | 'any'
  /** A scope that holds the Admin workspace. */
  | 'admin'
  /** It makes a kind of the Admin workspace only (a contact, a journal
   *  entry, a saved place): a scope that holds Admin. */
  | 'admin-kind'
  /** A scope that holds Admin with this Admin area on. */
  | { area: string };

/** A declared policy (plan sections 7 and 8). */
export type GatePolicy = Readonly<{
  /** read or write. A read runs read only (plan 4.1: the database knows
   *  the write mode), and a read-only credential calls only reads. */
  effect: 'read' | 'write';
  scope: PolicyScope;
  /** What it spends on. */
  spends?: 'none' | 'model' | 'ownerKey';
  /** It creates (a kind): step 6 reads the asked workspace (?ws=, the
   *  workspace argument). */
  creates?: boolean | string;
  /** A write that may make an item (default: every write). A delete or a
   *  mark sets false: its private workspace is read, never made. */
  makesItems?: boolean;
  /** The actor it runs as instead of the caller's (a public route that
   *  writes, a job's reason). */
  actor?: Actor;
  /** What the surface narrowers read (a key area, a peer-risky mark, the
   *  member-app rule, a connector's holders). Opaque here. */
  fields?: Readonly<Record<string, unknown>>;
}>;

/** What is called: a route, a tool, a runtime tool row, a job. `kind`
 *  names the policy source; `name` the thing (a route pattern, a slug, a
 *  job's reason). A source may read more of the ref (a row). */
export type PolicyRef = Readonly<{ kind: string; name: string; [k: string]: unknown }>;

/** A source of policies for one kind of ref. Null: no entry (refused). */
export type PolicySource = (ref: PolicyRef) => GatePolicy | null;

/** A surface narrower: the refusal (what the caller reads), or null. */
export type Narrower = (caller: GateCaller, policy: GatePolicy, ref: PolicyRef) => string | null;

/** The narrowers, in their fixed order (step 4). */
export const NARROWERS = [
  'read-only',
  'key',
  'peer',
  'member-app',
  'spending',
  'turn-caps',
] as const;
export type NarrowerName = (typeof NARROWERS)[number];

const sources = new Map<string, PolicySource>();
const narrowers = new Map<NarrowerName, Narrower>();

/** Register the policy source of one kind of ref (A4: 'route'; A5:
 *  'tool'; @mantle/tools: 'runtime-tool'). The same source again is a no-op
 *  (a module loaded twice); another source under a kind that has one is
 *  refused, never a silent replacement. The throw is on purpose: two
 *  sources for one kind would make which one decides an accident of import
 *  order. */
export function registerPolicySource(kind: string, source: PolicySource): void {
  if (kind === 'job') throw new Error("registerPolicySource: 'job' is the gate's own");
  const had = sources.get(kind);
  if (had === source) return;
  if (had) throw new Error(`registerPolicySource: '${kind}' has a source already`);
  sources.set(kind, source);
}

/** Register one narrower at its place in NARROWERS. The same narrower
 *  again is a no-op; another under a taken name throws, on purpose: two
 *  rules under one name would make which one runs an accident of import
 *  order. A surface where a narrower does not apply registers it as an
 *  explicit no-op: the gate refuses to run while any is missing
 *  (assertGateReady). */
export function registerNarrower(name: NarrowerName, narrower: Narrower): void {
  if (!NARROWERS.includes(name)) throw new Error(`registerNarrower: unknown narrower ${name}`);
  if (name === 'read-only') throw new Error("registerNarrower: 'read-only' is the gate's own");
  const had = narrowers.get(name);
  if (had === narrower) return;
  if (had) throw new Error(`registerNarrower: '${name}' has a narrower already`);
  narrowers.set(name, narrower);
}

/** Tests only: forget the registered sources and narrowers. */
export function resetGateRegistry(): void {
  sources.clear();
  narrowers.clear();
}

/** Thrown while a narrower of NARROWERS is not registered: the process did
 *  not load the package that registers it. Not a refusal: the gate does not
 *  run at all (fail closed), and the surface answers its own error. */
export class GateNotReadyError extends Error {
  constructor(missing: readonly string[]) {
    super(
      `the gate is not ready: no narrower registered for ${missing.join(', ')} ` +
        '(load @mantle/tools, whose gate-narrowers registers each, at boot)',
    );
    this.name = 'GateNotReadyError';
  }
}

/** Fail closed: every narrower of NARROWERS but the gate's own registered.
 *  Each process main asks it at boot (@mantle/tools ensureGateReady), so a
 *  missing narrower shows there, not at the first call. */
export function assertGateReady(): void {
  const missing = NARROWERS.filter((n) => n !== 'read-only' && !narrowers.has(n));
  if (missing.length > 0) throw new GateNotReadyError(missing);
}

/** A job's policy: its system reason (plan 4.3). A reason that is not one
 *  has no entry. */
function jobPolicy(ref: PolicyRef): GatePolicy | null {
  if (!SYSTEM_REASON_RE.test(ref.name)) return null;
  return Object.freeze({ effect: 'write', scope: 'any', actor: systemActor(ref.name) });
}

/** The words of the read-only narrower. */
export const READ_ONLY_CALLER_ERROR = 'This connection only reads: it cannot call this.';

/** The read-only switch of the credential (a read key, a peer with Write
 *  off): only reads. */
const readOnlyNarrower: Narrower = (caller, policy) =>
  caller.write === false && policy.effect === 'write' ? READ_ONLY_CALLER_ERROR : null;

// ── The steps ───────────────────────────────────────────────────────────────

/** Step 3: the declared policy of `ref`. No entry: refused. */
export function lookupPolicy(ref: PolicyRef): GatePolicy {
  const source = ref.kind === 'job' ? jobPolicy : sources.get(ref.kind);
  const policy = source ? source(ref) : null;
  if (!policy) throw new AccessError('unclassified');
  return policy;
}

/** Step 3: the caller's scope can be entered (turnScopeProblem, the check
 *  withTurnScope runs): asked before listing as before calling, so a scope
 *  no call can run in lists nothing. A surface that enters its own scope
 *  (`enterScope`) answers for its own: it throws an AccessError, mapped. */
export function scopeStep(caller: GateCaller): void {
  // TODO(A5): the owner MCP surface LISTS its tools for a login in no
  // workspace today and refuses each call (owner-scope.ts); the gate
  // refuses the listing too. A5 decides which, when MCP lists through it.
  if (caller.enterScope || !caller.scope) return;
  const problem = turnScopeProblem(caller.scope);
  if (problem) {
    throw new AccessError(
      'no-scope',
      caller.scope.ws.length === 0 ? undefined : 'This caller has no scope a call can run in.',
    );
  }
}

/** Step 4: the surface narrowers, in their order. */
export function narrowStep(caller: GateCaller, policy: GatePolicy, ref: PolicyRef): void {
  for (const name of NARROWERS) {
    const narrower = name === 'read-only' ? readOnlyNarrower : narrowers.get(name);
    if (!narrower) throw new GateNotReadyError([name]);
    const refused = narrower(caller, policy, ref);
    if (refused !== null) throw new AccessError('narrowed', refused);
  }
}

/** Step 5: the Admin step the policy names. */
export function adminStep(caller: GateCaller, policy: GatePolicy): void {
  const need = policy.scope;
  if (need === 'any') return;
  const view = caller.admin;
  // Unscoped (a process, an Admin login on a brain not on workspaces): the
  // surface's own rules decide, as before W7a. Unknown (absent): refused
  // below, never let through.
  if (view === null) return;
  if (need === 'admin-kind') {
    if (!view?.holdsAdmin) throw new AccessError('admin-kind');
    return;
  }
  if (need === 'admin') {
    if (!view?.holdsAdmin) throw new AccessError('admin');
    return;
  }
  if (!view?.holdsAdmin) throw new AccessError('admin');
  if (!view.areas.has(need.area)) throw new AccessError('area', undefined, { area: need.area });
}

/**
 * Steps 3 to 5 for `ref`, without binding or running (plan 2: listing
 * equals calling): the refusal enterCall would meet before step 6, or
 * null. What a tool list shows is what this lets through. Throws
 * GateNotReadyError while a narrower is not registered (fail closed).
 */
export function gateCheck(caller: GateCaller, ref: PolicyRef): AccessError | null {
  assertGateReady();
  try {
    const policy = lookupPolicy(ref);
    scopeStep(caller);
    narrowStep(caller, policy, ref);
    adminStep(caller, policy);
    return null;
  } catch (err) {
    if (isAccessError(err)) return err;
    throw err;
  }
}

/** Whether a caller may list `ref` (gateCheck lets it through). */
export function gateLists(caller: GateCaller, ref: PolicyRef): boolean {
  return gateCheck(caller, ref) === null;
}

/** `actor`, read only (plan 4.1: a call declared a read cannot write). */
function readOnlyActor(actor: Actor): Actor {
  switch (actor.kind) {
    case 'login':
      return actor.mode === 'ro' ? actor : Object.freeze({ ...actor, mode: 'ro' as const });
    case 'system':
      return actor.mode === 'ro' ? actor : Object.freeze({ ...actor, mode: 'ro' as const });
    case 'contact':
      return actor.canWrite ? Object.freeze({ ...actor, canWrite: false }) : actor;
    default:
      return actor;
  }
}

/** The actor a call runs as (step 3): the policy's, else the caller's,
 *  either read only for a read. */
export function callActor(caller: GateCaller, policy: GatePolicy): Actor {
  const actor = policy.actor ?? caller.actor;
  return policy.effect === 'write' ? actor : readOnlyActor(actor);
}

/** A kept create home (a CreateHomeRule's memo): `final` when no later
 *  call of the entry changes it. */
type KeptHome = { home: CreateHome; final: boolean };
const keptHomes = new WeakMap<object, KeptHome>();

/** The generic entry: the database answers 'auto' (a login outside Admin
 *  falls back to its private workspace), a read names no home, a refusal
 *  refuses the call. */
const DEFAULT_HOME_RULE: CreateHomeRule = Object.freeze({ ownWork: 'auto' as const });

/**
 * Step 6: where the call's creates land, or null. Only for a login's own
 * actor (a process, a link, an assistant with no user name none), and only
 * when nothing around has named a home already (an outer call's, the
 * request's). The entry's rule (CreateHomeRule) says the rest:
 *
 *  - the asked workspace: the entry's own for every call (an assistant
 *    turn: its workspace), else the call's own, read only when the policy
 *    creates (an HTTP create route's ?ws=, an MCP create's argument);
 *  - a write names a home, its private workspace made unless the policy
 *    says it makes no item (a delete); a read names one only where the
 *    entry says (a turn: the one it has, never made);
 *  - a refusal refuses the call, or (soft) names no home and leaves the
 *    database's own create checks to decide;
 *  - kept for the entry (memo) once final.
 *
 * Today's two entries, pinned by tests: the HTTP guard (createHomeFor:
 * ownWork by the login, refusal hard) and the assistant turn
 * (turnCreateHome: askEvery, reads, soft, memo per turn scope).
 */
export async function createHomeStep(
  caller: GateCaller,
  policy: GatePolicy,
  ask: CreateAsk | null,
): Promise<CreateHome | null> {
  const loginId = caller.loginId ?? null;
  if (!loginId) return null;
  const actor = caller.actor;
  if (actor.kind !== 'login' || actor.loginId !== loginId.toLowerCase()) return null;
  if (currentCreateHome()) return null;
  const rule = caller.createHome ?? DEFAULT_HOME_RULE;
  const writes = policy.effect === 'write';
  if (!writes && !policy.creates && !rule.reads) return null;
  const makePrivate = writes && policy.makesItems !== false;
  const kept = rule.memo ? keptHomes.get(rule.memo) : undefined;
  if (kept && (kept.final || !makePrivate)) return kept.home;
  const asked = rule.askEvery !== undefined ? rule.askEvery : policy.creates ? ask : null;
  const fallback: CreateFallback = caller.createFallback ?? {
    ownWork: rule.ownWork,
    makePrivate,
  };
  let home: Awaited<ReturnType<typeof createHomeIntent>>;
  try {
    home = await createHomeIntent(loginId, asked, fallback);
  } catch (err) {
    // A database error is not kept: the next call resolves again.
    if (rule.soft) return null;
    throw err;
  }
  if ('refused' in home) {
    if (rule.soft) return null;
    throw new AccessError(home.refused === 'invalid' ? 'invalid' : 'workspace', home.message);
  }
  if (rule.memo) {
    keptHomes.set(rule.memo, {
      home,
      final: makePrivate || home.createWs !== null || home.privateWs !== null,
    });
  }
  return home;
}

// ── The caller binding (step 2) ─────────────────────────────────────────────

const callerStore = new AsyncLocalStorage<GateCaller>();

/** The caller the current code serves (bound at step 2), or null outside
 *  enterCall. Handlers read this; they never check access themselves. Work
 *  the call starts and does not await (a detached promise, a timer) keeps
 *  it, as it keeps the actor. */
export function currentCaller(): GateCaller | null {
  return callerStore.getStore() ?? null;
}

/** A Set that refuses every change. */
function frozenSet<T>(values: Iterable<T>): ReadonlySet<T> {
  const set = new Set(values);
  const refuse = () => {
    throw new TypeError('the bound caller is frozen');
  };
  Object.defineProperties(set, {
    add: { value: refuse },
    delete: { value: refuse },
    clear: { value: refuse },
  });
  return Object.freeze(set);
}

/** A value of the caller's facts, frozen: an array or a Set copied. */
function frozenValue(v: unknown): unknown {
  if (Array.isArray(v)) return Object.freeze([...v]);
  if (v instanceof Set) return frozenSet(v);
  return v;
}

/** The bound caller (step 2): a frozen COPY, deep enough for what the
 *  steps read (the Admin view's areas, the scope's workspaces, the facts'
 *  arrays and Sets, the create home's rule and fallback). The surface's own
 *  object is never frozen in place, and a later change to it does not reach
 *  the bound caller. The create-home rule keeps its memo object (its
 *  identity is the key). */
function frozenCaller(c: GateCaller): GateCaller {
  const facts = c.facts
    ? Object.freeze(
        Object.fromEntries(Object.entries(c.facts).map(([k, v]) => [k, frozenValue(v)])),
      )
    : c.facts;
  return Object.freeze({
    ...c,
    ...(c.admin
      ? {
          admin: Object.freeze({ holdsAdmin: c.admin.holdsAdmin, areas: frozenSet(c.admin.areas) }),
        }
      : {}),
    ...(c.scope
      ? {
          scope: Object.freeze({
            ...c.scope,
            ws: Object.freeze([...c.scope.ws]),
            modWs: Object.freeze([...c.scope.modWs]),
          }),
        }
      : {}),
    ...(facts !== undefined ? { facts } : {}),
    ...(c.createHome ? { createHome: Object.freeze({ ...c.createHome }) } : {}),
    ...(c.createFallback ? { createFallback: Object.freeze({ ...c.createFallback }) } : {}),
  });
}

/** What one call adds: the workspace it asks its creates to land in. */
export type CallInput = { ask?: CreateAsk | null };

/** What enterCall gives back: the value, or the refusal as the one mapper
 *  read it (each surface answers `refusal.http` or `refusal.toolText`). */
export type GateResult<T> =
  { ok: true; value: T } | { ok: false; refusal: AccessRefusal; error: unknown };

/** Enter the caller's scope for the call (step 3). */
function enterScope<T>(caller: GateCaller, writes: boolean, fn: () => Promise<T>): Promise<T> {
  if (caller.enterScope) return caller.enterScope(writes, fn);
  if (caller.scope) return withTurnScope(caller.scope, fn, { writes });
  return fn();
}

/**
 * Run `fn` for `caller` through the eight steps (see the module comment).
 * `caller` is the resolved caller, or the step-1 resolver (null: no caller,
 * refused). A refusal of any step, and one the database raises while `fn`
 * runs, comes back mapped (`ok: false`); any other error is thrown, to the
 * surface's own error path. Throws GateNotReadyError, before any step,
 * while a narrower is not registered (fail closed).
 */
export async function enterCall<T>(
  caller: GateCaller | (() => Promise<GateCaller | null>),
  ref: PolicyRef,
  fn: () => Promise<T>,
  input: CallInput = {},
): Promise<GateResult<T>> {
  assertGateReady();
  try {
    // 1. Resolve the caller.
    const resolved = typeof caller === 'function' ? await caller() : caller;
    if (!resolved) throw new AccessError('unauthorized');
    // 2. Bind a frozen copy of the caller: nothing the call runs changes
    // who it is, and the surface's own object is left as it was.
    const bound = frozenCaller(resolved);
    return await callerStore.run(bound, async () => {
      // 3. The declared policy; then the actor and the scope it implies.
      const policy = lookupPolicy(ref);
      scopeStep(bound);
      const writes = policy.effect === 'write';
      return runAsActor(callActor(bound, policy), () =>
        enterScope(bound, writes, async () => {
          // 4. Narrow by surface. 5. The Admin step.
          narrowStep(bound, policy, ref);
          adminStep(bound, policy);
          // 6. The create-home intent.
          const home = await createHomeStep(bound, policy, input.ask ?? null);
          // 7. Run.
          const value = home ? await withCreateHome(home, fn) : await fn();
          return { ok: true as const, value };
        }),
      );
    });
  } catch (err) {
    // 8. Map.
    const refusal = mapAccessError(err);
    if (refusal) return { ok: false, refusal, error: err };
    throw err;
  }
}
