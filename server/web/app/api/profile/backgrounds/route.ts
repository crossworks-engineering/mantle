import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { savePreferencesFor } from '@mantle/content';

/**
 * PUT /api/profile/backgrounds { backgrounds } — persist which generated
 * background each area of the shell shows, as `menu=waves,header=off`.
 *
 * Tiny by design, exactly like /api/profile/avatar: the Appearance picker calls
 * it fire-and-forget on every change.
 *
 * BRAIN-level (see BRAIN_PREFERENCE_KEYS), so savePreferencesFor lands it on
 * the shared anchor row — it describes the look of the product, not one login's
 * taste.
 *
 * An EMPTY string is a legitimate value, not a missing one: it means every area
 * is back on its default, and it is how the picker clears the setting. So the
 * field is required and `''` is accepted, unlike the avatar route where each
 * field is optional and absence means "leave alone". Validation of the pairs
 * themselves happens in the shared projection (projectBackgrounds) and again on
 * read (decodeBackgrounds) — garbage stores as unset, never an error.
 */
const Body = z.object({
  backgrounds: z.string().max(200),
});

export async function PUT(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'backgrounds required' }, { status: 400 });
  }
  const preferences = await savePreferencesFor(user.id, {
    backgrounds: parsed.data.backgrounds.trim(),
  });
  return NextResponse.json({ backgrounds: preferences.backgrounds ?? null });
}
