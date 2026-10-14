/**
 * What the owner MCP surface knows of a tool (workspaces arch plan v2,
 * sections 8 and 23.3, A5 step 2): its policy, read from the hand-written
 * MCP definitions (mcp-defs.ts) and the builtin policy table (@mantle/tools
 * tool-policy.ts), never from a list keyed by name. A5 step 6a deleted the
 * surface's own lists (PEER_RISKY_TOOL_SLUGS, OWNER_KEY_SPENDING_TOOLS,
 * KEY_SHARED_CONTENT_TOOLS and the rest, views of the two tables): each
 * consumer reads the tool's policy (mcpToolPolicyOf). Key content changes
 * are the policy's `keySharedContent` (a key cannot confirm, so on an item
 * others can read such a tool refuses a key: the gate's key-shared-content
 * pre-run check).
 *
 * A name neither table holds is a connector's tool (mcp_*, its policy is
 * connectorToolPolicy, on its row) or no tool at all: the surface's
 * functions answer it by its family as before (familyKeyArea, and
 * login-surface.ts familyPeerRisky), never as a tool with a policy.
 */
import { builtinPolicy, type ToolPolicy } from '@mantle/tools';
import { familyKeyArea, type KeyArea } from './key-scope';
import { mcpDefinition } from './mcp-defs';

/** The policy of the owner MCP tool `name`: its hand-written definition's
 *  (which wins a builtin's name: the eleven twins say the same, a test pins
 *  it), else the builtin's, else null. */
export function mcpToolPolicyOf(name: string): ToolPolicy | null {
  return mcpDefinition(name)?.policy ?? builtinPolicy(name);
}

/** The area a tool belongs to (its policy's `keyArea`), or null (open only
 *  to an all-areas key). A conversion tool (`page_from_journal`,
 *  `note_from_file`) declares none (M2 audit F2): in the target's area it
 *  would let a pages key read the journal through `page_from_journal`. A
 *  name no table holds: by its family (key-scope.ts familyKeyArea). */
export function toolKeyArea(slug: string): KeyArea | null {
  const policy = mcpToolPolicyOf(slug);
  if (policy) return (policy.keyArea ?? null) as KeyArea | null;
  return familyKeyArea(slug);
}

/** Whether a key limited to `areas` (null = all) may have this tool. */
export function keyAreasAllowTool(slug: string, areas: readonly string[] | null): boolean {
  if (areas === null) return true;
  const area = toolKeyArea(slug);
  return area !== null && areas.includes(area);
}
