/**
 * The owner MCP surface's side of the one gate (workspaces arch A3c; plan
 * sections 2, 8 and 20.3): what an MCP tool's policy is (the `mcp-tool`
 * source), and the gate caller of a prepared MCP connection. The surface
 * narrowers (a key's areas, a key's or peer's risky tools and Write switch,
 * spending on the owner's keys) live in @mantle/tools (gate-narrowers.ts),
 * so every process that dispatches registers them (fix round 2, M-A); they
 * read what this policy declares, and nothing else (A5 step 2: the peer
 * narrower reads the policy's `peerRisky` and effect, no rule by name).
 *
 * The policy is DECLARED (A5 step 2): a builtin's ToolPolicy, or a
 * hand-written MCP tool's (mcp-defs.ts), read by toGatePolicy. Nothing is
 * derived from a list. Since A5 step 4 the surface registers, lists and
 * calls through the gate (gated-tools.ts) with the callers here:
 * gate-policy.test.ts pins the listing to the one A5 step 2 snapshotted,
 * for every tool and every kind of caller, and that the call runs exactly
 * when the listing shows it.
 */
import {
  enterCall,
  loginActor,
  lookupPolicy,
  registerPolicySource,
  type Actor,
  type CreateHomeRule,
  type GateCaller,
  type GatePolicy,
  type PolicyRef,
} from '@mantle/db';
import type { OwnerSurfaceVia } from '@mantle/tools';
import { toGatePolicy } from '@mantle/tools';
import { UUID_RE } from '@mantle/std';
import { mcpToolPolicyOf } from './mcp-policy';
import { NO_WORKSPACE_CREATE_ERROR } from './create-home';
import { mcpAdminView, mcpScopeEntry } from './mcp-scope';
import { refusalReply, type McpGate } from './gated-tools';
import type { PreparedCallerTools } from './login-surface';

/**
 * The policy of one owner MCP tool (ref kind `mcp-tool`): its hand-written
 * definition's (mcp-defs.ts), else the builtin's, as the gate reads it. Any
 * other name has no entry.
 */
export function mcpToolPolicy(ref: PolicyRef): GatePolicy | null {
  const policy = mcpToolPolicyOf(ref.name);
  return policy ? toGatePolicy(policy) : null;
}

/**
 * The create home rule of an MCP connection (gate step 6; A5 step 4): its
 * fallback was resolved when it connected (the login's private workspace
 * when its scope does not hold Admin, made then), so the step makes
 * nothing at call time and runs first, before the pre-run checks: a
 * create's `workspace` argument is refused before the item it names, as
 * the surface always answered. A home that names no place is not set (an
 * Admin user's create with no `workspace`: the folder's, else Admin, the
 * database's own default). A login outside Admin with a private workspace
 * runs every call under it, reads too (W7b fix round 1, H2); one with
 * none has its creates refused, with a reply that says why (W7b fix round
 * 2).
 */
export function mcpCreateHomeRule(privateWs: string | null, noHome: boolean): CreateHomeRule {
  return Object.freeze({
    ownWork: privateWs !== null,
    first: true,
    namedOnly: true,
    ...(privateWs !== null ? { reads: true } : {}),
    ...(noHome ? { refuseCreates: NO_WORKSPACE_CREATE_ERROR } : {}),
  });
}

/** The login actor of an MCP connection, or null for a login id that is no
 *  uuid (a test's): the call runs with no actor of its own. */
function connectionActor(loginId: string, mode: 'rw' | 'ro' | 'owner'): Actor | null {
  return UUID_RE.test(loginId) ? loginActor(loginId, mode) : null;
}

/**
 * The gate's caller for a prepared MCP connection (login-surface.ts), or
 * null for a refused one. Its scope's Admin view is the one the listing
 * read (null: unscoped, an Admin login on a brain not on workspaces); its
 * scope too, so a login in no workspace lists nothing (owner decision A).
 * Each call enters the login's scope as mcp-scope.ts says, and names its
 * create home by the connection's rule.
 */
