import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { brandSettingsRefusal } from '@/lib/brand-gate';
import { savePreferencesFor } from '@mantle/content';
import { readJson } from '@/lib/read-body';

/**
 * PUT /api/profile/color-theme { colorTheme } — persist the UI colour theme.
 * A deliberately tiny endpoint (the full /api/profile PUT is a form save that
 * requires timezone/locale): the theme toggler and the random shuffle call
 * this fire-and-forget on every change. The theme is BRAIN-level (see
 * BRAIN_PREFERENCE_KEYS): savePreferencesFor lands it on the shared anchor
 * row, so any signed-in admin sets the one brand and it follows every user
 * across
 * browsers and brands the member surfaces. Validation happens in the shared
 * projection (projectColorTheme) — garbage stores as unset, never an error.
 */
const Body = z.object({ colorTheme: z.string().max(64) });

export async function PUT(req: Request) {
  const user = ownerCaller();
  const refused = await brandSettingsRefusal(user);
  if (refused) return refused;
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) {
    return NextResponse.json({ error: 'colorTheme (string) required' }, { status: 400 });
  }
  const preferences = await savePreferencesFor(user.id, {
    colorTheme: parsed.data.colorTheme,
  });
  return NextResponse.json({ colorTheme: preferences.colorTheme ?? null });
}
