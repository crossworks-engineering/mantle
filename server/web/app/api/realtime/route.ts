import { getOwnerOr401 } from '@/lib/auth';
import { subscribeRealtime, type RealtimeChange } from '@/lib/realtime';
import { sseResponse } from '@/lib/sse';

/**
 * Server-Sent Events stream of live node changes for the current owner. Backed
 * by the Postgres `node_ingested` LISTEN bridge (lib/realtime). Clients open it
 * with EventSource via the useRealtime() hook and refresh on a matching change.
 *
 * `?types=event,note` filters to those node types; omit for all. Owner
 * isolation is enforced here — a change for another owner is never emitted.
 */

export async function GET(req: Request): Promise<Response> {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const typesParam = new URL(req.url).searchParams.get('types');
  const types = typesParam
    ? new Set(
        typesParam
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      )
    : null;

  return sseResponse(req, {
    subscribe: (send) =>
      subscribeRealtime((change: RealtimeChange) => {
        if (change.ownerId !== user.id) return;
        if (types && !types.has(change.type)) return;
        send({ type: change.type, id: change.id });
      }),
  });
}
