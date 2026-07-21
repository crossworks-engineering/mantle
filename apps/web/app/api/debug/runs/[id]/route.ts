import { NextResponse } from 'next/server';
import { db } from '@mantle/db';
import { cancelRun, compileRunState } from '@mantle/runs';
import { getOwnerOr401 } from '@/lib/auth';

/** GET /api/debug/runs/:id — one run's compiled tree (the run view payload). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await params;
  const compiled = await compileRunState(db, id);
  if (!compiled || compiled.run.ownerId !== user.id) {
    return NextResponse.json({ error: 'run not found' }, { status: 404 });
  }
  return NextResponse.json(compiled);
}

/** POST /api/debug/runs/:id — actions on a run. Body `{action:'cancel'}`:
 *  the operator Stop actuator (the same `cancelRun` the run_cancel tool
 *  uses — CAS from running|paused; in-flight work no-ops at the engine's
 *  CAS; the sweep janitor expires any orphaned pending questions). Stays
 *  live with MANTLE_RUNS off, matching run_cancel's always-on posture. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { action?: string };
  if (body.action !== 'cancel') {
    return NextResponse.json({ error: "expected { action: 'cancel' }" }, { status: 400 });
  }
  const compiled = await compileRunState(db, id);
  if (!compiled || compiled.run.ownerId !== user.id) {
    return NextResponse.json({ error: 'run not found' }, { status: 404 });
  }
  const { cancelled } = await cancelRun(db, id);
  return NextResponse.json({
    cancelled,
    ...(cancelled ? {} : { note: 'run already terminal — nothing to cancel' }),
  });
}
