import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { cancelRun, forkRun, getRunDetail, resumeRun, restartRun } from '@/lib/runners';

/** GET /api/runners/[id] — one run with its steps + (truncated) input/output,
 *  or 404. Drives the detail pane. Owner-gated. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
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
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await params;

  const parsed = ActionBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid action' },
      { status: 400 },
    );
  }
  const body = parsed.data;

  try {
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[api/runners] ${body.action} failed for ${id}:`, msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
