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
 * derived from a list. gate-policy.test.ts pins that the gate lists exactly
 * what preparedAllows lists, for every tool and every kind of caller, and
 * that the call runs exactly when the listing shows it.
 *
 * Registration, the listing filter and the scope and create-home wrappers
 * move onto the gate in A5 step 4.
 */
import {
  loginActor,
  registerPolicySource,
  type GateCaller,
  type GatePolicy,
  type PolicyRef,
} from '@mantle/db';
import { toGatePolicy } from '@mantle/tools';
import { mcpToolPolicyOf } from './mcp-policy';
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

/** The gate's caller for a prepared MCP connection (login-surface.ts), or
 *  null for a refused one. Its scope's Admin view is the one the listing
 *  read (null: unscoped, an Admin login on a brain not on workspaces). */
export function mcpGateCaller(prepared: PreparedCallerTools): GateCaller | null {
  if (prepared.kind === 'refused') return null;
  const { caller } = prepared;
  return Object.freeze({
    actor: loginActor(caller.loginId, caller.write ? 'rw' : 'ro'),
    via: caller.via,
    loginId: caller.loginId,
    write: caller.write,
    admin: prepared.view,
    createFallback: { privateWs: prepared.privateWs },
    facts: Object.freeze({
      keyAreas: caller.areas ?? null,
      riskyAllowed: caller.riskyAllowed ?? [],
    }),
  });
}

/** The narrowers' refusals: the narrowers live in @mantle/tools
 *  (gate-narrowers.ts), registered by every process that dispatches. */
export { KEY_AREA_ERROR, OWNER_KEYS_ERROR, RISKY_TOOL_ERROR } from '@mantle/tools';

registerPolicySource('mcp-tool', mcpToolPolicy);
