/**
 * How an owner MCP call enters its login's scope (workspaces W7a; arch A5
 * step 4: the caller's `enterScope`, run by the one gate, @mantle/db
 * gate.ts). An Admin login's MCP (OAuth, an API key, a peer bound to it,
 * and stdio, which runs as the anchor login) reads what that login's
 * workspaces hold, like every other user, never the whole system pool:
 *
 *  - each call enters the login's scope (loginScopeFor: the union of its
 *    live workspaces, Moderator where it is one) as a turn scope that
 *    writes as an Admin user's mutating request does (the system pool,
 *    with the scope set on its transactions for the database's move,
 *    create and delete checks);
 *  - a login in no workspace has no scope: refused (NO_SCOPE_ERROR);
 *  - MANTLE_ADMIN_READS=system, or a brain not on workspaces: the system
 *    pool, as before W7a, for an Admin login only. The rollback switch
 *    restores only the read path (W7 integration fix 2, M6): the Admin
 *    step, the area checks, the item write check and the sandbox maker
 *    rule still ask this login (its gate scope), and only for a login that
 *    holds the Admin workspace now (W7 integration fix 3, L1). A login
 *    that is not an Admin user is never off its scope, and on a brain not
 *    on workspaces it is refused.
 *
 * The scope is read per call, as it always was (an HTTP request reads it
 * once: loginScopeFor keeps it for the request), so a login taken out of
 * its last workspace is refused at its next call.
 *
 * Also what an Admin step reads of the scope, for a caller read per call
 * (stdio): mcpAdminView, the reads adminToolGate made.
 */
import {
  AccessError,
  adminReadsOnSystemPool,
  brainOnWorkspacesNow,
  loginHasArea,
  loginScopeFor,
  scopeHasArea,
  scopeHoldsAdmin,
  withGateScope,
  withTurnScope,
  type AdminView,
  type PolicyScope,
  type WorkspaceScope,
} from '@mantle/db';
import { NO_SCOPE_ERROR } from '@mantle/std';

/** The reply for a login that is not an Admin user on a brain not on
 *  workspaces (W7b): it has no scope to run in. */
export const NOT_ON_WORKSPACES_ERROR =
  'This brain is not on workspaces yet, so only an admin login has MCP tools here.';

/** The refusal when the login holds no workspace at all: the gate's own
 *  no-scope refusal (@mantle/std NO_SCOPE_ERROR, one constant, in the
 *  words this surface has always said). Since A5 step 4 such a login lists
 *  no tools at all (owner decision A); a call still says this if the login
 *  lost its last workspace after it listed. */
export const NO_WORKSPACE_ERROR = NO_SCOPE_ERROR;

/** The login's scope now, or null on a brain not on workspaces (the one
 *  read of the switch-over here). */
async function scopeNow(loginId: string): Promise<WorkspaceScope | null> {
  return (await brainOnWorkspacesNow()) ? loginScopeFor(loginId) : null;
}

/** Whether this call goes to the system pool under the rollback switch:
 *  an Admin login that holds the Admin workspace now. */
async function onRollback(scope: WorkspaceScope, adminLogin: boolean): Promise<boolean> {
  return (
    adminLogin && adminReadsOnSystemPool() && (await withTurnScope(scope, () => scopeHoldsAdmin()))
  );
}

/**
 * The scope entry of `loginId`'s MCP calls (see the module comment), as a
 * gate caller's `enterScope`. `adminLogin`: the login is an Admin user (an
 * admin role that holds Admin now, or the stdio anchor): only it may go to
 * the system pool.
 */
export function mcpScopeEntry(
  loginId: string,
  adminLogin: boolean,
): <T>(writes: boolean, fn: () => Promise<T>) => Promise<T> {
  return async <T>(_writes: boolean, fn: () => Promise<T>): Promise<T> => {
    const scope = await scopeNow(loginId);
    if (!scope) {
      if (adminLogin) return fn();
      throw new AccessError('no-scope', NOT_ON_WORKSPACES_ERROR);
    }
    if (scope.ws.length === 0) throw new AccessError('no-scope');
    if (await onRollback(scope, adminLogin)) return withGateScope(scope, fn);
    return withTurnScope(scope, fn, { writes: true });
  };
}

/**
 * What a call's Admin step reads of `loginId`'s scope now (`need`: the
 * policy's Admin step), as adminToolGate read it in the call's scope:
 * whether it holds Admin and, for an area, the area (the login's own under
 * the rollback switch). Null: unscoped (a brain not on workspaces, an Admin
 * login), or no Admin step to read. A login in no workspace holds nothing
 * (its scope entry refuses the call first).
 */
export async function mcpAdminView(
  loginId: string,
  adminLogin: boolean,
  need: PolicyScope,
): Promise<AdminView | null> {
  if (need === 'any') return null;
  const scope = await scopeNow(loginId);
  if (!scope) return null;
  const area = typeof need === 'object' ? need.area : null;
  if (scope.ws.length === 0) return { holdsAdmin: false, areas: new Set() };
  if (await onRollback(scope, adminLogin)) {
    const areas = new Set<string>();
    if (area && (await loginHasArea(loginId, area as Parameters<typeof loginHasArea>[1]))) {
      areas.add(area);
    }
    return { holdsAdmin: true, areas };
  }
  return withTurnScope(scope, async () => {
    const holdsAdmin = await scopeHoldsAdmin();
    const areas = new Set<string>();
    if (holdsAdmin && area && (await scopeHasArea(area as Parameters<typeof scopeHasArea>[0]))) {
      areas.add(area);
    }
    return { holdsAdmin, areas };
  });
}
