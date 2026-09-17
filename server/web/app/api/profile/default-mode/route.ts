import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { projectDefaultMode, savePreferencesFor } from '@mantle/content';

/**
 * PUT /api/profile/default-mode { defaultMode }, persist the brain's default
 * light/dark mode for surfaces where the visitor has not chosen one — today
 * the public /s share reader, which stamps it server-side; a visitor's own
 * toggle overrides it locally and only locally.
 *
 * Tiny by design, exactly like /api/profile/neat-background, and the same
 * contracts: BRAIN-level (the look of the product's public face, so it lands
 * on the shared anchor row via savePreferencesFor); an EMPTY string is the
 * deliberate clear (⇒ 'light', the share surface's historical rendering);
 * the value set is closed and validated here AND in the shared projection, so
 * garbage never stores.
 */
const Body = z.object({
  defaultMode: z.enum(['light', 'dark', 'system']).or(z.literal('')),
});

export async function PUT(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'defaultMode required' }, { status: 400 });
  }
  const preferences = await savePreferencesFor(user.id, {
    defaultMode: parsed.data.defaultMode,
  });
  return NextResponse.json({ defaultMode: projectDefaultMode(preferences.defaultMode) ?? null });
}
