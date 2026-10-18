/**
 * The tools the A8 coverage (a8-coverage.test.ts) and the tool cells
 * (a8-tool-cells.matrix.test.ts) plan from: one list, so the counts the
 * coverage pins are the cells the matrix runs. The builtins, the heartbeat
 * tools, and the MCP surface's own (a name a builtin has is the builtin's).
 * Test support: no product code imports it.
 */
import type { A8ToolDef } from '@mantle/db/matrix/a8-tool-cells';
import { BUILTIN_TOOLS, MCP_SURFACE_POLICIES } from '@mantle/tools';
import { HEARTBEAT_TOOLS } from '../../../packages/runtime/src/heartbeats/tools';

export function a8AllTools(): A8ToolDef[] {
  const builtins = [...BUILTIN_TOOLS, ...HEARTBEAT_TOOLS] as unknown as A8ToolDef[];
  const names = new Set(builtins.map((b) => b.slug));
  const own = Object.entries(MCP_SURFACE_POLICIES)
    .filter(([slug]) => !names.has(slug))
    .map(([slug, policy]) => ({ slug, policy, mcpOnly: true }) as unknown as A8ToolDef);
  return [...builtins, ...own];
}
