import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { listRecallMaps } from '@/lib/recall';

/** The Recall catalog: every map + its compile state, failed compiles included. */
export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const maps = await listRecallMaps(user.id);
  return NextResponse.json({ maps });
}
