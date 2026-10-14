/**
 * ToolPolicy (workspaces arch plan v2, sections 8 and 23.2; A5): what a
 * built-in tool is, for every check that asks, declared ONCE on its
 * definition (BuiltinToolDef.policy). It replaces the lists keyed by tool
 * name: each @mantle/tools access list is now a VIEW of the policy table
 * (policySlugSet, policySlugMap, policySlugList below), equal to the list it
 * replaced (packages/runtime/src/tool-policy-snapshot.test.ts holds every
 * list's literal value from before the policies existed).
 *
 * The policy table is the builtin registry (registry.ts fills it with every
 * builtin, and registerBuiltin adds a process's own, the heartbeat tools).
 * It lives in this module, which imports no builtin, so a module a builtin
 * imports (admin-gate.ts, item-write-gate.ts) can hold a view without an
 * import cycle. A view is read live: a builtin registered later is in it.
 * A view read before the registry has loaded throws (fail closed), never
 * answers from an empty table.
 *
 * The gate (@mantle/db gate.ts) reads a tool's policy as a GatePolicy:
 * toGatePolicy, which the owner MCP surface registers as its `mcp-tool`
 * source (A5 step 2). The surface's own hand-written tools are definitions
 * with a policy too (@mantle/mcp-core mcp-defs.ts), loaded here as the
 * surface table (loadSurfaceTools) for the views that name them.
 */
import type { ItemKind } from '@mantle/client-types/kinds';
import type { GatePolicy, ItemNeed, ScopeArea } from '@mantle/db';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

/** The Admin step of a tool (gate step 5). */
export type ToolScope =
  /** Anyone the narrowers let through. */
  | 'any'
  /** A scope that holds the Admin workspace (ADMIN_ONLY_TOOL_SLUGS, or an
   *  ownerOnly tool not in OWNER_ONLY_IN_SCOPE). */
  | 'admin'
  /** It makes a kind of the Admin workspace only: a scope that holds Admin. */
  | 'admin-kind'
  /** A scope that holds Admin with this Admin area on (TOOL_ADMIN_AREAS).
   *  `systemWhole`: it then runs whole on the system pool
   *  (AREA_SYSTEM_TOOLS). `adminOnly`: it is adminOnly as well
   *  (isAdminOnlyTool says so; the area step asks Admin anyway). */
  | Readonly<{ area: ScopeArea; systemWhole?: true; adminOnly?: true }>;

/** One item a write names: the argument holding its id (a list for an
 *  array argument) and what the write needs of it. */
export type ToolItemTarget = Readonly<{ param: string; need: ItemNeed }>;

/** The items of one call, worked out from its input (a recall map named by
 *  its slug, a move that only sometimes moves). */
export type ToolItemResolver = (
  input: Record<string, unknown>,
  ownerId: string,
  /** The caller's surface, for a rule that depends on who calls. */
  ctx?: Pick<ToolHandlerContext, 'surface'>,
) => Promise<{ ids: string[]; need: ItemNeed }[]>;

/** What a tool reaches outside the database. */
export type ToolOutside = Readonly<{
  /** How it reaches out. */
  via?: 'link' | 'send' | 'publish' | 'web' | 'http' | 'shell' | 'sandbox' | 'peer';
  /** Every result it returns is fenced as data before a model reads it, by
   *  its name (UNTRUSTED_CONTENT_TOOL_SLUGS: the web fetch and search, a
   *  mini app's error log and rows). Not every tool that returns
   *  third-party content: others are fenced per result, by the
   *  ToolHandlerResult `untrusted` flag (untrusted.ts). */
  untrusted?: true;
  /** It is in the heartbeat egress set (heartbeats/fire.ts
   *  HEARTBEAT_EGRESS_SLUGS: email_send, web_fetch, web_search): an
   *  unattended heartbeat fire parks it for approval when the egress gate is
   *  on. Not every tool that reaches out of the brain carries it; marking
   *  another one changes what a heartbeat fire does, a behaviour change for
   *  A5 step 5. */
  egress?: true;
  /** It changes what a mini app's code or tools do (builtins-apps.ts
   *  withAuthorCeiling: the author ceiling). */
  appCode?: true;
}>;

