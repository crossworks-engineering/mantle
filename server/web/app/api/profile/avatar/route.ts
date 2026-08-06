import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { savePreferencesFor } from '@mantle/content';

/**
 * PUT /api/profile/avatar { avatarStyle?, avatarTint? } — persist the brain's
 * avatar appearance. Tiny by design, exactly like /api/profile/color-theme: the
 * Appearance pickers call it fire-and-forget on every change, while the full
 * /api/profile PUT is a form save that requires timezone/locale.
 *
 * Both are BRAIN-level (see BRAIN_PREFERENCE_KEYS), so savePreferencesFor lands
 * them on the shared anchor row: they describe the visual language EVERY
 * generated avatar is drawn in, owner and agents alike, not one login's taste.
 * The avatar SEED stays personal and is saved through /api/profile.
 *
 * Each field is optional and applied only when SENT, so the style picker can't
 * clobber the tint or vice versa. Validation happens in the shared projections
 * (projectAvatarStyle / projectAvatarTint) — garbage stores as unset, never an
 * error.
 */
const Body = z.object({
  avatarStyle: z.string().max(64).optional(),
  avatarTint: z.string().max(32).optional(),
});

export async function PUT(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'avatarStyle and/or avatarTint required' }, { status: 400 });
  }
  const { avatarStyle, avatarTint } = parsed.data;
  if (avatarStyle === undefined && avatarTint === undefined) {
    return NextResponse.json({ error: 'avatarStyle and/or avatarTint required' }, { status: 400 });
  }
  const preferences = await savePreferencesFor(user.id, {
    ...(avatarStyle !== undefined ? { avatarStyle: avatarStyle.trim() } : {}),
    ...(avatarTint !== undefined ? { avatarTint: avatarTint.trim() } : {}),
  });
  return NextResponse.json({
    avatarStyle: preferences.avatarStyle ?? null,
    avatarTint: preferences.avatarTint ?? null,
  });
}
