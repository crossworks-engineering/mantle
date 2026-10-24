import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { listActivity } from '@/lib/journey';
import { toolMakerFor } from '@/lib/tools';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'settings' },
});

/** GET /api/debug/journey?cat=&done= — the activity feed (Activity → Reaction).
 *  `cat` filters by pipeline category; `done=1` hides no-op skips. */
export async function GET(req: Request) {
  const user = ownerCaller();
  const url = new URL(req.url);
  const category = (['content', 'dialog', 'automation'] as const).find(
    (c) => c === url.searchParams.get('cat'),
  );
  const processedOnly = url.searchParams.get('done') === '1';
  // Only the traces the signed-in login may read (W7 integration fix 3, L2).
  const items = await listActivity(user.id, toolMakerFor(user), {
    category,
    processedOnly,
    limit: 100,
  });
  return NextResponse.json({ items });
}
