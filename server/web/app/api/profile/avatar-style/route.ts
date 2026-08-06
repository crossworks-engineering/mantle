import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { savePreferencesFor } from '@mantle/content';

/**
 * PUT /api/profile/avatar-style { avatarStyle } — persist the brain's avatar
 * style. Tiny by design, exactly like /api/profile/color-theme: the Appearance
 * picker calls it fire-and-forget on every change, while the full /api/profile
 * PUT is a form save that requires timezone/locale.
 *
 * The style is BRAIN-level (see BRAIN_PREFERENCE_KEYS), so savePreferencesFor
 * lands it on the shared anchor row: it is the visual language EVERY generated
 * avatar is drawn in, owner and agents alike, not one login's taste. The seed
 * stays personal. Validation happens in the shared projection
 * (projectAvatarStyle) — garbage stores as unset, never an error.
 */
const Body = z.object({ avatarStyle: z.string().max(64) });

export async function PUT(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'avatarStyle (string) required' }, { status: 400 });
  }
  const preferences = await savePreferencesFor(user.id, {
    avatarStyle: parsed.data.avatarStyle,
  });
  return NextResponse.json({ avatarStyle: preferences.avatarStyle ?? null });
}
