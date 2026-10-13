import { policySlugSet } from './tool-policy';

/**
 * The create tools that make an item of a workspace kind (page, note, draw,
 * table, file, folder, app, formula, task, event, recall map). MCP gives
 * them the `workspace` argument and names where the item landed
 * (@mantle/mcp-core create-home.ts). A create of an Admin-only kind is not
 * here. (An assistant turn makes the login's private workspace for any tool
 * that is not readOnly: turn-create-home.ts.) A view of the tool policy
 * table (tool-policy.ts, A5): the builtins whose policy `creates` a kind.
 */
export const CREATE_TOOL_SLUGS: ReadonlySet<string> = policySlugSet((p) => p.creates !== undefined);
