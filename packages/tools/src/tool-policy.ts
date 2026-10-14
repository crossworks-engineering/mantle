/**
 * ToolPolicy (workspaces arch plan v2, sections 8 and 23.2; A5): what a
 * built-in tool is, for every check that asks, declared ONCE on its
 * definition (BuiltinToolDef.policy). It replaced the lists keyed by tool
 * name: A5 step 1 made each @mantle/tools access list a view of the policy
 * table, and A5 step 6a deleted the views: every consumer reads the tool's
 * policy (packages/runtime/src/tool-policy-snapshot.test.ts still holds
 * every list's literal value from before the policies existed, and derives
 * each from the policies it now reads).
 *
 * The policy table is the builtin registry (registry.ts fills it with every
 * builtin, and registerBuiltin adds a process's own, the heartbeat tools).
 * It lives in this module, which imports no builtin, so a module a builtin
 * imports (admin-gate.ts, item-write-gate.ts) can read a policy without an
 * import cycle. It is read live: a builtin registered later is in it. A
 * lookup before the registry has loaded throws (fail closed), never
 * answers from an empty table.
 *
 * The gate (@mantle/db gate.ts) reads a tool's policy as a GatePolicy:
 * toGatePolicy, which the owner MCP surface registers as its `mcp-tool`
 * source (A5 step 2). The surface's own hand-written tools are definitions
 * with a policy too (@mantle/mcp-core mcp-defs.ts); their policies are the
 * leaf mcp-surface-policies.ts, loaded here as the surface table in every
 * process (namedToolPolicy reads it).
 */
import type { ItemKind } from '@mantle/client-types/kinds';
import type { GatePolicy, ItemNeed, ScopeArea } from '@mantle/db';
import type { BuiltinToolDef, ToolHandlerContext } from './types';
import type { ClientSourcedRule } from './client-sourced-rule';
import { MCP_SURFACE_POLICIES } from './mcp-surface-policies';

/** The Admin step of a tool (gate step 5). */
export type ToolScope =
  /** Anyone the narrowers let through. */
  | 'any'
  /** A scope that holds the Admin workspace (an ownerOnly tool with this
   *  scope too; an ownerOnly tool of any other scope runs in any user's
   *  scope). */
  | 'admin'
  /** It makes a kind of the Admin workspace only: a scope that holds Admin. */
  | 'admin-kind'
  /** A scope that holds Admin with this Admin area on (policyArea).
   *  `systemWhole`: it then runs whole on the system pool
   *  (policySystemWhole). `adminOnly`: it is adminOnly as well
   *  (policyAdminOnly says so; the area step asks Admin anyway). */
  | Readonly<{ area: ScopeArea; systemWhole?: true; adminOnly?: true }>;

/** One item a write names: the argument holding its id (a list for an
 *  array argument) and what the write needs of it. */
export type ToolItemTarget = Readonly<{ param: string; need: ItemNeed }>;

/** The items of one call, worked out from its input (a recall map named by
 *  its slug, a move that only sometimes moves). */
export type ToolItemResolver = (
  input: Record<string, unknown>,
  ownerId: string,
  /** The caller's surface, for a rule that depends on who calls; `queue`:
   *  asked before a call is queued for approval (A5 step 6a), where a
   *  reference that names nothing the scope reads is refused. */
  ctx?: Pick<ToolHandlerContext, 'surface'> & { queue?: boolean },
) => Promise<{ ids: string[]; need: ItemNeed; unresolved?: string }[]>;

