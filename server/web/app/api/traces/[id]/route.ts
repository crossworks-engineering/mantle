import { NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import { getTrace } from '@/lib/traces';

/** GET /api/traces/[id] — one owner-scoped trace with its full step timeline,
 *  or 404. Drives both the /traces detail pane and the /traces/[id] deep link. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await params;
  const trace = await getTrace(user.id, id);
  if (!trace) return NextResponse.json({ error: 'Trace not found.' }, { status: 404 });
  return NextResponse.json({ trace });
}
