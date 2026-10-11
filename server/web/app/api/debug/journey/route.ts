import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { listActivity } from '@/lib/journey';
import { toolMakerFor } from '@/lib/tools';

/** GET /api/debug/journey?cat=&done= — the activity feed (Activity → Reaction).
 *  `cat` filters by pipeline category; `done=1` hides no-op skips. */
export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
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
