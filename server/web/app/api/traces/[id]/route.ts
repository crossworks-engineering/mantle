import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { getTrace } from '@/lib/traces';
import { traceReaderFor } from '@/lib/trace-reader';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'settings' },
});

/** GET /api/traces/[id] — one owner-scoped trace with its full step timeline,
 *  or 404. Drives both the /traces detail pane and the /traces/[id] deep link.
 *  A login reads the traces of its own turns, and the system's when it
 *  holds the settings area (traceReaderFor); never another login's. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await params;
  const trace = await getTrace(user.id, id, await traceReaderFor(user));
  if (!trace) return NextResponse.json({ error: 'Trace not found.' }, { status: 404 });
  return NextResponse.json({ trace });
}
