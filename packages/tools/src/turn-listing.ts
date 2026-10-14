/**
 * What an assistant turn lists (workspaces arch A5 step 5, owner pick B,
 * plan 23.5): only the tools the one gate lets the turn call. A tool its
 * grants give but the gate refuses in this scope (an Admin-only tool or an
 * Admin-area tool in a workspace that does not hold Admin or the area, a
 * shell tool outside Admin, a create of an Admin-only kind outside Admin, a
 * row with no policy) is not offered to the model at all, where before the
 * model saw it and its call was refused. Listing equals calling: each tool
 * is asked by the ref dispatch calls it by (builtinToolRef for a builtin,
 * the `runtime-tool` ref for a row), for the turn's own caller
 * (gateCallerFor(turnCaller()), the scope the turn runs in).
 *
 * The listing changes with the scope, so an agent's tool list (and with it
 * the prompt cache's prefix) differs once per agent and scope from what it
 * was before this step: the cache resets once, then holds.
 */
import {
  gateLists,
  type GateCaller,
  type GatePolicy,
  type PolicyRef,
  type Tool,
  type ToolHandler,
} from '@mantle/db';
import { gateCallerFor, turnCaller } from './gate-callers';
import { runtimeToolPolicy } from './runtime-policy';
import { builtinToolGatePolicy, builtinToolRef } from './tool-gate-policy';

/** The ref and policy dispatch calls `tool` by, or null (no policy). */
function gateRefOf(tool: Tool): { ref: PolicyRef; policy: GatePolicy } | null {
  const h = tool.handler as ToolHandler | null;
  if (h?.kind === 'builtin') {
    const ref = builtinToolRef(h.ref, tool.slug);
    const policy = builtinToolGatePolicy(ref);
    return policy ? { ref, policy } : null;
  }
  const policy = runtimeToolPolicy(tool);
  if (!policy) return null;
  return { ref: Object.freeze({ kind: 'runtime-tool', name: tool.slug, row: tool }), policy };
}

/** The key of the Admin view a policy's step reads (one read per key). */
function viewKey(policy: GatePolicy): string {
  const s = policy.scope;
  return typeof s === 'object' ? `area:${String(s.area)}` : s;
}

/** The tools of `tools` an assistant turn in the current scope may call,
 *  in their order. */
export async function turnListedTools<T extends Tool>(tools: readonly T[]): Promise<T[]> {
  const callers = new Map<string, GateCaller>();
  const out: T[] = [];
  for (const tool of tools) {
    const asked = gateRefOf(tool);
    if (!asked) continue;
    const key = viewKey(asked.policy);
    let caller = callers.get(key);
    if (!caller) {
      caller = await gateCallerFor(turnCaller(), asked.policy, false);
      callers.set(key, caller);
    }
    if (gateLists(caller, asked.ref)) out.push(tool);
  }
  return out;
}
