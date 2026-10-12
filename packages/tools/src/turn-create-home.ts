/**
 * Where an assistant turn's creates land (workspaces arch A0; F12): the
 * home rule of docs/workspaces.md ("Where a new item lands"), through the
 * function the web routes use (@mantle/db resolveCreateHome), so a create
 * made from a tool in a turn lands where the same login's create from the
 * web would.
 *
 *  - A workspace assistant's turn: its workspace, when the login the turn
 *    answers moderates it; else, for a login outside Admin, the folder it
 *    makes the item in when it may edit that, else its private workspace.
 *  - The Admin assistant's turn (an Admin user): the folder's home, else
 *    Admin, as before.
 *
 * Only in an assistant turn scope that names its login, and only when
 * nothing has named a home already (an HTTP request's, an MCP call's). Once
 * per turn scope: the private workspace is made at most once.
 */
import {
  currentCreateHome,
  resolveCreateHome,
  scopeHoldsAdmin,
  type CreateHome,
  type WorkspaceScope,
} from '@mantle/db';
import { currentWorkspaceScope } from '@mantle/db/viewer';

const homes = new WeakMap<WorkspaceScope, Promise<CreateHome | null>>();

/** The create home of the open assistant turn, or null (not a turn that
 *  names a login, or a home is already named). */
export async function turnCreateHome(): Promise<CreateHome | null> {
  const scope = currentWorkspaceScope();
  if (!scope || scope.kind !== 'assistant' || !scope.loginId) return null;
  if (currentCreateHome()) return null;
  let home = homes.get(scope);
  if (!home) {
    home = resolveTurnHome(scope);
    homes.set(scope, home);
  }
  return home;
}

async function resolveTurnHome(scope: WorkspaceScope): Promise<CreateHome | null> {
  const wsId = scope.ws.length === 1 ? scope.ws[0]! : null;
  // The Admin assistant names no workspace: an Admin user's create goes to
  // its folder's home, else Admin (the rule's step 3 for an Admin user).
  const askedWs = wsId && !(await scopeHoldsAdmin()) ? wsId : null;
  const home = await resolveCreateHome(scope.loginId!, {
    askedWs,
    ownWork: 'auto',
    makePrivate: true,
  });
  // A refusal cannot happen here (the turn's login is a user of its
  // workspace, so it has one to make a private one in). Were it to, no home
  // is named and the database's own create checks decide.
  return 'refused' in home ? null : home;
}
