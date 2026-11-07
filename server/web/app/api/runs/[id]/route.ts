import { NextResponse } from '@/server/http-compat';
import { db, onFullSystemRoute, runs } from '@mantle/db';
import { cancelRun, compileRunState } from '@mantle/runs';
import { ownerCaller } from '@/lib/auth';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';
import { runVisibleTo, type RunViewer } from '@/lib/runs-visible';
import { eq } from 'drizzle-orm';

export const policy = routePolicy({
  GET: { class: 'area', area: 'settings' },
  POST: {
    class: 'area',
    area: 'settings',
    item: { none: 'manages the settings area: the Admin step checks it' },
  },
});

/** Whether the caller sees run `id` (its row's login: lib/runs-visible.ts). */
async function visible(id: string, user: RunViewer): Promise<boolean> {
  const [row] = await db
    .select({ loginId: runs.loginId })
    .from(runs)
    .where(eq(runs.id, id))
    .limit(1);
  return row !== undefined && runVisibleTo(row, user);
}

/** GET /api/runs/:id — one run's compiled tree (the run view payload). A
 *  run is its own login's, a run naming no login the brain owner's
 *  (lib/runs-visible.ts): anyone else is answered 404, as for a run that is
 *  not there. The cancel below is held to the same rule. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await params;
  const compiled = await compileRunState(db, id);
  if (!compiled || compiled.run.ownerId !== user.id || !(await visible(id, user))) {
    return NextResponse.json({ error: 'run not found' }, { status: 404 });
  }
  return NextResponse.json(compiled);
}

/** POST /api/runs/:id — actions on a run. Body `{action:'cancel'}`: the
 *  operator Stop actuator (the same `cancelRun` the run_cancel tool uses — CAS
 *  from running|paused; in-flight work no-ops at the engine's CAS; the sweep
 *  janitor expires any orphaned pending questions). Stays live with MANTLE_RUNS
 *  off, matching run_cancel's always-on posture. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await params;
  const body = (await readJson(req)) as { action?: string };
  if (body.action !== 'cancel') {
    return NextResponse.json({ error: "expected { action: 'cancel' }" }, { status: 400 });
  }
  const compiled = await compileRunState(db, id);
  if (!compiled || compiled.run.ownerId !== user.id || !(await visible(id, user))) {
    return NextResponse.json({ error: 'run not found' }, { status: 404 });
  }
  // A run's status is what the sweep executes: its change runs at the
  // full-route spot run-control, never on the narrow login.
  const { cancelled } = await onFullSystemRoute('run-control', () => cancelRun(db, id));
  return NextResponse.json({
    cancelled,
    ...(cancelled ? {} : { note: 'run already terminal — nothing to cancel' }),
  });
}