/** A tool's policy. Required on every builtin. */
export type ToolPolicy = Readonly<{
  /** read or write. A read mutates nothing the owner owns and sends
   *  nothing out (the former `readOnly` flag: default deny, so a write is
   *  `write`; isBuiltinReadOnly reads this). */
  effect: 'read' | 'write';
  /** What it spends, as the gate reads it: `ownerKey` on the brain owner's
   *  provider keys (only a user of the Admin workspace, on MCP), `model`
   *  paid model work that a connection outside Admin skips (search_chunks),
   *  `none`. */
  spends: 'none' | 'model' | 'ownerKey';
  /** It starts paid model work on a call: a chat, vision, speech, image or
   *  decider adapter, a web-search model, a delegated agent turn (the former
   *  `spends` flag; isBuiltinSpending reads this, a team app never calls
   *  it, spends-drift.test.ts pins it). Never with spends `none`. */
  startsModelWork?: true;
  scope: ToolScope;
  /** It creates an item of this workspace kind (CREATE_TOOL_SLUGS: MCP's
   *  workspace argument, gate step 6). A create of an Admin-only kind is
   *  scope `admin-kind` instead. */
  creates?: ItemKind;
  /** A write that may make an item (default: every write). Unset on every
   *  builtin in step 1: the gate gets none today. */
  makesItems?: boolean;
  outside?: ToolOutside;
  /** Transitional (plan 8, 23.3 step 6b): the items its write names and
   *  what it needs of each, checked before it runs (ITEM_WRITE_TARGETS).
   *  Deleted per tool once the database's own edit check is on everywhere. */
  items?: readonly ToolItemTarget[] | ToolItemResolver;
  /** A key or a linked brain bound to the owner calls it only when the
   *  owner named it (isPeerRiskyTool). */
  peerRisky?: true;
  /** The API key area it belongs to (toolKeyArea); unset: none, open only to
   *  an all-areas key. */
  keyArea?: string;
  /** A list a key outside the Search area reads without email attachments
   *  (key-email-guard.ts LIST_TOOLS). */
  keyEmail?: true;
  /** It changes the content of a page or a note that others may read: a
   *  key or a peer may not (key-scope.ts KEY_SHARED_CONTENT_TOOLS). */
  keySharedContent?: true;
  /** A recipe step may call it (default) or not (RECIPE_FORBIDDEN_SLUGS);
   *  a run item may call it (default) or not (BANNED_ITEM_TOOLS). */
  recipe?: Readonly<{ step?: 'ok' | 'forbidden'; runItem?: 'ok' | 'banned' }>;
  /** Whether a call hands content to clients or the public: a tainted turn
   *  queues it (client-sourced.ts). Default never. */
  lowering?: 'never' | 'always' | ((input: Record<string, unknown>) => boolean);
  /** A team app may call it (default, by its other rules) or never
   *  (MEMBER_APP_REFUSED_SLUGS). */
  memberApp?: 'ok' | 'refused';
}>;

/** The gate's policy of a builtin (plan 23.2): its effect, Admin step,
 *  spending and create; the rest in `fields` for the narrowers and the
 *  pre-run checks. */
export function toGatePolicy(tp: ToolPolicy): GatePolicy {
  const s = tp.scope;
  return Object.freeze({
    effect: tp.effect,
    scope: typeof s === 'string' ? s : Object.freeze({ area: s.area }),
    spends: tp.spends,
    ...(tp.creates ? { creates: tp.creates } : {}),
    ...(tp.makesItems !== undefined ? { makesItems: tp.makesItems } : {}),
    fields: Object.freeze({
      keyArea: tp.keyArea ?? null,
      peerRisky: tp.peerRisky === true,
      keyEmail: tp.keyEmail === true,
      keySharedContent: tp.keySharedContent === true,
      memberApp: tp.memberApp ?? 'ok',
      ...(tp.outside ? { outside: tp.outside } : {}),
      ...(typeof s === 'object' && s.systemWhole ? { systemWhole: true } : {}),
    }),
  });
}

/** Whether a policy's tool is adminOnly (isAdminOnlyTool's answer for its
 *  own slug): scope `admin`, or an area scope marked `adminOnly`. */
