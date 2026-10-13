/**
 * Where an assistant turn's creates land (workspaces arch A0; F12): the
 * home rule of docs/workspaces.md ("Where a new item lands"), through THE
 * create-home intent the web routes and MCP use (@mantle/db
 * createHomeIntent, arch A3c), so a create made from a tool in a turn lands
 * where the same login's create from the web would.
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
  createHomeIntent,
  currentCreateHome,
  type CreateHome,
  type WorkspaceScope,
} from '@mantle/db';
import { currentWorkspaceScope } from '@mantle/db/viewer';

/** A turn's resolved home. `final`: no later call of the turn changes it
 *  (a create made the private workspace, or the home needs none). Only a
 *  home that resolved is kept: a database error is not cached, so one
 *  failure does not fail every later tool of the turn. */
type Kept = { home: CreateHome; final: boolean };
const homes = new WeakMap<WorkspaceScope, Kept>();

/**
 * The create home of the open assistant turn, or null (not a turn that
 * names a login, a home is already named, or it could not be resolved: the
 * database's own create checks then decide). `creates`: the call may make
 * an item (the tool is not readOnly), the only kind that may make the
 * login's private workspace; a readOnly call uses the one it has, if any.
 *
 * Under the rollback switch (MANTLE_ADMIN_READS=system) an Admin turn runs
 * in a gate scope, not a workspace scope, so this answers null and its
 * creates follow the database's default. Accepted: the switch is temporary
 * and goes in A7.
 */
export async function turnCreateHome(creates: boolean): Promise<CreateHome | null> {
  const scope = currentWorkspaceScope();
  if (!scope || scope.kind !== 'assistant' || !scope.loginId) return null;
  if (currentCreateHome()) return null;
  const kept = homes.get(scope);
  if (kept && (kept.final || !creates)) return kept.home;
  // The turn's current workspace: the assistant's own (one rule for every
  // assistant, CEO answer 2026-10-12).
  const askedWs = scope.ws.length === 1 ? scope.ws[0]! : null;
  let home: Awaited<ReturnType<typeof createHomeIntent>>;
  try {
    home = await createHomeIntent(
      scope.loginId,
      { from: 'assistant', ws: askedWs },
      { ownWork: 'auto', makePrivate: creates },
    );
  } catch {
    return null;
  }
  // A refusal cannot happen here (the turn's login is a user of its
  // workspace, so it has one to make a private one in). Were it to, no home
  // is named and the database's own create checks decide.
  if ('refused' in home) return null;
  homes.set(scope, {
    home,
    final: creates || home.createWs !== null || home.privateWs !== null,
  });
  return home;
}
