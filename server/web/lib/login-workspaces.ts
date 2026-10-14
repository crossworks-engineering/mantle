/**
 * The workspaces part of GET /api/shell, for any login (workspaces W5a,
 * W7e): the login's live workspaces (the switcher), its Admin areas (an
 * Admin user's only) and whether it is the brain's anchor login. ONE builder
 * for the shell and GET /api/auth/whoami (the phone's first call), so both
 * answer the same. The read never fails the route: a failed read is logged
 * and answers no workspaces and no areas (shellPart).
 */
import type { ShellWorkspace, WorkspaceArea } from '@mantle/client-types';
import type { AnyLogin } from '@/lib/auth';
import { shellPart } from '@/lib/shell-part';
import { shellWorkspaces, workspaceCaller } from '@/lib/workspaces';

export async function loginWorkspaces(
  route: string,
  login: AnyLogin,
): Promise<{ workspaces: ShellWorkspace[]; areas: WorkspaceArea[]; isOwner: boolean }> {
  const caller = workspaceCaller(login);
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