/** What a tool reaches outside the database. */
export type ToolOutside = Readonly<{
  /** How it reaches out. */
  via?: 'link' | 'send' | 'publish' | 'web' | 'http' | 'shell' | 'sandbox' | 'peer';
  /** Every result it returns is fenced as data before a model reads it
   *  (policyUntrusted: the web fetch and search, a mini app's error log
   *  and rows, mail, Telegram's inbound, a linked brain's reads). Not
   *  every tool that returns
   *  third-party content: others are fenced per result, by the
   *  ToolHandlerResult `untrusted` flag (untrusted.ts). */
  untrusted?: true;
  /** It reaches out (heartbeats/fire.ts reads it): an unattended
   *  heartbeat fire parks it for
   *  approval when the egress gate is on. Since A5 step 5: the mail, web,
   *  Telegram and linked-brain sends (docs/actors.md says which and why the
   *  peer reads are not). Marking another one changes what a heartbeat fire
   *  does. */
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
  /** It creates an item of this workspace kind (MCP's
   *  workspace argument, gate step 6). A create of an Admin-only kind is
   *  scope `admin-kind` instead. */
  creates?: ItemKind;
  /** A write that may make an item (default: every write). Unset on every
   *  builtin in step 1: the gate gets none today. */
  makesItems?: boolean;
  outside?: ToolOutside;
  /** A create that lands in a folder named by its path (an ltree path, e.g.
   *  `parent_path`): the argument. Before a call is queued for approval the
   *  folder must resolve in the queuing turn's scope (A5 step 6a, carried
   *  round-2 LOW-1: the approver's scope runs the create). */
  createsIn?: string;
  /** The create makes the missing folders of its `createsIn` path itself
   *  (file_create: ensureFolderPath, cut to FILES_MAX_FOLDER_DEPTH), so
   *  the queue-time check asks the deepest folder of the path the scope
   *  reads, not the path (A5 step 6a fix round 1, M1). */
  makesFolders?: true;
  /** Transitional (plan 8, 23.3 step 6b): the items its write names and
   *  what it needs of each, checked before it runs (builtinItems).
   *  Deleted per tool once the database's own edit check is on everywhere. */
  items?: readonly ToolItemTarget[] | ToolItemResolver;
  /** A key or a linked brain bound to the owner calls it only when the
   *  owner named it (the gate's peer narrower). */
  peerRisky?: true;
  /** The API key area it belongs to (toolKeyArea); unset: none, open only to
   *  an all-areas key. */
  keyArea?: string;
  /** A list a key outside the Search area reads without email attachments
   *  (key-email-guard.ts). */
  keyEmail?: true;
  /** It changes the content of a page or a note that others may read: a
   *  key or a peer may not (the gate's key-shared-content check). */
  keySharedContent?: true;
  /** A recipe step may call it (default) or not (policyRecipeForbidden);
   *  a run item may call it (default) or not (policyRunItemBanned). */
  recipe?: Readonly<{ step?: 'ok' | 'forbidden'; runItem?: 'ok' | 'banned' }>;
  /** Whether a call hands content to clients or the public: a tainted turn
   *  queues it (client-sourced.ts). Default never. */
  lowering?: 'never' | 'always' | ((input: Record<string, unknown>) => boolean);
  /** What a client-sourced turn may do with a call of this write: run it,
   *  or queue it for the owner (client-sourced-rules.ts; the rule shapes in
   *  client-sourced-rule.ts). Every builtin write declares one, unless its
   *  `lowering` decides; `createsIn` is read as a destination too (A5 step
   *  6d: it replaced WRITE_RULES, the registry keyed by name). Unset on a
   *  write: the call waits. */
  clientSourced?: ClientSourcedRule;
  /** A team app may call it (default, by its other rules) or never
   *  (member-app-tools.ts memberAppRefusedName). */
  memberApp?: 'ok' | 'refused';
  /** It reads the owner's PRIVATE corpus (mail, the Journal): a turn that
   *  serves a workspace user (a team turn, a workspace run or Telegram
   *  turn) is offered it only when the owner opted in (teamPrivateReads),
   *  and a workspace run never (assemble-turn.ts excludePrivateCorpus; A5
   *  step 6a). @mantle/content-core TEAM_PRIVATE_READ_SLUGS, the published
   *  contract's list for the client, names the same tools (a test pins
   *  it). */
  privateCorpus?: true;
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

/** Whether a policy's tool is adminOnly: scope `admin`, or an area scope
 *  marked `adminOnly`. */
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

/** Thrown when the table is read before the registry filled it. */
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
}

/** Registry only: add (or replace) one builtin. */
export function putPolicyTable(def: BuiltinToolDef): void {
  TABLE.set(def.slug, withPolicyFlags(def));
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
}>;

/** The MCP surface's own tools, by name and policy (mcp-surface-policies.ts),
 *  loaded in every process (A5 step 2 fix round 1, LOW-1): a check that
 *  names them (the Admin step of the responder tools that write into the
 *  owner's conversation) says the same with or without mcp-core. */
const SURFACE: ReadonlyMap<string, SurfaceToolDef> = new Map(
  Object.entries(MCP_SURFACE_POLICIES).map(([slug, policy]) => [
    slug,
    Object.freeze({ slug, policy }),
  ]),
);

/** The policy of the tool `name` names, and whether it is ownerOnly: the
 *  builtin's, else the MCP surface's own definition's (a name a builtin has
 *  is the builtin's), else null (a runtime row's name, or no tool). Throws
 *  before the registry has loaded. */
export function namedToolPolicy(
  name: string,
): Readonly<{ policy: ToolPolicy; ownerOnly: boolean }> | null {
  const def = tableBuiltin(name);
  if (def) return { policy: def.policy, ownerOnly: def.ownerOnly === true };
  const own = SURFACE.get(name);
  return own ? { policy: own.policy, ownerOnly: own.ownerOnly === true } : null;
}

// ── What a policy says ──────────────────────────────────────────────────────
// Every check reads these off the tool's policy (A5 step 6a: no list of
// names is kept beside the policies).

/** The Admin area a policy's scope names, or null. */
export function policyArea(tp: ToolPolicy): ScopeArea | null {
  return typeof tp.scope === 'object' ? tp.scope.area : null;
}

/** Whether a policy's tool runs whole on the system pool after its area
 *  check (its area scope is marked `systemWhole`). */
export function policySystemWhole(tp: ToolPolicy): boolean {
  return typeof tp.scope === 'object' && tp.scope.systemWhole === true;
}

/** Whether a call of a policy's tool may hand content to clients or the
 *  public for some input (a tainted turn asks policyLowers per call). */
export function policyMayLower(tp: ToolPolicy): boolean {
  return tp.lowering !== undefined && tp.lowering !== 'never';
}

/** Whether a recipe step may not call a policy's tool. */
export function policyRecipeForbidden(tp: ToolPolicy): boolean {
  return tp.recipe?.step === 'forbidden';
}

/** Whether a run item may not call a policy's tool. */
export function policyRunItemBanned(tp: ToolPolicy): boolean {
  return tp.recipe?.runItem === 'banned';
}

/** Whether every result of a policy's tool is fenced as data before a
 *  model reads it (`outside.untrusted`). */
export function policyUntrusted(tp: ToolPolicy | null | undefined): boolean {
  return tp?.outside?.untrusted === true;
}
