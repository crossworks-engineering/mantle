import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { brandSettingsRefusal } from '@/lib/brand-gate';
import { NEAT_BACKGROUND_MAX, savePreferencesFor } from '@mantle/content';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  PUT: { class: 'self', item: { none: "the login's own things, not an item" } },
});

/**
 * PUT /api/profile/neat-background { neatBackground }, persist the generated
 * whole-surface background's spec (Drift): compact JSON, v2 from the current
 * generator, or a Neat-era v1. The route keeps its first name.
 *
 * Tiny by design, exactly like /api/profile/backgrounds, and the same
 * contracts throughout: BRAIN-level (the look of the product, so it lands on
 * the shared anchor row via savePreferencesFor); an EMPTY string is the
 * deliberate clear, not a missing value; validation of the spec itself
 * happens in the shared projection (projectNeatBackground, through the one
 * Drift codec) and again in the client's decode, so garbage stores as unset, never as an error.
 *
 * Colours are deliberately NOT stored — the client derives them from the
 * live theme tokens, which is what keeps one saved background correct across
 * every colour theme and both modes.
 */
const Body = z.object({
  neatBackground: z.string().max(NEAT_BACKGROUND_MAX),
});

export async function PUT(req: Request) {
  const user = ownerCaller();
  const refused = await brandSettingsRefusal(user);
  if (refused) return refused;
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) {
    return NextResponse.json({ error: 'neatBackground required' }, { status: 400 });
  }
  const preferences = await savePreferencesFor(user.id, {
    neatBackground: parsed.data.neatBackground.trim(),
  });
  return NextResponse.json({ neatBackground: preferences.neatBackground ?? null });
}
