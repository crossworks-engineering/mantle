/**
 * POST /api/sidecar/events (Sync service plan M2; docs/calendar-ingest.md):
 * one calendar feed's complete current set of events, from the Sync sidecar.
 * Each is upserted as an ordinary event node (packages/content
 * upsertExternalEvent: dedup by feed and UID, no reminder of its own), and
 * an event of the feed stored before and missing now is removed. An empty
 * set removes the feed's events (the feed was removed).
 */
import { NextResponse } from '@/server/http-compat';
import { deleteExternalEvents, listExternalEventUids, upsertExternalEvent } from '@mantle/content';
import { readBody } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';
import { FeedEventsBody } from '@/lib/sidecar-schemas';
import { asSidecar, sidecarOwner, sidecarRequestRefusal } from '@/lib/sidecar';

export const policy = routePolicy({
  // No rate limit, as the gateway's routes (gateway/registry/route.ts says
  // why): the token is checked first and a refusal does no work.
  POST: {
    class: 'public',
    item: { none: "a public route: it judges its own credential (the Sync sidecar's token)" },
  },
});

/** The feed's name as a tag, so its events can be filtered by source. */
function feedTag(name: string): string {
  const t = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return t || 'calendar';
}

export async function POST(req: Request) {
  const refused = sidecarRequestRefusal(req);
  if (refused) return refused;
  const body = await readBody(req, FeedEventsBody, { refuseEmpty: true });
  return asSidecar(async () => {
    const owner = await sidecarOwner();
    const tag = feedTag(body.name);
    const fresh = new Set<string>();
    let upserted = 0;
    let failed = 0;
    for (const ev of body.events) {
      fresh.add(ev.uid);
      try {
        await upsertExternalEvent(owner, {
          externalAccountId: body.feedId,
          externalUid: ev.uid,
          externalSource: body.source,
          title: ev.title,
          startsAt: ev.startsAt,
          endsAt: ev.endsAt,
          allDay: ev.allDay,
          location: ev.location,
          description: ev.description,
          timezone: ev.timezone,
          tags: [tag],
        });
        upserted += 1;
      } catch {
        // One event the store refuses (a start that is no date) does not
        // stop the feed: it is counted and the rest go on.
        failed += 1;
      }
    }
    const stored = await listExternalEventUids(owner, body.feedId);
    const removed = await deleteExternalEvents(
      owner,
      body.feedId,
      stored.filter((u) => !fresh.has(u)),
    );
    return NextResponse.json({ upserted, failed, removed });
  });
}
