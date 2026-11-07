import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import {
  cancelRun,
  forkRun,
  getRunDetail,
  rerunRefused,
  resumeRun,
  restartRun,
} from '@/lib/runners';
import { firstIssue } from '@/lib/zod-issue';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'settings' },
  POST: {
    class: 'area',
    area: 'settings',
    item: { none: 'manages the settings area: the Admin step checks it' },
  },
});

/** GET /api/runners/[id] — one run with its steps + (truncated) input/output,
 *  or 404. Drives the detail pane. Owner-gated. A chat turn's input and
 *  output show whole only to the login that ran it; any other viewer reads
 *  its metadata (lib/runners.ts runShown). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await params;
  // The viewer: a turn's own login reads its text (lib/runners.ts runShown).
  const run = await getRunDetail(id, user.actor.id);
  if (!run) return NextResponse.json({ error: 'Run not found.' }, { status: 404 });
  return NextResponse.json({ run });
}

const ActionBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('cancel') }),
  z.object({ action: z.literal('resume') }),
  z.object({ action: z.literal('restart') }),
  z.object({ action: z.literal('fork'), startStep: z.number().int().min(0) }),
]);

/**
 * POST /api/runners/[id] — run a lifecycle action against the workflow.
 *   cancel  → CANCELLED (no new id)
 *   resume  → resume from last step (no new id)
 *   restart → fork from step 0 → returns { newWorkflowID }
 *   fork    → fork from { startStep } → returns { newWorkflowID }
 * Owner-gated. These act on the live runner system. Every action on a chat
 * turn is the login's it served: a restart or fork re-runs it as that login,
 * a resume drives its window again, a cancel ends it. Anyone else is
 * answered 404, as for a run that is not there (lib/runners.ts
 * rerunRefused).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await params;

  const parsed = ActionBody.safeParse(await readJson(req));
  if (!parsed.success) {
    return NextResponse.json(
      { error: firstIssue(parsed.error, 'invalid action') },
      { status: 400 },
    );
  }
  const body = parsed.data;
  // Every action on a chat turn is its own login's: a restart or fork re-runs
  // it as that login, a resume drives its window again, a cancel ends it.
  if (await rerunRefused(id, user.actor.id)) {
    return NextResponse.json({ error: 'Run not found.' }, { status: 404 });
  }

  // The engine's refusal of the action (no such run, not in a state for it)
  // answers 500 with its message by its row (RunActionError, lib/runners.ts),
  // as the route said it; any other failure is a fault: the opaque 500.
  switch (body.action) {
    case 'cancel':
      await cancelRun(id);
      return NextResponse.json({ ok: true });
    case 'resume':
      await resumeRun(id);
      return NextResponse.json({ ok: true });
    case 'restart':
      return NextResponse.json({ ok: true, newWorkflowID: await restartRun(id) });
    case 'fork':
      return NextResponse.json({ ok: true, newWorkflowID: await forkRun(id, body.startStep) });
  }
}
