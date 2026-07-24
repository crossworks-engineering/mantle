import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { updateProfilePreferences } from '@mantle/content';

/**
 * PUT /api/profile/color-theme { colorTheme } — persist the UI colour theme.
 * A deliberately tiny endpoint (the full /api/profile PUT is a form save that
 * requires timezone/locale): the theme toggler and the random shuffle call
 * this fire-and-forget on every change so the choice follows the owner across
 * browsers and brands the member surfaces. Validation happens in the shared
 * projection (projectColorTheme) — garbage stores as unset, never an error.
 */
const Body = z.object({ colorTheme: z.string().max(64) });

export async function PUT(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'colorTheme (string) required' }, { status: 400 });
  }
  const preferences = await updateProfilePreferences(user.id, {
    colorTheme: parsed.data.colorTheme,
  });
  return NextResponse.json({ colorTheme: preferences.colorTheme ?? null });
}
