/**
 * One-way bridge so a module the registry can reach can call dispatchTool
 * without importing dispatch.ts — which imports the registry, which imports
 * every builtin, which closed a 6-file cycle (2026-09-02 audit, complexity C6).
 * dispatch.ts registers itself at module init; same shape as agent-bridge.ts.
 *
 * Two callers: the toolsmith's api_tool_test / recipe_tool_test, and pending.ts
 * — which builtins-pending.ts imports, so its static `./dispatch` import had
 * closed the cycle again since v0.232.134. module-graph.test.ts now fails if
 * any of these entrypoints stops being importable on its own.
 */
import type { Tool } from '@mantle/db';
import type { ToolHandlerContext, ToolHandlerResult } from './types';

export type ToolDispatcher = (
  tool: Tool,
  input: Record<string, unknown>,
  ctx: ToolHandlerContext,
) => Promise<ToolHandlerResult>;

let registered: ToolDispatcher | null = null;

export function registerToolDispatcher(fn: ToolDispatcher): void {
  registered = fn;
}

/** dispatchTool via the bridge. Throws a clear error if dispatch.ts has not
 *  been loaded in this process (it always is in the real runtime — index.ts
 *  exports it — so this only bites a test that imports a builtin in isolation). */
export function dispatchViaBridge(
  tool: Tool,
  input: Record<string, unknown>,
  ctx: ToolHandlerContext,
): Promise<ToolHandlerResult> {
  if (!registered)
    throw new Error('tool dispatcher not registered: import @mantle/tools/dispatch first');
  return registered(tool, input, ctx);
}
