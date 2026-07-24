import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { updateProfilePreferences } from '@mantle/content';

/**
 * PUT /api/profile/fonts { fontLogo?, fontTitle? } — persist the wordmark +
 * page-title font choices (Settings → Appearance → Fonts). A tiny fire-and-forget
 * endpoint like /api/profile/color-theme: the picker calls it on every change so
 * the choice follows the owner across browsers. Both keys are optional so either
 * picker can save alone. Shape-only validation here; the font LIST lives in the
 * web app (lib/display-fonts.ts) and the client resolves unknown keys to the
 * default (garbage stores harmlessly, projects to unset on read — projectFontKey).
 */
const Body = z.object({
  fontLogo: z.string().max(64).optional(),
  fontTitle: z.string().max(64).optional(),
});

export async function PUT(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'fontLogo/fontTitle (strings) expected' }, { status: 400 });
  }
  const prefs = await updateProfilePreferences(user.id, {
    ...(parsed.data.fontLogo !== undefined ? { fontLogo: parsed.data.fontLogo } : {}),
    ...(parsed.data.fontTitle !== undefined ? { fontTitle: parsed.data.fontTitle } : {}),
  });
  return NextResponse.json({
    fontLogo: prefs.fontLogo ?? null,
    fontTitle: prefs.fontTitle ?? null,
  });
}
