/**
 * The workspaces part of GET /api/shell, for any login (workspaces W5a,
 * W7e): the login's live workspaces (the switcher), its Admin areas (an
 * Admin user's only) and whether it is the brain's anchor login. ONE builder
 * for the shell and GET /api/auth/whoami (the phone's first call), so both
 * answer the same. The read never fails the route: a failed read is logged
 * and answers no workspaces and no areas (shellPart).
 */
import type { NextResponse } from '@/server/http-compat';
import type { ShellWorkspace, WorkspaceArea } from '@mantle/client-types';
import type { getLoginOr401 } from '@/lib/auth';
import { shellPart } from '@/lib/shell-part';
import { shellWorkspaces, type WsCaller } from '@/lib/workspaces';

type Login = Exclude<Awaited<ReturnType<typeof getLoginOr401>>, NextResponse>;

/** The caller shape lib/workspaces.ts takes, for a resolved login. */
export function wsCallerOf(login: Login): WsCaller {
  return login.kind === 'admin'
    ? { kind: 'admin', loginId: login.loginId, anchorId: login.user.id, user: login.user }
    : login.kind === 'member'
      ? { kind: 'member', loginId: login.loginId, anchorId: login.member.anchorId, user: null }
      : { kind: 'client', loginId: login.loginId, anchorId: login.client.anchorId, user: null };
}

export async function loginWorkspaces(
  route: string,
  login: Login,
): Promise<{ workspaces: ShellWorkspace[]; areas: WorkspaceArea[]; isOwner: boolean }> {
  const caller = wsCallerOf(login);
  const ws = await shellPart(route, 'workspaces', () => shellWorkspaces(caller), {
    workspaces: [],
    areas: [],
  });
  return {
    workspaces: ws.workspaces,
    // Admin areas are an admin's only.
    areas: login.kind === 'admin' ? ws.areas : [],
    // The brain's anchor login (its id is the brain's).
    isOwner: login.kind === 'admin' && caller.loginId === caller.anchorId,
  };
}
