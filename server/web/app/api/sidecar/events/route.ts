/**
 * The Sync sidecar's calendar feeds (Sync service plan M2;
 * docs/calendar-ingest.md):
 *
 *   GET  /api/sidecar/events?feedId=  the uids stored for a feed
 *   POST /api/sidecar/events          a page of a feed (`partial`): each
 *        event upserted as an ordinary event node (packages/content
 *        upsertExternalEvent: dedup by feed and UID, no reminder of its
 *        own), and only the uids in `remove` removed. The sidecar names
 *        those after a run that read the whole feed (GET's set less the
 *        run's), so an event a cut or stopped run did not post is never
 *        removed. Without `partial` the body is the complete set, and an
 *        event stored before and missing now is removed (an empty set: the
 *        feed was removed).
 */
import { NextResponse } from '@/server/http-compat';
import { UUID_RE } from '@mantle/std';
import { deleteExternalEvents, listExternalEventUids, upsertExternalEvent } from '@mantle/content';
import { readBody } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';
import { FeedEventsBody } from '@/lib/sidecar-schemas';
import { asSidecar, sidecarOwner, sidecarRequestRefusal } from '@/lib/sidecar';

export const policy = routePolicy({
  // No rate limit, as the gateway's routes (gateway/registry/route.ts says
  // why): the token is checked first and a refusal does no work.
  GET: { class: 'public' },
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

export async function GET(req: Request) {
  const refused = sidecarRequestRefusal(req);
  if (refused) return refused;
  const feedId = new URL(req.url).searchParams.get('feedId') ?? '';
  if (!UUID_RE.test(feedId)) return NextResponse.json({ error: 'bad query' }, { status: 400 });
  return asSidecar(async () =>
    NextResponse.json({ uids: await listExternalEventUids(await sidecarOwner(), feedId) }),
  );
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
    if (body.partial) {
      // A page: nothing leaves but what the sidecar named.
      const removed = body.remove?.length
        ? await deleteExternalEvents(owner, body.feedId, body.remove)
        : 0;
      return NextResponse.json({ upserted, failed, removed });
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
