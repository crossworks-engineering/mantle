import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { getJourney } from '@/lib/journey';
import { toolMakerFor } from '@/lib/tools';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'settings' },
});

/** GET /api/debug/journey/[traceId] — the reaction story for one action: the
 *  trace step timeline + the brain layers it produced. 404 if not owned. */
export async function GET(_req: Request, { params }: { params: Promise<{ traceId: string }> }) {
  const user = ownerCaller();
  const { traceId } = await params;
  const journey = await getJourney(user.id, traceId, toolMakerFor(user));
  if (!journey) return NextResponse.json({ error: 'Journey not found.' }, { status: 404 });
  return NextResponse.json({ journey });
}
