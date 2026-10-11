/**
 * The owner MCP surface runs in a scope (workspaces W7a): an Admin login's
 * MCP (OAuth, an API key, a peer bound to it, and stdio, which runs as the
 * anchor login) reads what that login's workspaces hold, like every other
 * user, never the whole system pool.
 *
 * Every tool registered on the owner surface is wrapped here, the
 * hand-written ones too: each CALL enters the login's scope
 * (loginScopeFor: the union of its live workspaces, Moderator where it is
 * one) as a turn scope that writes as an Admin user's mutating request does
 * (the system pool, with the scope set on its transactions for the
 * database's move, create and delete checks). Inside it the Admin gate
 * (@mantle/tools admin-gate.ts) runs first: an ownerOnly or adminOnly tool
 * needs a scope that holds Admin, an Admin-area tool the login's area. The
 * tool then runs in the scope, its preconditions too (W7a fix round 1, H1):
 * only the system-table tools of AREA_SYSTEM_TOOLS run whole on the system
 * pool; the others take the system pool only around their own system
 * tables. A write to an item is checked against the scope first
 * (register/context.ts, toolItemWriteRefusal: M2).
 *
 * MANTLE_ADMIN_READS=system, or a brain not on workspaces: the system pool,
 * as before W7a, for an Admin login only. Since W7b every login has this
 * surface: a login that is not an Admin user is never off its scope (the
 * rollback switch is about Admin reads), and on a brain not on workspaces
 * it is refused.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import {
  adminReadsOnSystemPool,
  brainOnWorkspacesNow,
  loginScopeFor,
  scopeHoldsAdmin,
  withGateScope,
  withTurnScope,
} from '@mantle/db';
import { adminToolGate, getBuiltin, runGated } from '@mantle/tools';

/** A tool reply that refuses the call. */
function refusal(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

/** The reply for a login that is not an Admin user on a brain not on
 *  workspaces (W7b): it has no scope to run in. */
export const NOT_ON_WORKSPACES_ERROR =
  'This brain is not on workspaces yet, so only an admin login has MCP tools here.';

/** The reply when the login holds no workspace at all. */
export const NO_WORKSPACE_ERROR =
  'This login is a user of no workspace on this brain, so its MCP reads nothing. Ask an admin to add it to one.';

/**
 * Run one call of tool `slug` in `loginId`'s scope, gated (see the module
 * comment). `call` is the tool's own handler.
 */
export async function runInOwnerMcpScope<T>(
  loginId: string,
  slug: string,
  call: () => Promise<T>,
  opts: { adminLogin?: boolean } = {},
): Promise<T | ReturnType<typeof refusal>> {
  const admin = opts.adminLogin !== false;
  if (!(await brainOnWorkspacesNow())) return admin ? call() : refusal(NOT_ON_WORKSPACES_ERROR);
  const scope = await loginScopeFor(loginId);
  if (scope.ws.length === 0) return refusal(NO_WORKSPACE_ERROR);
  // The rollback switch restores only the read path (W7 integration fix 2,
  // M6): an Admin login's call reads on the system pool again, while the
  // Admin tool gate, the area checks, the item write check and the sandbox
  // maker rule still ask this login (its gate scope). Only for a login that
  // holds the Admin workspace now (W7 integration fix 3, L1): an admin role
  // alone (a login taken out of Admin keeps its role) stays in its scope.
  if (admin && adminReadsOnSystemPool() && (await withTurnScope(scope, () => scopeHoldsAdmin()))) {
    return withGateScope(scope, async () => {
      const gate = await adminToolGate(slug, { ownerOnly: getBuiltin(slug)?.ownerOnly });
      if ('refused' in gate) return refusal(gate.refused);
      return call();
    });
  }
  return withTurnScope(
    scope,
    async () => {
      const gate = await adminToolGate(slug, { ownerOnly: getBuiltin(slug)?.ownerOnly });
      if ('refused' in gate) return refusal(gate.refused);
      return runGated(gate, call);
    },
    { writes: true },
  );
}

/**
 * `server`, with every tool registered on it from here on called in
 * `loginId`'s scope (runInOwnerMcpScope).
 */
export function ownerScopedServer(
  server: McpServer,
  loginId: string,
  opts: { adminLogin?: boolean } = {},
): McpServer {
  return new Proxy(server, {
    get(target, prop) {
      if (prop === 'registerTool') {
        const fn = Reflect.get(target, prop, target) as (...a: unknown[]) => unknown;
        return (name: unknown, config: unknown, cb: unknown) => {
          if (typeof name !== 'string' || typeof cb !== 'function') {
            return fn.call(target, name, config, cb);
          }
          const handler = cb as (args: unknown, extra: unknown) => Promise<unknown>;
          return fn.call(target, name, config, (args: unknown, extra: unknown) =>
            runInOwnerMcpScope(loginId, name, () => handler(args, extra), opts),
          );
        };
      }
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}
