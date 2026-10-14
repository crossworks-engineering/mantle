import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { getTrace } from '@/lib/traces';
import { toolMakerFor } from '@/lib/tools';

/** GET /api/traces/[id] — one owner-scoped trace with its full step timeline,
 *  or 404. Drives both the /traces detail pane and the /traces/[id] deep link.
 *  A login reads only the traces of its own turns; the brain owner its own
 *  and the system's (W7 integration fix 2). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await params;
  const trace = await getTrace(user.id, id, toolMakerFor(user));
  if (!trace) return NextResponse.json({ error: 'Trace not found.' }, { status: 404 });
  return NextResponse.json({ trace });
}
