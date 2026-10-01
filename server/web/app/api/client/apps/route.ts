import { NextResponse } from '@/server/http-compat';
import { appLauncher } from '@mantle/content';
import type { ClientAppList } from '@mantle/client-types';
import { getClientOr401 } from '@/lib/auth';

/**
 * GET /api/client/apps: the apps a CLIENT may run (client logins C6), by
 * title: apps at client level with a green published build, never a team,
 * admin or public one. Read at the client level. No level and no author on a
 * card. Clients only run apps: nothing here creates, edits or shares one.
 *
 * `folders`: where those apps sit in the admin's Apps folders, read only,
 * with no level and no share. A folder is answered only when it leads to an
 * app of this list, so a folder with nothing the client may run (team apps,
 * drafts, nothing at all) is never named. `appLauncher` reads the apps on
 * the client role and the folder rows (the brain's) on the admin pool, along
 * those apps' paths and nowhere else; when that folder read fails the apps
 * still list, with no folders.
 */
export async function GET() {
  const client = await getClientOr401();
  if (client instanceof Response) return client;
  const { apps, folders } = await appLauncher(client.anchorId, 'client');
  return NextResponse.json({ apps, folders } satisfies ClientAppList);
}
