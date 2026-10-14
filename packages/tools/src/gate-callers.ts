/**
 * The gate callers of the tool dispatch entries (workspaces arch A5 step
 * 3a): who calls a tool through dispatchTool, as the one gate
 * (@mantle/db gate.ts, enterCall) reads it. An entry names itself once
 * (ToolHandlerContext.caller); dispatch builds the gate caller of each call
 * from it and from the state the call runs in, which every entry has set
 * already: the actor bound at its entry, the scope it entered (a turn's
 * withAgentScope, a run's withRunScope, a pending approval's request), the
 * rollback switch's gate scope. So a caller sets no scope of its own: a turn
 * is never entered twice.
 *
 *  - turnCaller: an assistant turn (the tool loop: the web and Telegram
 *    turns, heartbeats, invoke_agent's child, the run workflows' turns).
 *  - runCaller: a run item (lib/runs/execute-item.ts).
 *  - pendingCaller: an approved pending call (pending.ts).
 *  - ownerWebCaller: the owner's own web call of a tool (the dev console,
 *    A5 step 3b).
 *  - appBrokerCaller: an app's host.tools.call() through a broker (A5 step
 *    3b): the shared link broker (a contact surface), an app run by a
 *    member or an admin (a team or the owner's web surface). The broker
 *    judged the call by its verdict first (appToolRefusal, app-tool-level.ts).
 *  - mcpToolCaller: a call on the owner MCP surface (A5 step 4): the
 *    connection names its whole gate caller (@mantle/mcp-core
 *    gate-policy.ts), and dispatch runs the call as it, with the
 *    workspace a create asks for.
 *  - apiV1Caller: a /api/v1 route that runs a builtin (A5 step 4): the
 *    request's own gate judged the caller (the key's areas and access, A4),
 *    so the call is a process's on the request's behalf, as a run item or a
 *    pending approval is.
 *
 * What each call's gate caller holds:
 *
 *  - the actor bound now (A2a: every entry binds one; none is a bug, logged
 *    once, and the call runs with no actor, as before step 3a, so the actor
 *    check refuses its item writes: low round, LOW-2);
 *  - the Admin view the call's Admin step reads (adminToolGate's reads,
 *    unchanged): in a workspace scope, whether it holds Admin and the area
 *    asked; in the rollback switch's gate scope, the login's own; outside
 *    any, unscoped (null: the surface rules decide). Read only when the
 *    policy names an Admin step, and on every call, as adminToolGate read
 *    it: an area turned off mid-turn refuses the turn's next call (low
 *    round, LOW-1). Only whether the scope holds Admin is kept per scope,
 *    by scopeHoldsAdmin itself, as before;
 *  - the create-home rule of an assistant scope that names its login (the
 *    turn rule, pinned against turnCreateHome by turn-gate-parity.test.ts),
 *    for a builtin only: a runtime row names no home (its recipe's steps
 *    each name their own, as before), and any other scope names none.
 *
 * Nested calls (a recipe's steps, the Toolsmith's tests, a tool a handler
 * dispatches) reuse the caller of the call they run in (currentToolCaller).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  currentActor,
  currentGateScope,
  loginHasArea,
  scopeHasArea,
  scopeHoldsAdmin,
  withTurnScope,
  type AdminView,
  type CallerVia,
  type CreateAsk,
  type CreateHomeRule,
  type GateCaller,
  type GatePolicy,
  type ScopeArea,
  type Tool,
  type WorkspaceScope,
} from '@mantle/db';
import { currentWorkspaceScope } from '@mantle/db/viewer';
import { connectorScopeFacts, elevatedConnectorFacts } from './connector-scope';

/** The dispatch entries. */
export type ToolCallerEntry =
  'turn' | 'run' | 'pending' | 'owner-web' | 'app' | 'mcp' | 'api-v1' | 'api-v1-nested';

