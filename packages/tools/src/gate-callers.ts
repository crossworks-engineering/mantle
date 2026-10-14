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
 *    Its Admin view is read once per turn scope (memo).
 *  - runCaller: a run item (lib/runs/execute-item.ts).
 *  - pendingCaller: an approved pending call (pending.ts).
 *  - ownerWebCaller: the owner's own web call of a tool (the dev console,
 *    A5 step 3b).
 *
 * What each call's gate caller holds:
 *
 *  - the actor bound now (A2a: every entry binds one; none is a bug, and
 *    the call runs as system(tool:no-actor), logged once);
 *  - the Admin view the call's Admin step reads (adminToolGate's reads,
 *    unchanged): in a workspace scope, whether it holds Admin and the area
 *    asked; in the rollback switch's gate scope, the login's own; outside
 *    any, unscoped (null: the surface rules decide). Read only when the
 *    policy names an Admin step;
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
  systemActor,
  withTurnScope,
  type AdminView,
  type CallerVia,
  type CreateHomeRule,
  type GateCaller,
  type GatePolicy,
  type ScopeArea,
  type WorkspaceScope,
} from '@mantle/db';
import { currentWorkspaceScope } from '@mantle/db/viewer';

/** The dispatch entries. */
export type ToolCallerEntry = 'turn' | 'run' | 'pending' | 'owner-web';

/** An entry's caller, as ToolHandlerContext carries it. */
export type ToolCaller = Readonly<{
  entry: ToolCallerEntry;
  /** How it came in, as the gate's narrowers read it. */
  via: CallerVia;
}>;

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

/** An approved pending call's caller. */
export function pendingCaller(): ToolCaller {
  return PENDING;
}

/** The owner's own web call of a tool. */
export function ownerWebCaller(): ToolCaller {
  return OWNER_WEB;
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

/** A turn's Admin views, once per turn scope and area. */
const turnViews = new WeakMap<WorkspaceScope, Map<string, Promise<AdminView | null>>>();

function memoView(
  scope: WorkspaceScope,
  area: ScopeArea | null,
  read: () => Promise<AdminView | null>,
): Promise<AdminView | null> {
  let views = turnViews.get(scope);
  if (!views) {
    views = new Map();
    turnViews.set(scope, views);
  }
  const key = area ?? '';
  let view = views.get(key);
  if (!view) {
    view = read();
    views.set(key, view);
  }
  return view;
}

let warnedNoActor = false;

/**
 * The gate caller of one call of `caller`'s entry, for a tool with
 * `policy` (null: none, refused at step 3). `builtin`: the call may name a
 * create home (a runtime row names none).
 */
export async function gateCallerFor(
  caller: ToolCaller,
  policy: GatePolicy | null,
  builtin: boolean,
): Promise<GateCaller> {
  const ws = currentWorkspaceScope();
  const gate = ws ? null : currentGateScope();
  let actor = currentActor();
  if (!actor) {
    if (!warnedNoActor) {
      warnedNoActor = true;
      console.warn('[tools] a tool call with no actor bound runs as system(tool:no-actor)');
    }
    actor = systemActor('tool:no-actor');
  }
  const need = policy?.scope ?? 'any';
  let admin: AdminView | null | undefined;
  if (need !== 'any') {
    const area = typeof need === 'object' ? (need.area as ScopeArea) : null;
    const read = () => readAdminView(ws, gate, area);
    const at = ws ?? gate;
    admin = caller.entry === 'turn' && at ? await memoView(at, area, read) : await read();
  }
  const turnScope = ws?.kind === 'assistant' && ws.loginId ? ws : null;
  return {
    actor,
    via: caller.via,
    loginId: ws?.loginId ?? gate?.loginId ?? null,
    ...(admin !== undefined ? { admin } : {}),
    createHome: builtin && turnScope ? turnHomeRule(turnScope) : null,
  };
}
