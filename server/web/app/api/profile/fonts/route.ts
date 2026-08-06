import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { savePreferencesFor } from '@mantle/content';

/**
 * PUT /api/profile/fonts { fontLogo?, fontTitle?, fontUi?, fontSize? } — persist
 * the typography choices (Settings → Appearance): the two display faces, the
 * INTERFACE font, and the UI scale. A tiny fire-and-forget
 * endpoint like /api/profile/color-theme: the picker calls it on every change.
 * The faces are BRAIN-level (BRAIN_PREFERENCE_KEYS) — savePreferencesFor lands
 * them on the shared anchor row, so any admin sets the one brand and every
 * user and member surface sees it. Both keys are optional so either
 * picker can save alone. Shape-only validation here; the font LIST lives in the
 * web app (lib/display-fonts.ts) and the client resolves unknown keys to the
 * default (garbage stores harmlessly, projects to unset on read — projectFontKey).
 */
const Body = z.object({
  fontLogo: z.string().max(64).optional(),
  fontTitle: z.string().max(64).optional(),
  fontUi: z.string().max(64).optional(),
  fontSize: z.string().max(16).optional(),
});

export async function PUT(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'fontLogo/fontTitle/fontUi/fontSize (strings) expected' },
      { status: 400 },
    );
  }
  const prefs = await savePreferencesFor(user.id, {
    ...(parsed.data.fontLogo !== undefined ? { fontLogo: parsed.data.fontLogo } : {}),
    ...(parsed.data.fontTitle !== undefined ? { fontTitle: parsed.data.fontTitle } : {}),
    ...(parsed.data.fontUi !== undefined ? { fontUi: parsed.data.fontUi } : {}),
    ...(parsed.data.fontSize !== undefined ? { fontSize: parsed.data.fontSize } : {}),
  });
  return NextResponse.json({
    fontLogo: prefs.fontLogo ?? null,
    fontTitle: prefs.fontTitle ?? null,
    fontUi: prefs.fontUi ?? null,
    fontSize: prefs.fontSize ?? null,
  });
}
