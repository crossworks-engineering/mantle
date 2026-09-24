import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { AppNavInvalidError, loadAppNavView, saveAppNav } from '@mantle/content';

/**
 * /api/app-nav — the sidebar's app tree.
 *
 * GET returns everything the tree renders in one round-trip (AppNavResponse):
 * the shared layout, this login's pins and open counts, and every app, slim.
 *
 * PUT { baseRev, entries } replaces the shared layout (brain-level: every admin
 * edits the same tree). Compare-and-set on `baseRev`: when another client saved
 * first the answer is 409 with the current layout as `nav`, so the caller can
 * reapply its change on top rather than overwrite someone else's.
 */
export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  return NextResponse.json(await loadAppNavView(user.id, user.actor.id));
}

const Body = z.object({
  baseRev: z.number().int().min(0),
  // Shape is checked by appNavIssue (depth, ids, names), which names the
  // problem; zod only guards the envelope.
  entries: z.array(z.unknown()).max(5000),
});

export async function PUT(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'baseRev (integer) and entries (array) required' },
      { status: 400 },
    );
  }
  try {
    const result = await saveAppNav(user.id, parsed.data.baseRev, parsed.data.entries);
    if (!result.ok) {
      return NextResponse.json(
        { error: 'the layout changed on another device', nav: result.current },
        { status: 409 },
      );
    }
    return NextResponse.json({ nav: result.nav });
  } catch (err) {
    if (err instanceof AppNavInvalidError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
