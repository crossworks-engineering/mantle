/**
 * What a tool loop lists (workspaces arch A5 step 5, owner pick B,
 * plan 23.5): only the tools the one gate lets the loop call. Asked in one
 * place, the loop's own tool rows (loopToolRows in
 * packages/runtime/src/agent/tool-loop.ts), so an assistant turn, a
 * delegated child, a heartbeat fire and a run's worker turn all follow. A tool its
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
  gateCheck,
  gateLists,
  type GateCaller,
  type GatePolicy,
  type PolicyRef,
  type Tool,
  type ToolHandler,
} from '@mantle/db';
import { gateCallerFor, turnCaller } from './gate-callers';
import { getBuiltin } from './registry';
import { NO_RUNTIME_POLICY_ERROR, runtimeToolPolicy } from './runtime-policy';
import { isOwnerSurface, OWNER_ONLY_ERROR } from './surface';
import type { ToolHandlerContext } from './types';
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

/** The tools of `tools` a tool loop in the current scope may call,
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

/**
 * The refusal the one gate gives a tool loop's call of `tool` in the current
 * scope before it binds anything (steps 3 to 5, and dispatch's owner-only
 * check), in the words dispatch would answer; null when it lets the call
 * through. Asked before a call that needs approval is queued (A5 step 5 fix
 * round 1, M2): the approved call runs later in the approver's scope, so a
 * call the loop's own scope may not make (a workspace heartbeat's
 * `telegram_send`, a member turn's shell row) is refused here, in the
 * gate's words, and never queued. For the caller dispatch uses (turnCaller).
 * The item pre-check and a connector's own argument checks read the call
 * and run at dispatch, after approval.
 */
export async function turnCallRefusal(
  tool: Tool,
  surface: ToolHandlerContext['surface'],
): Promise<string | null> {
  const h = tool.handler as ToolHandler | null;
  if (h?.kind === 'builtin' && getBuiltin(h.ref)?.ownerOnly && !isOwnerSurface(surface)) {
    return OWNER_ONLY_ERROR;
  }
  if (h?.kind === 'builtin') {
    // A builtin with no policy meets the gate's step 3, as at dispatch.
    const ref = builtinToolRef(h.ref, tool.slug);
    const caller = await gateCallerFor(turnCaller(), builtinToolGatePolicy(ref), true);
    return gateCheck(caller, ref)?.message ?? null;
  }
  const asked = gateRefOf(tool);
  if (!asked) return NO_RUNTIME_POLICY_ERROR;
  const caller = await gateCallerFor(turnCaller(), asked.policy, false);
  return gateCheck(caller, asked.ref)?.message ?? null;
}
