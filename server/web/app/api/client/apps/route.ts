import { NextResponse } from '@/server/http-compat';
import { withViewer } from '@mantle/db';
import { listClientApps } from '@mantle/content';
import type { ClientAppList } from '@mantle/client-types';
import { getClientOr401 } from '@/lib/auth';

/**
 * GET /api/client/apps: the apps a CLIENT may run (client logins C6), by
 * title: apps at client level with a green published build, never a team,
 * admin or public one. Read at the client level. No level and no author on a
 * card. Clients only run apps: nothing here creates, edits or shares one.
 */
export async function GET() {
  const client = await getClientOr401();
  if (client instanceof Response) return client;
  const apps = await withViewer('client', () => listClientApps(client.anchorId));
  return NextResponse.json({ apps } satisfies ClientAppList);
}
