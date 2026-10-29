/**
 * The gate's pre-run checks (@mantle/db gate.ts, PRE_RUN_CHECKS), registered
 * from here with the narrowers (gate-narrowers.ts), so every process that
 * dispatches has them. They run after the Admin step and before the create
 * home: a refused call never makes a private workspace.
 *
 *  - `item-precheck`: first, for a write call of a turn or a run item in
 *    an assistant turn scope that holds a Moderator seat, the seat read again
 *    (moderator-seat.ts); then a built-in's declared preconditions (a uniform
 *    teaching error for an id that names a missing or wrong-type node), then,
 *    before a call is queued for approval, a create's target folder
 *    (createFolderRefusal) and the items the call names (queueItemRefusal: a
 *    call its run would refuse, in the run's words), in that order. No tool
 *    item pre-check runs at run time (docs/actors.md, "11. Tools"): the
 *    database's checks and the libraries' own item check (assertItemRight)
 *    refuse a write the scope may not make. A check that throws refuses in the
 *    error's words, as dispatch's catch would.
 *  - `key-shared-content`: an API key or a linked brain never changes the
 *    content of an item others can read (key-shared-content.ts), on the
 *    owner MCP surface.
 *
 * Each answers only the ref kinds it knows (`tool`, and the owner MCP
 * surface's `mcp-tool`: for the item pre-check only one that runs a
 * builtin) and lets every other through.
 */
import { registerPreRunCheck, type PolicyRef, type PreRunCheck } from '@mantle/db';
import { mcpVia } from './gate-callers';
import { errorMessage } from '@mantle/std';
import { checkToolPreconditions } from './preconditions';
import { createFolderRefusal } from './item-write-gate';
import { itemArgsOf, queueItemRefusal } from './item-args';
import { keySharedContentRefusal } from './key-shared-content';
import { MODERATOR_SEAT_CHANGED, moderatorSeatLost } from './moderator-seat';
import { tableBuiltin } from './tool-policy';
import type { ToolHandlerContext } from './types';

/** What dispatch puts in a call's context for the checks. */
export type PreRunContext = Readonly<{
  ownerId: string;
  surface?: ToolHandlerContext['surface'];
  /** The entry answers a thrown error itself (a /api/v1 route: app.onError):
   *  a check that throws throws on. */
  throws?: boolean;
  /** A /api/v1 route: its answer to a write the edit check refuses is the
   *  database's, never the pre-check's words as a 400. */
  entry?: 'api-v1';
  /** A turn's or a run item's call (dispatch): a write asks its Moderator
   *  seat again first (moderator-seat.ts). */
  seat?: true;
  /** Asked before a call is queued for approval (turnCallRefusal): a
   *  reference by slug or path that names nothing the queuing scope reads
   *  is refused, never queued. */
  queue?: boolean;
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
export const itemPrecheck: PreRunCheck = async (caller, policy, ref, call) => {
  const ctx = contextOf(call.context);
  // A turn's write whose Moderator seat was taken away since the turn began
  // (L5): refused, never written with the seat the scope still carries.
  if (ctx?.seat && !ctx.queue && policy.effect === 'write' && (await moderatorSeatLost())) {
    return MODERATOR_SEAT_CHANGED;
  }
  const builtin = builtinOf(ref);
  if (!builtin) return null;
  // No owner, no check: dispatch always names one.
  if (!ctx) return null;
  const input = call.args ?? {};
  try {
    const pre = tableBuiltin(builtin.handler)?.preconditions;
    if (pre && pre.length > 0) {
      const failure = await checkToolPreconditions(pre, input, ctx.ownerId);
      if (failure && !failure.ok) return failure.error;
    }
    if (ctx.queue) {
      const policy = tableBuiltin(builtin.handler)?.policy;
      const folder = await createFolderRefusal(
        policy?.createsIn,
        input,
        ctx.ownerId,
        policy?.makesFolders === true,
      );
      if (folder) return folder;
      // A call its run would refuse for an item it names: refused now, in the
      // run's words, never queued for an approver.
      if (policy?.effect === 'write') {
        const item = await queueItemRefusal(itemArgsOf(builtin.handler), input, ctx.ownerId);
        if (item) return item;
      }
    }
  } catch (err) {
    // An MCP call's surface answers a thrown error itself, and so does a
    // /api/v1 route (its app.onError: never a 400 with a database error's
    // text); every other entry reads it as the check's words.
    if (mcpVia(caller) || ctx.throws === true) throw err;
    return errorMessage(err);
  }
  return null;
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
