import { NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import { getJourney } from '@/lib/journey';

/** GET /api/debug/journey/[traceId] — the reaction story for one action: the
 *  trace step timeline + the brain layers it produced. 404 if not owned. */
export async function GET(_req: Request, { params }: { params: Promise<{ traceId: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { traceId } = await params;
  const journey = await getJourney(user.id, traceId);
  if (!journey) return NextResponse.json({ error: 'Journey not found.' }, { status: 404 });
  return NextResponse.json({ journey });
}