/** An entry's caller, as ToolHandlerContext carries it. */
export type ToolCaller = Readonly<{
  entry: ToolCallerEntry;
  /** How it came in, as the gate's narrowers read it. */
  via: CallerVia;
  /** An MCP call (entry `mcp`): the connection's gate caller, resolved
   *  for this call. Every other entry's is built per call (gateCallerFor). */
  gate?: GateCaller;
  /** An MCP call: the workspace its create asks for (its `workspace`
   *  argument). The call's own: a call nested in it asks none. */
  ask?: CreateAsk | null;
  /** The entry hands the call's text to someone outside the server who
   *  must never read a database error's (SQL, params): dispatch runs the
   *  call under the one masking (maskToolDatabaseErrors). An MCP via masks
   *  too, by its via (mcpVia). */
  masks?: boolean;
  /** An app broker's call (entry `app`): the rules its verdict judged it
   *  at (app-tool-level.ts AppCallRules: a run's level, or a contact
   *  share's). Dispatch runs the allowed call on its `app-tool` ref with
   *  them (A5 step 6a, carried LOW-2), as appToolRefusal asks a refused one. */
  appRules?: 'admin' | 'team' | 'contact';
  /** An app broker's call (entry `app`): the verdict the broker judged it
   *  by (A5 step 6a fix round 1, M2), carried whole onto the call's
   *  `app-tool` ref, so the gate refuses a call its verdict refused even
   *  where a broker forgot its own pre-check. None: dispatch refuses (fail
   *  closed). */
  appVerdict?: AppBrokerVerdict;
  /** An approved pending call (entry `pending`, A5 step 6d fix round 1):
   *  who approved it, and for a call queued with more rights than its
   *  asker's scope (pending_tool_calls.elevated, owner decision 1a) the
   *  scope the connector rule reads instead of the one the approval runs
   *  in: the approver's, on the workspace the call was asked in (`lifted`:
   *  the owner's, whose write rule passes). Set only by approvePendingCall
   *  (pending-approval.ts), the one place the approval rule lives. */
  approval?: PendingApproval;
}>;

/** What an approved pending call carries (ToolCaller.approval). */
export type PendingApproval = Readonly<{
  /** The approving login, as the approval resolved it (null: a scope that
   *  names no login). Named in the call's audit row. */
  approver: string | null;
  /** An elevated call: the scope its connector rule reads. */
  connectorScope?: WorkspaceScope;
  /** An elevated call the owner approved: the connector write rule is
   *  lifted (elevatedConnectorFacts); the rest of the rule stands. */
  lifted?: boolean;
}>;

/** The verdict an app broker judged a call by (app-tool-level.ts
 *  AppToolVerdict, the share broker's contactAppToolVerdict): the tool it
 *  allowed, or the refusal. */
export type AppBrokerVerdict = Readonly<
  { ok: true; tool: Tool } | { ok: false; status: 403 | 404; reason: string }
>;

const TURN: ToolCaller = Object.freeze({ entry: 'turn', via: 'turn' });
const RUN: ToolCaller = Object.freeze({ entry: 'run', via: 'process' });
const PENDING: ToolCaller = Object.freeze({ entry: 'pending', via: 'process' });
const OWNER_WEB: ToolCaller = Object.freeze({ entry: 'owner-web', via: 'cookie' });

/** An assistant turn's caller. */
export function turnCaller(): ToolCaller {
  return TURN;
}

/** A run item's caller. */
export function runCaller(): ToolCaller {
  return RUN;
}

/** An approved pending call's caller: the bare entry, or with what its
 *  approval resolved (approvePendingCall). */
export function pendingCaller(approval?: PendingApproval): ToolCaller {
  if (!approval) return PENDING;
  return Object.freeze({ ...PENDING, approval: Object.freeze({ ...approval }) });
}

/** The owner's own web call of a tool. */
export function ownerWebCaller(): ToolCaller {
  return OWNER_WEB;
}

const API_V1: ToolCaller = Object.freeze({ entry: 'api-v1', via: 'process' });

/** A /api/v1 route's call of a builtin. */
export function apiV1Caller(): ToolCaller {
  return API_V1;
}

/** A call nested in a /api/v1 route's call (A5 step 5): the same process
 *  caller under its own entry, so it reads a nested refusal or throw as
 *  the call's text for the outer handler, as a run's nested call does;
 *  only the route's own call answers through app.onError. Its text is the
 *  route's 400 body, so a database error's is masked (fix round 1, L3). */
