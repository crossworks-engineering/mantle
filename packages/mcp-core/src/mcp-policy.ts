/**
 * What the owner MCP surface knows of a tool (workspaces arch plan v2,
 * sections 8 and 23.3, A5 step 2): its policy, read from the hand-written
 * MCP definitions (mcp-defs.ts) and the builtin policy table (@mantle/tools
 * tool-policy.ts), never from a list keyed by name. The surface's own lists
 * (PEER_RISKY_TOOL_SLUGS, OWNER_KEY_SPENDING_TOOLS, KEY_SHARED_CONTENT_TOOLS
 * and the rest) are views of the two tables (mcpPolicySet), read live, and
 * kept under their names until A5 step 6 deletes them.
 *
 * A name neither table holds is a connector's tool (mcp_*, its policy is
 * connectorToolPolicy, on its row) or no tool at all: the surface's
 * functions answer it by its family as before (familyKeyArea, and
 * login-surface.ts familyPeerRisky), never as a tool with a policy.
 */
import { builtinPolicy, policySlugSet, type SurfaceToolDef, type ToolPolicy } from '@mantle/tools';
import { familyKeyArea, type KeyArea } from './key-scope';
import { MCP_TOOL_DEFS, mcpDefinition, type McpToolDef } from './mcp-defs';

/** The policy of the owner MCP tool `name`: its hand-written definition's
 *  (which wins a builtin's name: the eleven twins say the same, a test pins
 *  it), else the builtin's, else null. */
export function mcpToolPolicyOf(name: string): ToolPolicy | null {
  return mcpDefinition(name)?.policy ?? builtinPolicy(name);
}

/** The names of every tool the surface can register (the builtins and the
 *  hand-written definitions) whose policy `pick` holds, as a read-only Set
 *  read live from the two tables. */
export function mcpPolicySet(
  pick: (p: ToolPolicy, def: SurfaceToolDef) => boolean,
): ReadonlySet<string> {
  return policySlugSet(pick, { surface: pick, requireSurface: true });
}

/** The names of the hand-written MCP definitions `pick` holds for, as a
 *  read-only Set (the table is fixed at load). */
export function mcpDefinitionSet(pick: (def: McpToolDef) => boolean): ReadonlySet<string> {
  const set = new Set(MCP_TOOL_DEFS.filter(pick).map((d) => d.slug));
  const refuse = () => {
    throw new TypeError('a tool policy view is read only: change the policy on the definition');
  };
  for (const key of ['add', 'delete', 'clear']) Object.defineProperty(set, key, { value: refuse });
  return Object.freeze(set);
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

/**
 * Tools that change the CONTENT of an existing page or note (M2 audit N3):
 * their policy's `keySharedContent`. Content can embed other items (a file,
 * a drawing, another page), and an item embedded in a page others can read
 * becomes readable to them too (migration 0208), with no confirm. A key
 * cannot confirm, so on an item others can read these tools refuse a key
 * (register/context.ts).
 */
export const KEY_SHARED_CONTENT_TOOLS: ReadonlySet<string> = mcpPolicySet(
  (p) => p.keySharedContent === true,
);
