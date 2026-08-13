import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { savePreferencesFor } from '@mantle/content';

/**
 * PUT /api/profile/fonts — persist the typography choices (Settings →
 * Appearance): the four faces (interface, wordmark, peer name, Pages/Notes) and
 * their four sizes. A tiny fire-and-forget endpoint like
 * /api/profile/color-theme: the modal calls it on every change.
 *
 * These are BRAIN-level (BRAIN_PREFERENCE_KEYS) — savePreferencesFor lands them
 * on the shared anchor row, so any admin sets the one brand and every user and
 * member surface sees it. Every field is optional so one control can save alone
 * without reading the others' state (two controls changing before a re-render
 * must not revert each other).
 *
 * Shape-only validation here; the font LIST lives in the web layer
 * (@mantle/web-ui/display-fonts) and the client resolves unknown keys to the
 * default, so garbage stores harmlessly and projects to unset on read
 * (projectFontKey). Sizes are a closed set and ARE validated by value on read
 * (projectFontSize), because an unknown size has no registry to fall through.
 */
const FIELDS = [
  'fontLogo',
  'fontTitle',
  'fontUi',
  'fontProse',
  'fontSize',
  'fontLogoSize',
  'fontTitleSize',
  'fontProseSize',
] as const;

const Body = z.object({
  fontLogo: z.string().max(64).optional(),
  fontTitle: z.string().max(64).optional(),
  fontUi: z.string().max(64).optional(),
  fontProse: z.string().max(64).optional(),
  fontSize: z.string().max(16).optional(),
  fontLogoSize: z.string().max(16).optional(),
  fontTitleSize: z.string().max(16).optional(),
  fontProseSize: z.string().max(16).optional(),
});

export async function PUT(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: `${FIELDS.join('/')} (strings) expected` }, { status: 400 });
  }
  // Only fields the caller actually sent are written: an absent key must stay
  // absent rather than being cleared by a partial save.
  const patch: Record<string, string> = {};
  for (const field of FIELDS) {
    const value = parsed.data[field];
    if (value !== undefined) patch[field] = value;
  }
  const prefs = await savePreferencesFor(user.id, patch);
  return NextResponse.json(
    Object.fromEntries(FIELDS.map((field) => [field, prefs[field] ?? null])),
  );
}
