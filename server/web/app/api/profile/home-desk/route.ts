import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { anyLoginCaller } from '@/lib/auth';
import { savePreferencesFor, validateHomeDeskWrite } from '@mantle/content';
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
 * PUT /api/profile/home-desk { homeDesk }: replace this LOGIN's Desk (where
 * each widget and desk icon sits, and the desk's settings). Personal: saved
 * on the actor's own profile row, so the Desk follows the login across
 * browsers and devices, as nav favourites do. Validation is the write side
 * of the shared projection (`validateHomeDeskWrite`: shape and size only,
 * the client owns what a widget is), strict: a desk the projection would
 * change (an item dropped, the list cut, an id that is not printable ASCII)
 * is a 400, never a silent clear or a partial save. The body is read up to
 * 64 KB, twice the stored cap (a larger one is a 413).
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
const BODY_MAX_BYTES = 64 * 1024;

export async function PUT(req: Request) {
  const login = anyLoginCaller();
  const parsed = Body.safeParse(await readJson(req, { maxBytes: BODY_MAX_BYTES }));
  const homeDesk = parsed.success ? validateHomeDeskWrite(parsed.data.homeDesk) : undefined;
  if (!homeDesk) {
    return NextResponse.json({ error: 'homeDesk (a v1 desk) required' }, { status: 400 });
  }
  const preferences = await savePreferencesFor(login.loginId, { homeDesk });
  return NextResponse.json({ homeDesk: preferences.homeDesk ?? null });
}
