import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { brandSettingsRefusal } from '@/lib/brand-gate';
import { savePreferencesFor } from '@mantle/content';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  PUT: { class: 'self', item: { none: "the login's own things, not an item" } },
});

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
 * (@mantle/client-types/display-fonts) and the client resolves unknown keys to the
 * default, so garbage stores harmlessly and projects to unset on read
 * (projectFontKey). Sizes are a closed set and ARE validated by value on read
 * (projectFontSize), because an unknown size has no registry to fall through.
 */
/** The zod shape is DERIVED from this list, so the accepted body, the persisted
 *  patch and the response projection can never disagree about which fields
 *  exist — a field present in one list but not another would be accepted,
 *  silently dropped, and returned as null, which reads as a successful save
 *  that never happened. */
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

const Body = z.object(
  Object.fromEntries(FIELDS.map((f) => [f, z.string().max(64).optional()])) as Record<
    (typeof FIELDS)[number],
    z.ZodOptional<z.ZodString>
  >,
);

export async function PUT(req: Request) {
  const user = ownerCaller();
  const refused = await brandSettingsRefusal(user);
  if (refused) return refused;
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) {
    return NextResponse.json({ error: `${FIELDS.join('/')} (strings) expected` }, { status: 400 });
  }
  // zod already strips unknown keys and omits absent optionals, so the parsed
  // body IS the patch: only fields the caller actually sent are written, and an
  // absent key stays absent rather than being cleared by a partial save.
  const prefs = await savePreferencesFor(user.id, parsed.data);
  return NextResponse.json(
    Object.fromEntries(FIELDS.map((field) => [field, prefs[field] ?? null])),
  );
}
