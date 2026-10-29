/**
 * The workspaces part of GET /api/shell, for any login: the login's live
 * workspaces (the switcher), its Admin areas (an
 * Admin user's only) and whether it is the brain's anchor login. ONE builder
 * for the shell and GET /api/auth/whoami (the phone's first call), so both
 * answer the same. The read never fails the route: a failed read is logged
 * and answers no workspaces and no areas (shellPart).
 */
import type { ShellWorkspace, WorkspaceArea } from '@mantle/client-types';
import { shellPart } from '@/lib/shell-part';
import { shellWorkspaces, type WsCaller } from '@/lib/workspaces';

/** `admin`: whether the login is an Admin user, as the route asked it (the
 *  shell: adminFacts). */
export async function loginWorkspaces(
  route: string,
  caller: WsCaller,
  admin: boolean,
): Promise<{ workspaces: ShellWorkspace[]; areas: WorkspaceArea[]; isOwner: boolean }> {
  const ws = await shellPart(route, 'workspaces', () => shellWorkspaces(caller), {
    workspaces: [],
    areas: [],
  });
  return {
    workspaces: ws.workspaces,
    // Admin areas are an admin's only.
    areas: admin ? ws.areas : [],
    // The brain's anchor login (its id is the brain's).
    isOwner: admin && caller.loginId === caller.anchorId,
  };
}