export function policyAdminOnly(tp: ToolPolicy): boolean {
  return tp.scope === 'admin' || (typeof tp.scope === 'object' && tp.scope.adminOnly === true);
}

/** Whether a call with `input` lowers content to clients or the public. */
export function policyLowers(tp: ToolPolicy, input: Record<string, unknown>): boolean {
  const l = tp.lowering;
  return l === 'always' || (typeof l === 'function' && l(input));
}

// ── The policy table ────────────────────────────────────────────────────────

const TABLE = new Map<string, BuiltinToolDef>();
let loaded = false;
/** Bumped on every change, so a view refills only when the table moved. */
let version = 0;

/** Thrown when a view is read before the registry filled the table. */
export class PolicyTableNotLoadedError extends Error {
  constructor() {
    super(
      'the tool policy table was read before the builtin registry loaded (import @mantle/tools)',
    );
    this.name = 'PolicyTableNotLoadedError';
  }
}

function assertLoaded(): void {
  if (!loaded) throw new PolicyTableNotLoadedError();
}

/**
 * A definition's former flags, read from its policy: `readOnly` (effect
 * read) and `spends` (it starts model work). Accessors, so they can never
 * say something the policy does not. Set on every builtin by builtins.ts
 * and the registry.
 */
export function withPolicyFlags<T extends BuiltinToolDef>(def: T): T {
  Object.defineProperties(def, {
    readOnly: {
      get: () => (def.policy.effect === 'read' ? true : undefined),
      enumerable: true,
      configurable: true,
    },
    spends: {
      get: () => (def.policy.startsModelWork === true ? true : undefined),
      enumerable: true,
      configurable: true,
    },
  });
  return def;
}

/** Registry only: fill the table with the package's builtins, once. */
export function loadPolicyTable(defs: readonly BuiltinToolDef[]): void {
  for (const def of defs) TABLE.set(def.slug, withPolicyFlags(def));
  loaded = true;
  version += 1;
}

/** Registry only: add (or replace) one builtin. */
export function putPolicyTable(def: BuiltinToolDef): void {
  TABLE.set(def.slug, withPolicyFlags(def));
  version += 1;
}

/** The builtin registered under `slug`, or null. Throws before the
 *  registry has loaded. */
export function tableBuiltin(slug: string): BuiltinToolDef | null {
  assertLoaded();
  return TABLE.get(slug) ?? null;
}

/** Every registered builtin, in registration order. */
export function tableBuiltins(): IterableIterator<BuiltinToolDef> {
  assertLoaded();
  return TABLE.values();
}

/** The policy of the builtin `slug`, or null. */
export function builtinPolicy(slug: string): ToolPolicy | null {
  return tableBuiltin(slug)?.policy ?? null;
}

// ── The surface table ───────────────────────────────────────────────────────

/** A tool a surface defines beside the builtins, by its name and policy:
 *  the hand-written MCP tools (@mantle/mcp-core mcp-defs.ts, A5 step 2).
 *  A builtin's definition is one too. */
export type SurfaceToolDef = Readonly<{
  slug: string;
  policy: ToolPolicy;
  ownerOnly?: boolean;
  optIn?: BuiltinToolDef['optIn'];
}>;

const SURFACE = new Map<string, SurfaceToolDef>();
let surfaceDefs: readonly SurfaceToolDef[] | null = null;

/** The MCP surface only (mcp-defs.ts, at load): its own definitions, for
 *  the views that name them (ADMIN_ONLY_TOOL_SLUGS: the responder tools
 *  that write into the owner's conversation) and its own lists. The same
 *  table again is a no-op; another throws, on purpose: two tables would
 *  make which one decides an accident of import order. */
export function loadSurfaceTools(defs: readonly SurfaceToolDef[]): void {
  if (surfaceDefs === defs) return;
  const names = defs.map((d) => d.slug);
  if (new Set(names).size !== names.length) throw new Error('loadSurfaceTools: a name twice');
  // The same names again: the module loaded twice (a test's fresh module
  // graph), its definitions replace the old. Other names: refused.
  if (surfaceDefs && names.join() !== surfaceDefs.map((d) => d.slug).join()) {
    throw new Error('loadSurfaceTools: another surface table is loaded already');
  }
  SURFACE.clear();
  for (const def of defs) SURFACE.set(def.slug, def);
  surfaceDefs = defs;
  version += 1;
}