const API_V1_NESTED: ToolCaller = Object.freeze({
  entry: 'api-v1-nested',
  via: 'process',
  masks: true,
});

/** The surface an app broker passes (appToolScope, the share broker's). */
type AppBrokerSurface = Readonly<{ kind: string }>;

/**
 * An app's tool call through a broker (A5 step 3b): via `contact` on a
 * contact share's surface, else `app`, with the rules its verdict judged it
 * at (`appRules`) and the verdict itself (`appVerdict`, fix round 1, M2). The broker answers the result to a
 * browser as it is, so a database error's text is masked for every surface
 * but the owner's own web (an app the Admin workspace alone holds), which
 * reads it as before (A5 step 5 fix round 1, M3: the rule the ungated path
 * ran, now the entry's).
 */
export function appBrokerCaller(surface: AppBrokerSurface, verdict: AppBrokerVerdict): ToolCaller {
  return Object.freeze({
    appVerdict: verdict,
    entry: 'app',
    via: surface.kind === 'contact' ? 'contact' : 'app',
    masks: surface.kind !== 'web',
    // The rules the broker judged at, by the surface appToolScope gave it:
    // the owner's web for admin rules, a contact share's, else team rules.
    appRules: surface.kind === 'web' ? 'admin' : surface.kind === 'contact' ? 'contact' : 'team',
  });
}

/** The MCP vias (the login's own OAuth, a key, a peer, and stdio). */
const MCP_VIAS: ReadonlySet<CallerVia> = new Set<CallerVia>(['oauth', 'key', 'peer', 'stdio']);

/** One call on the owner MCP surface: its connection's gate caller, and
 *  the workspace a create asks for. */
export function mcpToolCaller(gate: GateCaller, ask: CreateAsk | null = null): ToolCaller {
  if (!MCP_VIAS.has(gate.via)) throw new Error(`mcpToolCaller: not an MCP via: ${gate.via}`);
  return Object.freeze({ entry: 'mcp', via: gate.via, gate, ask });
}

/** Whether `caller` came in over MCP: the MCP-only steps run for it only
 *  (confirm stripping and the key shared content check for a key or a
 *  peer, the one masking of database errors, errors thrown to the surface). */
export function mcpVia(caller: { via: CallerVia }): boolean {
  return MCP_VIAS.has(caller.via);
}

/**
 * The caller a call nested in `caller`'s call reuses (a recipe's steps, the
 * Toolsmith's tests). An MCP call's nested calls are the connection's, less
 * the call's own parts: its workspace argument, its pre-run check (the key
 * email guard, a connector's own check) and the refusal of its creates (the
 * database decides a nested create, as before). A /api/v1 route's nested
 * calls name their own entry (API_V1_NESTED): only the route's own call
 * throws on to app.onError (A5 step 5).
 */
export function nestedToolCaller(caller: ToolCaller): ToolCaller {
  if (caller.entry === 'api-v1') return API_V1_NESTED;
  if (caller.entry !== 'mcp' || !caller.gate) return caller;
  const { preRun: _preRun, ...gate } = caller.gate;
  const rule = gate.createHome;
  return Object.freeze({
    entry: caller.entry,
    via: caller.via,
    gate: Object.freeze({
      ...gate,
      ...(rule ? { createHome: Object.freeze({ ...rule, refuseCreates: undefined }) } : {}),
    }),
    ask: null,
  });
}

const callerStore = new AsyncLocalStorage<ToolCaller>();

/** The caller of the dispatch the current code runs in, or null. */
export function currentToolCaller(): ToolCaller | null {
  return callerStore.getStore() ?? null;
}

/** Run `fn` as a call of `caller` (dispatch, around one call). */
export function withToolCaller<T>(caller: ToolCaller, fn: () => Promise<T>): Promise<T> {
  return callerStore.run(caller, fn);
}

/** The turn rule of an assistant scope that names its login (A0, F12). */
function turnHomeRule(scope: WorkspaceScope): CreateHomeRule {
  return {
    ownWork: 'auto',
    askEvery: { from: 'assistant', ws: scope.ws.length === 1 ? scope.ws[0]! : null },
    reads: true,
    soft: true,
    memo: scope,
  };
}

