import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { cancelRun, forkRun, getRunDetail, resumeRun, restartRun } from '@/lib/runners';
import { firstIssue } from '@/lib/zod-issue';
import { readJson } from '@/lib/read-body';

/** GET /api/runners/[id] — one run with its steps + (truncated) input/output,
 *  or 404. Drives the detail pane. Owner-gated. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  ownerCaller();
  const { id } = await params;
  const run = await getRunDetail(id);
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
 * Owner-gated. These act on the live runner system.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  ownerCaller();
  const { id } = await params;

  const parsed = ActionBody.safeParse(await readJson(req));
  if (!parsed.success) {
    return NextResponse.json(
      { error: firstIssue(parsed.error, 'invalid action') },
      { status: 400 },
    );
  }
  const body = parsed.data;

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
