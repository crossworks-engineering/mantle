/**
 * Routes removed in workspaces W5c (review, team drafts, Team admin, the
 * client portal). Each one stays as a stub that answers 410
 * `{ error, code: 'gone' }`, so an old UI or an old phone app can tell the
 * person to update instead of showing a vague error.
 *
 * A stub still runs the guard its route had: without a session the gate and
 * the guard answer 401 as before, a login of another role is refused as
 * before, and the role sweeps keep proving who reaches what. Only a caller
 * the old route served gets the 410.
 */
import { NextResponse } from '@/server/http-compat';
import { getClientOr401, getLoginOr401, getMemberOr401, getOwnerOr401 } from '@/lib/auth';

/** Who the removed route served. */
export type GoneGuard = 'owner' | 'member' | 'client' | 'any';

export const GONE_MESSAGE = 'This feature was removed. Update the app.';

/** The personal-space routes (Mine, my apps, an admin's private items),
 *  removed in workspaces W6b: every personal item is a brain item in its
 *  login's private workspace, read and written through the normal routes. */
export const SPACE_FOLDED_MESSAGE =
  'Your own items are in your private workspace now. Open them from the normal lists.';

/** The per-login MCP switches and static login tokens (/api/mcp-logins),
 *  removed in workspaces W7b: every login has the one MCP surface in its
 *  own workspaces. */
export const MCP_LOGINS_GONE_MESSAGE =
  'There is no per-login MCP switch any more: every login reaches MCP in its own workspaces. Update the app.';

/** The agent and tool-group level routes (/api/access/agents/:slug,
 *  /api/access/tool-groups/:slug), removed in workspaces W7b. */
export const LEVELS_GONE_MESSAGE =
  'Agents and tool groups have no level any more: an assistant reads its workspace. Update the app.';

/** The 410 body every removed route answers. */
export function goneResponse(error: string = GONE_MESSAGE): NextResponse {
  return NextResponse.json({ error, code: 'gone' }, { status: 410 });
}

async function guard(kind: GoneGuard): Promise<Response | null> {
  const got =
    kind === 'owner'
      ? await getOwnerOr401()
      : kind === 'member'
        ? await getMemberOr401()
        : kind === 'client'
          ? await getClientOr401()
          : await getLoginOr401();
  return got instanceof Response ? got : null;
}

/**
 * A handler for a removed route: the old guard first, then 410.
 *
 *   export const GET = gone('member');
 *   export const POST = gone('owner', 'Review is gone. Share items with Grant Access.');
 */
export function gone(kind: GoneGuard, error?: string): () => Promise<Response> {
  return async () => (await guard(kind)) ?? goneResponse(error);
}