/** What a scope holds of Admin, for one Admin step (adminToolGate's
 *  reads): whether it holds Admin, and `area` when it may do it. */
async function readAdminView(
  ws: WorkspaceScope | null,
  gate: WorkspaceScope | null,
  area: ScopeArea | null,
): Promise<AdminView | null> {
  if (ws) {
    const holdsAdmin = await scopeHoldsAdmin();
    const areas = new Set<string>();
    if (holdsAdmin && area && (await scopeHasArea(area))) areas.add(area);
    return { holdsAdmin, areas };
  }
  if (gate) {
    // The rollback switch's gate scope (W7 integration fix 2, M6): the
    // scope answers Admin, the login its own areas.
    const holdsAdmin = await withTurnScope(gate, () => scopeHoldsAdmin());
    const areas = new Set<string>();
    if (holdsAdmin && area && gate.loginId && (await loginHasArea(gate.loginId, area))) {
      areas.add(area);
    }
    return { holdsAdmin, areas };
  }
  return null;
}

let warnedNoActor = false;

/** What a call (or a listing) tells the gate caller beyond its entry, for
 *  the narrowers (A5 step 6a, carried L1): whether its surface is the
 *  owner's (the owner-only narrower: absent, the listing does not know it
 *  and the narrower says nothing), and, for a connector row, its owner and
 *  the row (the connector narrower's resource rows). */
export type GateCallFacts = Readonly<{
  ownerSurface?: boolean;
  ownerId?: string;
  row?: Tool;
}>;

/**
 * The gate caller of one call of `caller`'s entry, for a tool with
 * `policy` (null: none, refused at step 3). `builtin`: the call may name a
 * create home (a runtime row names none). `call`: what the narrowers read
 * of the call (GateCallFacts); an MCP connection names its whole caller,
 * whose own rules judge an owner-only tool (its surface is the owner's) and
 * a connector (its pre-run check).
 */
export async function gateCallerFor(
  caller: ToolCaller,
  policy: GatePolicy | null,
  builtin: boolean,
  call: GateCallFacts = {},
): Promise<GateCaller> {
  // An MCP call: the connection named its whole caller (its actor, its
  // scope and how it enters it, its Admin view, its create home rule).
  if (caller.entry === 'mcp') {
    if (!caller.gate) throw new Error('an MCP tool caller names its gate caller');
    return caller.gate;
  }
  const ws = currentWorkspaceScope();
  const gate = ws ? null : currentGateScope();
  // No actor bound is a bug at the entry: the call runs with none, as it
  // did before step 3a (never a system actor that may write).
  const actor = currentActor();
  if (!actor && !warnedNoActor) {
    warnedNoActor = true;
    console.warn('[tools] a tool call with no actor bound runs with none');
  }
  const need = policy?.scope ?? 'any';
  let admin: AdminView | null | undefined;
  if (need !== 'any') {
    const area = typeof need === 'object' ? (need.area as ScopeArea) : null;
    admin = await readAdminView(ws, gate, area);
  }
  const turnScope = ws?.kind === 'assistant' && ws.loginId ? ws : null;
  // A connector row in a workspace scope: what the connector narrower
  // reads (connector-scope.ts), loaded here, where a call and a listing
  // both build their caller. An elevated approved call reads the scope its
  // approval named (A5 step 6d fix round 1), whatever scope the approving
  // surface runs in (a Telegram tap runs in none).
  const connScope = caller.approval?.connectorScope ?? ws;
  const loaded =
    connScope && call.row && call.ownerId && policy?.fields?.mark !== undefined
      ? await connectorScopeFacts(call.ownerId, call.row, connScope)
      : null;
  const connector = loaded && caller.approval?.lifted ? elevatedConnectorFacts(loaded) : loaded;
  const facts = {
    ...(call.ownerSurface !== undefined ? { ownerSurface: call.ownerSurface } : {}),
    ...(connector ? { connector } : {}),
  };
  return {
    actor,
    via: caller.via,
    loginId: ws?.loginId ?? gate?.loginId ?? null,
    ...(admin !== undefined ? { admin } : {}),
    createHome: builtin && turnScope ? turnHomeRule(turnScope) : null,
    ...(Object.keys(facts).length > 0 ? { facts } : {}),
  };
}
