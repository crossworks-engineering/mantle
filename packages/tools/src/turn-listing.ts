/**
 * What a tool loop lists (workspaces arch A5 step 5, owner pick B,
 * plan 23.5): only the tools the one gate lets the loop call. Asked in one
 * place, the loop's own tool rows (loopToolRows in
 * packages/runtime/src/agent/tool-loop.ts), so an assistant turn, a
 * delegated child, a heartbeat fire and a run's worker turn all follow. A tool its
 * grants give but the gate refuses in this scope (an Admin-only tool or an
 * Admin-area tool in a workspace that does not hold Admin or the area, a
 * shell tool outside Admin, a create of an Admin-only kind outside Admin, a
 * row with no policy, and since A5 step 6a an owner-only tool off the
 * owner's surface and a connector the scope does not hold or may not write)
 * is not offered to the model at all, where before the
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
  gateCallRefusal,
  gateLists,
  type GateCaller,
  type GatePolicy,
  type PolicyRef,
  type Tool,
  type ToolHandler,
} from '@mantle/db';
import { errorMessage } from '@mantle/std';
import { gateCallerFor, turnCaller } from './gate-callers';
import { NO_RUNTIME_POLICY_ERROR, runtimeToolPolicy } from './runtime-policy';
import { isOwnerSurface } from './surface';
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

/** The key of the caller a policy needs (one caller per key): the Admin
 *  view its step reads, and a connector row's group (the connector
 *  narrower's resource rows). */
function callerKey(tool: Tool, policy: GatePolicy): string {
  const s = policy.scope;
  const view = typeof s === 'object' ? `area:${String(s.area)}` : s;
  if (policy.fields?.mark === undefined) return view;
  const group = (tool.handler as { group?: unknown } | null)?.group;
  return `${view}|connector:${String(group)}`;
}

/** What a loop's listing knows of its turn (A5 step 6a, carried L1): its
 *  owner, and its surface, read by isOwnerSurface as turnCallRefusal reads
 *  the call's (fix round 1, LOW-3: one rule). No `surface` key: not known,
 *  and an owner-only tool is not narrowed by it here; a `surface` key that
 *  holds undefined is a missing surface, never the owner's. */
export type TurnListingFacts = Readonly<{
  ownerId?: string;
  surface?: ToolHandlerContext['surface'];
}>;

/** The tools of `tools` a tool loop in the current scope may call,
 *  in their order. */
export async function turnListedTools<T extends Tool>(
  tools: readonly T[],
  facts: TurnListingFacts = {},
): Promise<T[]> {
  const callers = new Map<string, GateCaller>();
  const out: T[] = [];
  const known = {
    ...(facts.ownerId !== undefined ? { ownerId: facts.ownerId } : {}),
    ...('surface' in facts ? { ownerSurface: isOwnerSurface(facts.surface) } : {}),
  };
  for (const tool of tools) {
    const asked = gateRefOf(tool);
    if (!asked) continue;
    const key = callerKey(tool, asked.policy);
    let caller = callers.get(key);
    if (!caller) {
      caller = await gateCallerFor(turnCaller(), asked.policy, false, { ...known, row: tool });
      callers.set(key, caller);
    }
    if (gateLists(caller, asked.ref)) out.push(tool);
  }
  return out;
}

/**
 * The refusal the one gate gives a tool loop's call of `tool` with `input`
 * in the current scope before it runs anything (steps 3 to 5, the
 * owner-only and connector narrowers among them since A5 step 6a, and the
 * gate's pre-run checks: the item pre-check reads the call's arguments),
 * in the words dispatch would answer; null when it lets the call through.
 * Asked before a call that needs approval is queued (A5 step 5 fix rounds
 * 1 and 2): the approved call runs later in the approver's scope, so a call
 * the loop's own scope may not make (a workspace heartbeat's
 * `telegram_send`, a member turn's shell row, a `page_delete` of an item
 * only Admin may change) is refused here, in the gate's words, and never
 * queued. For the caller dispatch uses (turnCaller), through the gate's own
 * steps (gateCallRefusal), so queue time and dispatch read one rule. A
 * connector's marked inputs are checked at dispatch, after approval.
 */
export async function turnCallRefusal(
  tool: Tool,
  input: Record<string, unknown>,
  ctx: Pick<ToolHandlerContext, 'ownerId' | 'surface'>,
): Promise<string | null> {
  const h = tool.handler as ToolHandler | null;
  const call = {
    args: input,
    // `queue`: a reference by slug or path must resolve in this scope (A5
    // step 6a, carried round-2 LOW-1; gate-prerun.ts).
    context: {
      ownerId: ctx.ownerId,
      ...(ctx.surface ? { surface: ctx.surface } : {}),
      queue: true,
    },
  };
  const facts = { ownerSurface: isOwnerSurface(ctx.surface), ownerId: ctx.ownerId };
  try {
    if (h?.kind === 'builtin') {
      // A builtin with no policy meets the gate's step 3, as at dispatch.
      const ref = builtinToolRef(h.ref, tool.slug);
      const caller = await gateCallerFor(turnCaller(), builtinToolGatePolicy(ref), true, facts);
      return (await gateCallRefusal(caller, ref, call))?.toolText ?? null;
    }
    const asked = gateRefOf(tool);
    if (!asked) return NO_RUNTIME_POLICY_ERROR;
    const caller = await gateCallerFor(turnCaller(), asked.policy, false, { ...facts, row: tool });
    return (await gateCallRefusal(caller, asked.ref, call))?.toolText ?? null;
  } catch (err) {
    // Fail closed: a check that could not run queues nothing (dispatch
    // answers the same error as the call's text).
    return errorMessage(err);
  }
}
