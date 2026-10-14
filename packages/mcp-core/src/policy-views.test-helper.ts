/**
 * Tests only: the owner MCP surface's former list views and name-keyed
 * functions, rebuilt from the policies (workspaces arch A5 step 6a deleted
 * them from @mantle/tools and @mantle/mcp-core: every consumer reads the
 * tool's policy). The snapshot and sweep tests read the old names from here,
 * so what each list held is still pinned to the literal committed before the
 * policies existed (mcp-surface-snapshot.test.ts, __snapshots__/), now
 * derived from the policies the consumers read.
 *
 * Each is what its view was: the builtins whose policy `pick` holds, plus
 * the MCP surface's own definitions (not builtins) it holds for.
 */
import {
  MCP_SURFACE_POLICIES,
  listBuiltins,
  policyAdminOnly,
  type ToolPolicy,
} from '@mantle/tools';
import { mcpToolPolicyOf } from './mcp-policy';
import { MCP_TOOL_DEFS } from './mcp-defs';
import { PEER_RISKY_TOOL_PREFIXES } from './login-surface';

type Pick = (p: ToolPolicy, def: { slug: string; ownerOnly?: boolean; optIn?: string }) => boolean;

/** The names of the builtins and the surface's own definitions `pick` holds
 *  for (a name a builtin has is the builtin's), read now. */
function namesWhere(pick: Pick, surface = true): ReadonlySet<string> {
  const out = new Set<string>();
  const builtins = listBuiltins();
  for (const def of builtins) if (pick(def.policy, def)) out.add(def.slug);
  if (surface) {
    const taken = new Set(builtins.map((d) => d.slug));
    for (const [slug, policy] of Object.entries(MCP_SURFACE_POLICIES)) {
      if (!taken.has(slug) && pick(policy as ToolPolicy, { slug })) out.add(slug);
    }
  }
  return out;
}

export const ADMIN_ONLY_TOOL_SLUGS = namesWhere(
  (p, def) => def.ownerOnly !== true && policyAdminOnly(p),
);
export const OWNER_ONLY_IN_SCOPE = namesWhere(
  (p, def) => def.ownerOnly === true && !policyAdminOnly(p),
  false,
);
export const ADMIN_KIND_CREATE_TOOL_SLUGS = namesWhere((p) => p.scope === 'admin-kind');
export const MCP_CREATE_TOOL_SLUGS = namesWhere((p) => p.creates !== undefined, false);
export const KEY_SHARED_CONTENT_TOOLS = namesWhere((p) => p.keySharedContent === true);
export const LIST_TOOLS = namesWhere((p) => p.keyEmail === true);
export const OWNER_KEY_SPENDING_TOOLS = namesWhere((p) => p.spends === 'ownerKey');
export const PEER_RISKY_TOOL_SLUGS = namesWhere((p) => p.peerRisky === true);
export const TOOLSMITH_WRITE_SLUGS = namesWhere((_p, def) => def.optIn === 'toolsmithWrite', false);
export const MCP_HANDWRITTEN_READ_ONLY: ReadonlySet<string> = new Set(
  MCP_TOOL_DEFS.filter((d) => d.policy.effect === 'read').map((d) => d.slug),
);

/** isAdminOnlyTool as it was: by slug or builtin ref, or ownerOnly and not
 *  one that runs in any user's scope. */
export function isAdminOnlyTool(slug: string, opts: { ref?: string; ownerOnly?: boolean } = {}) {
  const ref = opts.ref;
  if (ADMIN_ONLY_TOOL_SLUGS.has(slug) || (ref !== undefined && ADMIN_ONLY_TOOL_SLUGS.has(ref))) {
    return true;
  }
  return opts.ownerOnly === true && !OWNER_ONLY_IN_SCOPE.has(ref ?? slug);
}

/** Whether an owner MCP tool only reads (its policy's effect). */
export function isMcpToolReadOnly(slug: string): boolean {
  return mcpToolPolicyOf(slug)?.effect === 'read';
}

/** Whether a tool spends on the brain owner's keys (its policy). */
export function spendsOwnerKeys(slug: string): boolean {
  return mcpToolPolicyOf(slug)?.spends === 'ownerKey';
}

/** Risky for a peer or a key: the policy's `peerRisky`; a name no table
 *  holds, by its family (a risky family, or a mini app's, not its data's,
 *  tool), as before A5. */
export function isPeerRiskyTool(slug: string): boolean {
  const policy = mcpToolPolicyOf(slug);
  if (policy) return policy.peerRisky === true;
  return (
    PEER_RISKY_TOOL_PREFIXES.some((p) => slug.startsWith(p)) ||
    (slug.startsWith('app_') && !slug.startsWith('app_data_'))
  );
}

/** The owner tools a peer or a key bound to the owner may call, by name, as
 *  the MCP listing answered before the gate's peer narrower. */
export function ownerPeerAllows(
  slug: string,
  peer: { write: boolean; riskyAllowed?: readonly string[] },
): boolean {
  if (isPeerRiskyTool(slug) && !(peer.riskyAllowed ?? []).includes(slug)) return false;
  return peer.write || isMcpToolReadOnly(slug);
}
