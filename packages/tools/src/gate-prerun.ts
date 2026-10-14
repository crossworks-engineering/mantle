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
 *    answered. On a /api/v1 route an item the edit check refuses is
 *    thrown as the database's refusal (A5 step 4 fix round 2).
 *  - `key-shared-content`: an API key or a linked brain never changes the
 *    content of an item others can read (key-shared-content.ts), on the
 *    owner MCP surface (A5 step 4).
 *
 * Each answers only the ref kinds it knows (`tool`, and the owner MCP
 * surface's `mcp-tool`: for the item pre-check only one that runs a
 * builtin) and lets every other through.
 */
import {
  registerPreRunCheck,
  type ItemWriteRefusal,
  type PolicyRef,
  type PreRunCheck,
} from '@mantle/db';
import { mcpVia } from './gate-callers';
import { editCheckRefusalError, errorMessage } from '@mantle/std';
import { checkToolPreconditions } from './preconditions';
import { toolItemWriteRefusalOf } from './item-write-gate';
import { keySharedContentRefusal } from './key-shared-content';
import { tableBuiltin } from './tool-policy';
import type { ToolHandlerContext } from './types';

/** What dispatch puts in a call's context for the checks. */
export type PreRunContext = Readonly<{
  ownerId: string;
  surface?: ToolHandlerContext['surface'];
  /** The entry answers a thrown error itself (a /api/v1 route: app.onError,
   *  A5 step 4 fix round 1, M1): a check that throws throws on. */
  throws?: boolean;
  /** A /api/v1 route (A5 step 4 fix round 2): its answer to a write the
   *  edit check refuses is the database's, as before it ran through
   *  dispatch, never the pre-check's words as a 400. */
  entry?: 'api-v1';
}>;

function contextOf(context: Readonly<Record<string, unknown>> | undefined): PreRunContext | null {
  const ownerId = context?.ownerId;
  return typeof ownerId === 'string' ? (context as PreRunContext) : null;
}

/** The builtin a ref runs, and the slug the item lists match: a `tool`
 *  ref's (its handler ref, the row's slug), or a builtin called on the
 *  owner MCP surface (an `mcp-tool` ref that names the builtin it runs;
 *  a hand-written MCP tool names none and checks its own items). */
function builtinOf(ref: PolicyRef): { handler: string; slug: string } | null {
  if (ref.kind === 'tool') {
    return { handler: ref.name, slug: typeof ref.slug === 'string' ? ref.slug : ref.name };
  }
  if (ref.kind === 'mcp-tool' && typeof ref.builtin === 'string') {
    return { handler: ref.builtin, slug: ref.builtin };
  }
  return null;
}

/** A builtin's preconditions, then the items its write names. */
export const itemPrecheck: PreRunCheck = async (caller, _policy, ref, call) => {
  const builtin = builtinOf(ref);
  if (!builtin) return null;
  const ctx = contextOf(call.context);
  // No owner, no check: dispatch always names one.
  if (!ctx) return null;
  const input = call.args ?? {};
  let refused: ItemWriteRefusal | null;
  try {
    const pre = tableBuiltin(builtin.handler)?.preconditions;
    if (pre && pre.length > 0) {
      const failure = await checkToolPreconditions(pre, input, ctx.ownerId);
      if (failure && !failure.ok) return failure.error;
    }
    refused = await toolItemWriteRefusalOf(builtin.slug, input, ctx.ownerId, builtin.handler, {
      ...(ctx.surface ? { surface: ctx.surface } : {}),
    });
  } catch (err) {
    // An MCP call's surface answers a thrown error itself, as it always
    // has (A5 step 4), and so does a /api/v1 route (its app.onError, as
    // before it ran through dispatch: never a 400 with a database error's
    // text); every other entry reads it as the check's words.
    if (mcpVia(caller) || ctx.throws === true) throw err;
    return errorMessage(err);
  }
  if (!refused) return null;
  // A /api/v1 route: its HTTP item gate (itemWriteGate) refuses such a
  // write first, with its own 403 or 404; one that got past it met the
  // database's edit check at the handler's write before the route ran
  // through dispatch, which app.onError answers (403 item-workspace, or 404
  // for an item the scope does not read). The same refusal, thrown, gets
  // the same status and body from the one mapper.
  if (ctx.entry === 'api-v1' && refused.detail) throw editCheckRefusalError(refused.detail);
  return refused.message;
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
