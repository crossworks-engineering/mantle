import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { NAV_FAVORITES_MAX } from '@mantle/client-types/app-nav';
import { getOwnerOr401 } from '@/lib/auth';
import { savePreferencesFor } from '@mantle/content';

/**
 * PUT /api/profile/nav-favorites { navFavorites } — replace this LOGIN's
 * sidebar favourites (nav hrefs, in order). Personal: saved on the actor's
 * row, so they follow the person across browsers and devices. Validation is
 * the shared projection (in-app hrefs only, deduped, capped); [] clears.
 */
const Body = z.object({ navFavorites: z.array(z.string().max(400)).max(NAV_FAVORITES_MAX * 2) });

export async function PUT(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'navFavorites (array of hrefs) required' }, { status: 400 });
  }
  const preferences = await savePreferencesFor(user.actor.id, {
    navFavorites: parsed.data.navFavorites,
  });
  return NextResponse.json({ navFavorites: preferences.navFavorites ?? [] });
}
