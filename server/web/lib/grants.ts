/**
 * The grants routes' layer. The Grant Access panel's rules live in
 * @mantle/content grants.ts, the one code path the routes (app/api/grants)
 * and the MCP grant tools (access_grant_add, access_grant_remove) share.
 * Here only what is a route's: the JSON answer, the `?confirm` param and the
 * move body's schema.
 */
import { z } from 'zod';
import { NextResponse } from '@/server/http-compat';
import type { Login } from '@/lib/auth/login';
import { workspaceCaller, type WsCaller } from '@/lib/workspaces';

export * from '@mantle/content/grants';

/** Run a grants route for the login the handler read (anyLoginCaller()):
 *  answer the result as JSON. A GrantError or a WsError answers
 *  `{ error, code }` by its row in the one table; anything else is the
 *  opaque 500.
 *
 *  It runs where the gate put the request: a login's read, and a
 *  member's write, in the login's own scope (the workspace role and its row
 *  rules; a write's transaction on the write role, or the system pool with
 *  the scope on it); an Admin user's write on the system pool with the
 *  login's scope on its transactions (session.ts anyLoginScope), so the
 *  database's own grant checks run for every caller (mantle_grant_change,
 *  0279). */
export async function grantsRoute(
  login: Login,
  fn: (caller: WsCaller) => Promise<unknown>,
  okStatus = 200,
): Promise<Response> {
  const out = await fn(workspaceCaller(login));
  return NextResponse.json(out, { status: okStatus });
}

/** `?confirm=1` (or true) on a DELETE, restore or hand. */
export function confirmParam(req: Request): boolean {
  const v = new URL(req.url).searchParams.get('confirm');
  return v === '1' || v === 'true';
}

/** The body of a move and of its preview. */
export const MoveBody = z.object({
  nodeIds: z.array(z.string().uuid()).min(1).max(200),
  toWorkspaceId: z.string().uuid().optional(),
  toFolderId: z.string().uuid().nullable().optional(),
  keepReadableIn: z.string().uuid().optional(),
  confirm: z.boolean().optional(),
  withContents: z.boolean().optional(),
  fromWorkspaceId: z.string().uuid().optional(),
});