/** Whether the surface table is loaded (a process that serves MCP). */
export function surfaceToolsLoaded(): boolean {
  return surfaceDefs !== null;
}

/** The surface's own definition named `slug`, or null. */
export function surfaceTool(slug: string): SurfaceToolDef | null {
  return SURFACE.get(slug) ?? null;
}

/** Thrown when a view that needs the surface table is read before it
 *  loaded. */
export class SurfaceTableNotLoadedError extends Error {
  constructor() {
    super('a surface tool view was read before the MCP definitions loaded (mcp-defs.ts)');
    this.name = 'SurfaceTableNotLoadedError';
  }
}

// ── Views ───────────────────────────────────────────────────────────────────

const READ_ONLY_VIEW = 'a tool policy view is read only: change the policy on the definition';

/** Which surface definitions a view holds besides the builtins: those
 *  `pick` holds for (a name a builtin has is the builtin's), and whether the
 *  view needs the surface table loaded (fail closed) or reads none while
 *  it is not (a process that serves no MCP). */
export type SurfaceViewOpts = Readonly<{
  surface?: (p: ToolPolicy, def: SurfaceToolDef) => boolean;
  requireSurface?: boolean;
  /** Names that are no tool's (said where the view is). */
  also?: readonly string[];
}>;

/** A view's options, fixed: `also` copied. */
function frozenOpts(opts: SurfaceViewOpts): SurfaceViewOpts {
  return Object.freeze({ ...opts, ...(opts.also ? { also: Object.freeze([...opts.also]) } : {}) });
}

function assertSurface(opts: SurfaceViewOpts): void {
  if (opts.requireSurface && !surfaceDefs) throw new SurfaceTableNotLoadedError();
}

/** `also`, the slugs whose policy `pick` holds, then the surface's own
 *  (opts). */
function slugsWhere(pick: (p: ToolPolicy, def: BuiltinToolDef) => boolean, opts: SurfaceViewOpts) {
  const out: string[] = [...(opts.also ?? [])];
  for (const def of TABLE.values()) if (pick(def.policy, def)) out.push(def.slug);
  if (opts.surface) {
    for (const def of SURFACE.values()) {
      if (!TABLE.has(def.slug) && opts.surface(def.policy, def)) out.push(def.slug);
    }
  }
  return out;
}

class PolicySlugSet extends Set<string> {
  #at = -1;
  constructor(
    private readonly pick: (p: ToolPolicy, def: BuiltinToolDef) => boolean,
    private readonly opts: SurfaceViewOpts,
  ) {
    super();
  }
  #fresh(): void {
    assertLoaded();
    assertSurface(this.opts);
    if (this.#at === version) return;
    Set.prototype.clear.call(this);
    for (const s of slugsWhere(this.pick, this.opts)) Set.prototype.add.call(this, s);
    this.#at = version;
  }
  override has(v: string): boolean {
    this.#fresh();
    return super.has(v);
  }
  override get size(): number {
    this.#fresh();
    return super.size;
  }
  override forEach(cb: (v: string, k: string, s: Set<string>) => void, self?: unknown): void {
    this.#fresh();
    super.forEach(cb, self);
  }
  override values(): SetIterator<string> {
    this.#fresh();
    return super.values();
  }
  override keys(): SetIterator<string> {
    this.#fresh();
    return super.keys();
  }
  override entries(): SetIterator<[string, string]> {
    this.#fresh();
    return super.entries();
  }
  override [Symbol.iterator](): SetIterator<string> {
    return this.values();
  }
  override add(): this {
    throw new TypeError(READ_ONLY_VIEW);
  }
  override delete(): boolean {
    throw new TypeError(READ_ONLY_VIEW);
  }
  override clear(): void {
    throw new TypeError(READ_ONLY_VIEW);
  }
}

