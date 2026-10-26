import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { anyLoginCaller } from '@/lib/auth';
import { projectHomeDesk, savePreferencesFor } from '@mantle/content';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  PUT: {
    class: 'self',
    scope: null,
    open: 'any',
    item: { none: "the login's own things, not an item" },
  },
});

/**
 * PUT /api/profile/home-desk { homeDesk }: replace this LOGIN's Home desk
 * (where each widget and desk icon sits, and the desk's settings). Personal:
 * saved on the actor's own profile row, so the desk follows the person
 * across browsers and devices, as nav favourites do. Validation is the
 * shared projection (shape and size only; the client owns what a widget
 * is), and a desk that does not project is a 400 rather than a silent clear.
 *
 * Open to every login (`open: 'any'`, anyLoginCaller), a member as an Admin
 * user: the desk is the login's own, and a member is trusted with its own
 * things. The write runs in the login's scope, where the profile write rule
 * (mantle_profile_writable, 0302) holds it to the login's own row; the one
 * key it names (`homeDesk`) is personal, so nothing reaches the brain's row.
 * An API key never gets here (keys reach /api/v1 only: access-key-gate), nor
 * a peer or a share link (no login).
 */
const Body = z.object({ homeDesk: z.unknown() });

export async function PUT(req: Request) {
  const login = anyLoginCaller();
  const parsed = Body.safeParse(await readJson(req));
  const homeDesk = parsed.success ? projectHomeDesk(parsed.data.homeDesk) : undefined;
  if (!homeDesk) {
    return NextResponse.json({ error: 'homeDesk (a v1 desk) required' }, { status: 400 });
  }
  const preferences = await savePreferencesFor(login.loginId, { homeDesk });
  return NextResponse.json({ homeDesk: preferences.homeDesk ?? null });
}
