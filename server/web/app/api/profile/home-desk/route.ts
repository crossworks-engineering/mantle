import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { projectHomeDesk, savePreferencesFor } from '@mantle/content';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  PUT: { class: 'self', item: { none: "the login's own things, not an item" } },
});

/**
 * PUT /api/profile/home-desk { homeDesk } — replace this LOGIN's Home desk
 * (where each widget and desk icon sits, and the desk's settings). Personal:
 * saved on the actor's row, so the desk follows the person across browsers
 * and devices, as nav favourites do. Validation is the shared projection
 * (shape and size only; the client owns what a widget is), and a desk that
 * does not project is a 400 rather than a silent clear.
 */
const Body = z.object({ homeDesk: z.unknown() });

export async function PUT(req: Request) {
  const user = ownerCaller();
  const parsed = Body.safeParse(await readJson(req));
  const homeDesk = parsed.success ? projectHomeDesk(parsed.data.homeDesk) : undefined;
  if (!homeDesk) {
    return NextResponse.json({ error: 'homeDesk (a v1 desk) required' }, { status: 400 });
  }
  const preferences = await savePreferencesFor(user.actor.id, { homeDesk });
  return NextResponse.json({ homeDesk: preferences.homeDesk ?? null });
}
