/**
 * The gate's pre-run checks (@mantle/db gate.ts, PRE_RUN_CHECKS; workspaces
 * arch A5 step 3a), registered from here with the narrowers
 * (gate-narrowers.ts), so every process that dispatches has them. They run
 * after the Admin step and before the create home: a refused call never
 * makes a private workspace (owner decision, A3c audit).
 *
 *  - `item-precheck`: a built-in's declared preconditions (a uniform
 *    teaching error for an id that names a missing or wrong-type node),
 *    then the items its write names (toolItemWriteRefusal: the item
 *    routes' rule), in that order, as dispatch asked them before step 3a.
 *    A check that throws refuses in the error's words, as dispatch's catch
 *    answered.
 *  - `key-shared-content`: an API key or a linked brain never changes the
 *    content of an item others can read (key-shared-content.ts). Dormant
 *    until A5 step 4: no key or peer calls a tool through the gate yet.
 *
 * Each answers only the ref kinds it knows (`tool` here; the owner MCP
 * surface's `mcp-tool` in step 4) and lets every other through.
 */
import { registerPreRunCheck, type PreRunCheck } from '@mantle/db';
import { errorMessage } from '@mantle/std';
import { checkToolPreconditions } from './preconditions';
import { toolItemWriteRefusal } from './item-write-gate';
import { keySharedContentRefusal } from './key-shared-content';
import { tableBuiltin } from './tool-policy';
import type { ToolHandlerContext } from './types';

/** What dispatch puts in a call's context for the checks. */
export type PreRunContext = Readonly<{
  ownerId: string;
  surface?: ToolHandlerContext['surface'];
}>;

function contextOf(context: Readonly<Record<string, unknown>> | undefined): PreRunContext | null {
  const ownerId = context?.ownerId;
  return typeof ownerId === 'string' ? (context as PreRunContext) : null;
}

/** A builtin's preconditions, then the items its write names. */
export const itemPrecheck: PreRunCheck = async (_caller, _policy, ref, call) => {
  if (ref.kind !== 'tool') return null;
  const ctx = contextOf(call.context);
  // No owner, no check: dispatch always names one.
  if (!ctx) return null;
  const input = call.args ?? {};
  const slug = typeof ref.slug === 'string' ? ref.slug : ref.name;
  try {
    const pre = tableBuiltin(ref.name)?.preconditions;
    if (pre && pre.length > 0) {
      const failure = await checkToolPreconditions(pre, input, ctx.ownerId);
      if (failure && !failure.ok) return failure.error;
    }
    return await toolItemWriteRefusal(slug, input, ctx.ownerId, ref.name, {
      ...(ctx.surface ? { surface: ctx.surface } : {}),
    });
  } catch (err) {
    return errorMessage(err);
  }
};

/** A key's or a peer's change to content others read. */
export const keySharedContentCheck: PreRunCheck = async (caller, policy, ref, call) => {
  if (caller.via !== 'key' && caller.via !== 'peer') return null;
  if (ref.kind !== 'tool' && ref.kind !== 'mcp-tool') return null;
  if (policy.fields?.keySharedContent !== true) return null;
  const ctx = contextOf(call.context);
  if (!ctx || !call.args) return null;
  return keySharedContentRefusal(ctx.ownerId, call.args, caller.via);
};

/** Register both checks (the same functions again are a no-op). */
export function registerPreRunChecks(): void {
  registerPreRunCheck('item-precheck', itemPrecheck);
  registerPreRunCheck('key-shared-content', keySharedContentCheck);
}
