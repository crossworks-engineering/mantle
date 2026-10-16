/**
 * How an owner MCP call enters its login's scope (workspaces W7a; arch A5
 * step 4: the caller's `enterScope`, run by the one gate, @mantle/db
 * gate.ts). Every login's MCP (OAuth, an API key, a peer bound to it, and
 * stdio, which runs as the anchor login) reads what that login's
 * workspaces hold, like every other user, never the whole system pool:
 *
 *  - each call enters the login's scope (loginScopeFor: the union of its
 *    live workspaces, Moderator where it is one) as a turn scope that
 *    writes as an Admin user's mutating request does (the system pool,
 *    with the scope set on its transactions for the database's move,
 *    create and delete checks);
 *  - a login in no workspace has no scope: refused (NO_SCOPE_ERROR).
 *
 * The scope is read per call, as it always was (an HTTP request reads it
 * once: loginScopeFor keeps it for the request), so a login taken out of
 * its last workspace is refused at its next call. Since arch A7 there is
 * no system-pool path here (no rollback switch, no brain off workspaces).
 *
 * Also what an Admin step reads of the scope, for a caller read per call
 * (stdio): mcpAdminView, the reads adminToolGate made.
 */
import {
  AccessError,
  loginScopeFor,
  scopeHasArea,
  scopeHoldsAdmin,
  withTurnScope,
  type AdminView,
  type PolicyScope,
} from '@mantle/db';
import { NO_SCOPE_ERROR } from '@mantle/std';

/** The refusal when the login holds no workspace at all: the gate's own
 *  no-scope refusal (@mantle/std NO_SCOPE_ERROR, one constant, in the
 *  words this surface has always said). Since A5 step 4 such a login lists
 *  no tools at all (owner decision A) and the connection's instructions
 *  say why (login-surface.ts MCP_NO_WORKSPACE_INSTRUCTIONS). A login that
 *  loses its last workspace mid-session does not read these words on its
 *  next call: each HTTP request lists afresh, so the tool is not registered
 *  and the SDK answers "Tool X not found" (fix round 1, LOW-2). */
export const NO_WORKSPACE_ERROR = NO_SCOPE_ERROR;

/**
 * The scope entry of `loginId`'s MCP calls (see the module comment), as a
 * gate caller's `enterScope`.
 */
export function mcpScopeEntry(
  loginId: string,
): <T>(writes: boolean, fn: () => Promise<T>) => Promise<T> {
  return async <T>(_writes: boolean, fn: () => Promise<T>): Promise<T> => {
    const scope = await loginScopeFor(loginId);
    if (scope.ws.length === 0) throw new AccessError('no-scope');
    return withTurnScope(scope, fn, { writes: true });
  };
}

/**
 * What a call's Admin step reads of `loginId`'s scope now (`need`: the
 * policy's Admin step), as adminToolGate read it in the call's scope:
 * whether it holds Admin and, for an area, the area. Null: no Admin step to
 * read. A login in no workspace holds nothing (its scope entry refuses the
 * call first).
 */
export async function mcpAdminView(loginId: string, need: PolicyScope): Promise<AdminView | null> {
  if (need === 'any') return null;
  const scope = await loginScopeFor(loginId);
  const area = typeof need === 'object' ? need.area : null;
  if (scope.ws.length === 0) return { holdsAdmin: false, areas: new Set() };
  return withTurnScope(scope, async () => {
    const holdsAdmin = await scopeHoldsAdmin();
    const areas = new Set<string>();
    if (holdsAdmin && area && (await scopeHasArea(area as Parameters<typeof scopeHasArea>[0]))) {
      areas.add(area);
    }
    return { holdsAdmin, areas };
  });
}
