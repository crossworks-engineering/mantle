/**
 * The owner MCP surface's side of the one gate (workspaces arch A3c; plan
 * sections 2, 8 and 20.3): what an MCP tool's policy is (the `mcp-tool`
 * source), and the gate caller of a prepared MCP connection. The surface
 * narrowers (a key's areas, a key's or peer's risky tools and Write switch,
 * spending on the owner's keys) live in @mantle/tools (gate-narrowers.ts),
 * so every process that dispatches registers them (fix round 2, M-A); they
 * read what this policy declares, and the peer narrower this surface's
 * rule by a tool's name (PEER_TOOL_RULE, registered here).
 *
 * The policy is DERIVED from today's lists (the registry's flags, the Admin
 * gate's tables, the risky and spending lists, the key areas): nothing is
 * copied. A5 declares the policy on each definition and deletes the lists;
 * until then gate-policy.test.ts pins that the gate lists exactly what
 * preparedAllows lists, for every tool and every kind of caller, and that
 * the call runs exactly when the listing shows it.
 *
 * A3c does not move the MCP surface onto the gate: registration, the
 * listing filter and the scope and create-home wrappers stay as they are
 * until A5.
 */
import {
  loginActor,
  registerPolicySource,
  type GateCaller,
  type GatePolicy,
  type PolicyRef,
} from '@mantle/db';
import {
  CREATE_TOOL_SLUGS,
  getBuiltin,
  isAdminOnlyTool,
  isBuiltinSpending,
  registerPeerToolRule,
  toolAdminArea,
  type PeerToolRule,
} from '@mantle/tools';
import { ADMIN_KIND_CREATE_TOOL_SLUGS } from './create-home';
import { toolKeyArea } from './key-scope';
import {
  isMcpToolReadOnly,
  isPeerRiskyTool,
  spendsOwnerKeys,
  type PreparedCallerTools,
} from './login-surface';

/**
 * The policy of one owner MCP tool (ref kind `mcp-tool`): a built-in by its
 * slug; a hand-written MCP tool only when the registration says it is one
 * (`ref.handWritten`, A5 makes them definitions). Any other name has no
 * entry.
 */
export function mcpToolPolicy(ref: PolicyRef): GatePolicy | null {
  const slug = ref.name;
  const def = getBuiltin(slug);
  if (!def && ref.handWritten !== true) return null;
  const area = toolAdminArea(slug);
  const scope = area
    ? Object.freeze({ area })
    : isAdminOnlyTool(slug, { ownerOnly: def?.ownerOnly })
      ? ('admin' as const)
      : ADMIN_KIND_CREATE_TOOL_SLUGS.has(slug)
        ? ('admin-kind' as const)
        : ('any' as const);
  return Object.freeze({
    effect: isMcpToolReadOnly(slug) ? ('read' as const) : ('write' as const),
    scope,
    spends: spendsOwnerKeys(slug)
      ? ('ownerKey' as const)
      : isBuiltinSpending(slug)
        ? ('model' as const)
        : ('none' as const),
    ...(CREATE_TOOL_SLUGS.has(slug) ? { creates: true } : {}),
    fields: Object.freeze({ keyArea: toolKeyArea(slug), peerRisky: isPeerRiskyTool(slug) }),
  });
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

/** The peer narrower's rule by a tool's name (@mantle/tools
 *  gate-narrowers.ts): this surface's own two lists, the ones
 *  ownerPeerAllows reads. */
export const PEER_TOOL_RULE: PeerToolRule = Object.freeze({
  risky: isPeerRiskyTool,
  readOnly: isMcpToolReadOnly,
});

registerPolicySource('mcp-tool', mcpToolPolicy);
registerPeerToolRule(PEER_TOOL_RULE);
