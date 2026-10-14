/**
 * Routes removed in workspaces W5c (review, team drafts, Team admin, the
 * client portal) and after. Each one stays as a stub that answers 410
 * `{ error, code: 'gone' }`, so an old UI or an old phone app can tell the
 * person to update instead of showing a vague error.
 *
 * A stub still answers the guard its route had: without a session the gate
 * and the guard answer 401 as before, a login of another kind is refused as
 * before, and the role sweeps keep proving who reaches what. Only a caller
 * the old route served gets the 410. The client portal's stubs answer any
 * login (there is no client login since workspaces W8a).
 *
 * Since A4 hand batch A the gate answers that guard, not the stub: the
 * route manifest generator reads `export const GET = gone('owner')` as a
 * handler that reads the caller of the stub's kind (GONE_KINDS,
 * lib/gone-kinds.ts, the one table), so the stub's row is a gone row (`gone`,
 * route-policy.ts) whose caller is that kind, and the gate's answer step
 * runs the kind's guard once, before the handler, as on every row a handler
 * reads (the one answer step: no second path at the gate). The stub then
 * reads the answer (fail closed: no answer of its kind, no 410) and answers
 * the 410. One line per stub, as before; no stub calls a guard.
 */
import { NextResponse } from '@/server/http-compat';
import { getRequestContext } from '@/server/request-context';
import { getMemberForAsset, loginCaller, memberCaller, ownerCaller } from '@/lib/auth';
import { GONE_KINDS, type GoneGuard } from './gone-kinds';

export { GONE_KINDS, type GoneGuard } from './gone-kinds';

/** The reader of each stub's kind (GONE_KINDS): it throws where the
 *  pipeline answered no caller of that kind (outside a routed request, a
 *  row not read as a gone row), so a stub never answers 410 to a caller
 *  nobody checked. */
const READERS = Object.freeze({ ownerCaller, memberCaller, loginCaller } satisfies Record<
  (typeof GONE_KINDS)[GoneGuard]['reader'],
  () => unknown
>);

export const GONE_MESSAGE = 'This feature was removed. Update the app.';

/** The personal-space routes (Mine, my apps, an admin's private items),
 *  removed in workspaces W6b: every personal item is a brain item in its
 *  login's private workspace, read and written through the normal routes. */
export const SPACE_FOLDED_MESSAGE =
  'Your own items are in your private workspace now. Open them from the normal lists.';

/** The member Library and accepted-item routes (/api/member/library*,
 *  /api/member/accepted*), removed in workspaces W7e: unused since W6b. */
export const LIBRARY_GONE_MESSAGE =
  'The Library is gone: open the items of your workspaces from the normal lists. Update the app.';

/** The per-login MCP switches and static login tokens (/api/mcp-logins),
 *  removed in workspaces W7b: every login has the one MCP surface in its
 *  own workspaces. */
export const MCP_LOGINS_GONE_MESSAGE =
  'There is no per-login MCP switch any more: every login reaches MCP in its own workspaces. Update the app.';

/** The agent and tool-group level routes (/api/access/agents/:slug,
 *  /api/access/tool-groups/:slug), removed in workspaces W7b. */
export const LEVELS_GONE_MESSAGE =
  'Agents and tool groups have no level any more: an assistant reads its workspace. Update the app.';

/** A member's own byte and app routes (/api/member/files/:id,
 *  /api/member/draws/:id/svg, /api/member/apps*), deprecated in workspaces
 *  W7e and removed in W8d: every login reads bytes on /api/files/files/:id
 *  and /api/draws/:id/svg, and runs an app on /api/apps/:id, in its scope. */
export const MEMBER_ROUTES_GONE_MESSAGE =
  'This route moved: files, drawings and apps open from the normal routes. Update the app.';

/** The 410 body every removed route answers. Each one is logged as
 *  `[gone] 410 <path>`, so a box's hits on retired routes can be counted
 *  from its log (scripts/arch-scoreboard-box.sh) before a stub is removed. */
export function goneResponse(error: string = GONE_MESSAGE): NextResponse {
  console.warn(`[gone] 410 ${getRequestContext()?.path ?? '?'}`);
  return NextResponse.json({ error, code: 'gone' }, { status: 410 });
}

/**
 * A handler for a removed route: the gate answered the old guard (its row's
 * caller is the stub's kind), then 410. Write it as the method's export, so
 * the generator reads it:
 *
 *   export const GET = gone('member');
 *   export const POST = gone('owner', 'Review is gone. Share items with Grant Access.');
 */
export function gone(kind: GoneGuard, error?: string): () => Promise<Response> {
  const read = READERS[GONE_KINDS[kind].reader];
  return async () => {
    read();
    return goneResponse(error);
  };
}

/**
 * A handler for a removed member BYTE route: its old guard (a member session,
 * or a member `?at=` asset token an <img> src carries) first, then 410.
 */
export function goneForMemberAsset(error?: string): (req: Request) => Promise<Response> {
  return async (req) => {
    const member = await getMemberForAsset(req);
    return member instanceof Response ? member : goneResponse(error);
  };
}
