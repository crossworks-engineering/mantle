/**
 * Apps for clients (client logins C6): the one lookup every client app route
 * makes. A client runs an app at CLIENT level with a green PUBLISHED build;
 * everything else (a team, admin or public app, a draft-only app, another
 * brain's app, no such id) is the same plain 404, so no answer tells a team
 * app from a missing one.
 *
 * Two locks: the rule is written in the query (@mantle/content client-apps),
 * and the query runs on the client role, so row security holds as well.
 */
import { NextResponse } from '@/server/http-compat';
import { withViewer } from '@mantle/db';
import { getClientRunnableApp, type ClientRunnableApp } from '@mantle/content';
import { isUuid } from '@mantle/std';
import type { ClientCaller } from '@/lib/auth';

/** The app, or a 404 response. */
export async function clientAppOr404(
  anchorId: string,
  id: string,
): Promise<ClientRunnableApp | NextResponse> {
  const notFound = NextResponse.json({ ok: false, error: 'app not found' }, { status: 404 });
  if (!isUuid(id)) return notFound;
  const app = await withViewer('client', () => getClientRunnableApp(anchorId, id.toLowerCase()));
  return app ?? notFound;
}

/** Who a client is on the client surface. */
export function clientName(client: ClientCaller): string {
  return client.displayName?.trim() || client.email.split('@')[0] || 'client';
}

/** The 403 a write to an informational app answers (client and member). */
export function readOnlyAppResponse(message: string): NextResponse {
  return NextResponse.json({ ok: false, error: message, reason: 'read-only' }, { status: 403 });
}
