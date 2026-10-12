/**
 * Where an assistant turn's creates land (workspaces arch A0; F12): the
 * home rule of docs/workspaces.md ("Where a new item lands"), through the
 * function the web routes use (@mantle/db resolveCreateHome), so a create
 * made from a tool in a turn lands where the same login's create from the
 * web would.
 *
 *  - Every assistant's turn, the Admin assistant's too: the assistant's
 *    workspace is the current one. When the login the turn answers
 *    moderates it, the item lands there (a folder it is made in only
 *    passes its grants). Else the guide's fallback: the folder's home when
 *    the login may edit that folder, else its private workspace; for an
 *    Admin user, the folder's home, else Admin.
 *
 * Only in an assistant turn scope that names its login, and only when
 * nothing has named a home already (an HTTP request's, an MCP call's). Once
 * per turn scope: the private workspace is made at most once.
 */
import {
  currentCreateHome,
  resolveCreateHome,
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
  // The turn's current workspace: the assistant's own (one rule for every
  // assistant, CEO answer 2026-10-12).
  const askedWs = scope.ws.length === 1 ? scope.ws[0]! : null;
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
