import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { NEAT_BACKGROUND_MAX, savePreferencesFor } from '@mantle/content';

/**
 * PUT /api/profile/neat-background { neatBackground }, persist the generated
 * whole-surface gradient's spec — compact JSON `{v:1, seed, tone, speed}`.
 *
 * Tiny by design, exactly like /api/profile/backgrounds, and the same
 * contracts throughout: BRAIN-level (the look of the product, so it lands on
 * the shared anchor row via savePreferencesFor); an EMPTY string is the
 * deliberate clear, not a missing value; validation of the spec itself
 * happens in the shared projection (projectNeatBackground) and again in the
 * client's decode, so garbage stores as unset, never as an error.
 *
 * Colours are deliberately NOT stored — the client derives them from the
 * live theme tokens, which is what keeps one saved background correct across
 * every colour theme and both modes.
 */
const Body = z.object({
  neatBackground: z.string().max(NEAT_BACKGROUND_MAX),
});

export async function PUT(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'neatBackground required' }, { status: 400 });
  }
  const preferences = await savePreferencesFor(user.id, {
    neatBackground: parsed.data.neatBackground.trim(),
  });
  return NextResponse.json({ neatBackground: preferences.neatBackground ?? null });
}