export function mcpGateCaller(prepared: PreparedCallerTools): GateCaller | null {
  if (prepared.kind === 'refused') return null;
  const { caller, view } = prepared;
  // An Admin user: an admin role that holds the Admin workspace now (W7
  // integration fix 3, L1; view null is a brain not on workspaces, where the
  // role decides). Only it may go to the system pool under the rollback
  // switch; an admin role taken out of Admin stays in its scope.
  const adminLogin = caller.role === 'admin' && (view === null || view.holdsAdmin);
  // Outside an Admin scope with no private workspace: no home for an item.
  const noHome = view !== null && !view.holdsAdmin && !prepared.privateWs;
  return Object.freeze({
    actor: connectionActor(caller.loginId, caller.write ? 'rw' : 'ro'),
    via: caller.via,
    loginId: caller.loginId,
    role: caller.role,
    write: caller.write,
    admin: view,
    // The scope the listing read (owner decision A: none, nothing listed).
    ...(prepared.scope ? { scope: prepared.scope } : {}),
    enterScope: mcpScopeEntry(caller.loginId, adminLogin),
    createFallback: { privateWs: prepared.privateWs },
    createHome: mcpCreateHomeRule(prepared.privateWs, noHome),
    facts: Object.freeze({
      keyAreas: caller.areas ?? null,
      riskyAllowed: caller.riskyAllowed ?? [],
    }),
  });
}

/**
 * The gate of the anchor's own connection: the stdio server (login(owner),
 * every call in the anchor's scope, its Admin view read per call as
 * adminToolGate read it), and a surface registered with no connection of
 * its own (tests). Lists everything its opt-ins register, as stdio always
 * has: the Admin step is the call's. `via` names a key's or a peer's path
 * for a surface that says it (the tests of their rules).
 */
export function defaultMcpGate(
  loginId: string,
  opts: { transport?: 'stdio' | 'http'; via?: OwnerSurfaceVia; loginNamed?: string } = {},
): McpGate {
  const via = opts.via === 'federation' ? 'peer' : opts.via === 'api' ? 'key' : 'stdio';
  const base: GateCaller = Object.freeze({
    actor: connectionActor(loginId, via === 'stdio' ? 'owner' : 'rw'),
    via,
    loginId,
    write: true,
    enterScope: mcpScopeEntry(loginId, true),
    createFallback: { privateWs: null },
    createHome: mcpCreateHomeRule(null, false),
    facts: Object.freeze({ keyAreas: null, riskyAllowed: [] }),
  });
  return Object.freeze({
    lists: Object.freeze({ ...base, admin: null }),
    callerFor: async (policy: GatePolicy) =>
      Object.freeze({ ...base, admin: await mcpAdminView(loginId, true, policy.scope) }),
  });
}

/**
 * One call of the owner MCP tool `name` for `loginId`, through the one gate
 * as the surface makes it (an OAuth connection of that login: its scope
 * entry, its Admin step read now, the narrowers, the pre-run checks), with
 * `fn` as the tool's body: `fn`'s value, or the refusal as the surface
 * replies it. What runInOwnerMcpScope was for the database tests of the
 * scope and the Admin step; the surface itself registers through
 * gated-tools.ts. `adminLogin`: the login is an Admin user (default yes).
 */
export async function runMcpCall<T>(
  loginId: string,
  name: string,
  fn: () => Promise<T>,
  opts: { adminLogin?: boolean } = {},
): Promise<T | ReturnType<typeof refusalReply>> {
  const adminLogin = opts.adminLogin !== false;
  const ref: PolicyRef = Object.freeze({ kind: 'mcp-tool', name });
  const policy = lookupPolicy(ref);
  const caller: GateCaller = Object.freeze({
    actor: connectionActor(loginId, 'rw'),
    via: 'oauth',
    loginId,
    write: true,
    admin: await mcpAdminView(loginId, adminLogin, policy.scope),
    enterScope: mcpScopeEntry(loginId, adminLogin),
    // The body names its own create home, as the tests' do.
    createHome: null,
    facts: Object.freeze({ keyAreas: null, riskyAllowed: [] }),
  });
  const res = await enterCall(caller, ref, fn);
  return res.ok ? res.value : refusalReply(res.refusal.toolText);
}

/** The narrowers' refusals: the narrowers live in @mantle/tools
 *  (gate-narrowers.ts), registered by every process that dispatches. */
export { KEY_AREA_ERROR, OWNER_KEYS_ERROR, RISKY_TOOL_ERROR } from '@mantle/tools';

registerPolicySource('mcp-tool', mcpToolPolicy);
