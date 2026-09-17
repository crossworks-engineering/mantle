import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { savePreferencesFor } from '@mantle/content';

/**
 * PUT /api/profile/share-neat { shareNeat }, persist whether shared surfaces
 * (the public /s reader, the team workspace) paint the saved Neat gradient at
 * all. OFF is the printable fallback: the plain themed surface, nothing
 * animated behind the content. Default ON — only an explicit false disables,
 * so brains that never touch the switch keep the background everywhere it
 * normally paints.
 *
 * Tiny by design, the /api/profile/neat-background contract: BRAIN-level (it
 * is the look of the product's shared face, so it lands on the shared anchor
 * row via savePreferencesFor).
 */
const Body = z.object({
  shareNeat: z.boolean(),
});

export async function PUT(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'shareNeat required' }, { status: 400 });
  }
  const preferences = await savePreferencesFor(user.id, {
    shareNeat: parsed.data.shareNeat,
  });
  return NextResponse.json({ shareNeat: preferences.shareNeat !== false });
}