class PolicySlugMap<V> extends Map<string, V> {
  #at = -1;
  constructor(
    private readonly value: (p: ToolPolicy, def: BuiltinToolDef) => V | undefined,
    private readonly opts: SurfaceMapOpts<V>,
  ) {
    super();
  }
  #fresh(): void {
    assertLoaded();
    if (this.opts.requireSurface && !surfaceDefs) throw new SurfaceTableNotLoadedError();
    if (this.#at === version) return;
    Map.prototype.clear.call(this);
    for (const def of TABLE.values()) {
      const v = this.value(def.policy, def);
      if (v !== undefined) Map.prototype.set.call(this, def.slug, v);
    }
    const surface = this.opts.surface;
    if (surface) {
      for (const def of SURFACE.values()) {
        const v = TABLE.has(def.slug) ? undefined : surface(def.policy, def);
        if (v !== undefined) Map.prototype.set.call(this, def.slug, v);
      }
    }
    this.#at = version;
  }
  override has(k: string): boolean {
    this.#fresh();
    return super.has(k);
  }
  override get(k: string): V | undefined {
    this.#fresh();
    return super.get(k);
  }
  override get size(): number {
    this.#fresh();
    return super.size;
  }
  override forEach(cb: (v: V, k: string, m: Map<string, V>) => void, self?: unknown): void {
    this.#fresh();
    super.forEach(cb, self);
  }
  override values(): MapIterator<V> {
    this.#fresh();
    return super.values();
  }
  override keys(): MapIterator<string> {
    this.#fresh();
    return super.keys();
  }
  override entries(): MapIterator<[string, V]> {
    this.#fresh();
    return super.entries();
  }
  override [Symbol.iterator](): MapIterator<[string, V]> {
    return this.entries();
  }
  override set(): this {
    throw new TypeError(READ_ONLY_VIEW);
  }
  override delete(): boolean {
    throw new TypeError(READ_ONLY_VIEW);
  }
  override clear(): void {
    throw new TypeError(READ_ONLY_VIEW);
  }
}

/** The slugs of the builtins whose policy `pick` holds, as a read-only Set
 *  read live from the table, plus the surface's own definitions
 *  `opts.surface` holds for and the names of `opts.also` (each view that
 *  reads them says why). */
export function policySlugSet(
  pick: (p: ToolPolicy, def: BuiltinToolDef) => boolean,
  opts: SurfaceViewOpts = {},
): ReadonlySet<string> {
  return new PolicySlugSet(pick, frozenOpts(opts));
}

/** What a map view reads of the surface's own definitions (SurfaceViewOpts). */
export type SurfaceMapOpts<V> = Readonly<{
  surface?: (p: ToolPolicy, def: SurfaceToolDef) => V | undefined;
  requireSurface?: boolean;
}>;

/** slug -> `value` of each builtin's policy (undefined: not in the map), as
 *  a read-only Map read live from the table, plus the surface's own
 *  definitions `opts.surface` gives a value. */
export function policySlugMap<V>(
  value: (p: ToolPolicy, def: BuiltinToolDef) => V | undefined,
  opts: SurfaceMapOpts<V> = {},
): ReadonlyMap<string, V> {
  return new PolicySlugMap(value, Object.freeze({ ...opts }));
}

/** policySlugSet as a read-only list (for a view whose type is a list). */
export function policySlugList(
  pick: (p: ToolPolicy, def: BuiltinToolDef) => boolean,
  opts: SurfaceViewOpts = {},
): readonly string[] {
  const target: string[] = [];
  const fixed = frozenOpts(opts);
  let at = -1;
  const fresh = () => {
    assertLoaded();
    assertSurface(fixed);
    if (at === version) return;
    target.length = 0;
    target.push(...slugsWhere(pick, fixed));
    at = version;
  };
  const refuse = () => {
    throw new TypeError(READ_ONLY_VIEW);
  };
  return new Proxy(target, {
    get(t, k, r) {
      fresh();
      return Reflect.get(t, k, r);
    },
    has(t, k) {
      fresh();
      return Reflect.has(t, k);
    },
    ownKeys(t) {
      fresh();
      return Reflect.ownKeys(t);
    },
    getOwnPropertyDescriptor(t, k) {
      fresh();
      return Reflect.getOwnPropertyDescriptor(t, k);
    },
    set: refuse,
    defineProperty: refuse,
    deleteProperty: refuse,
  });
}
