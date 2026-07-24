import { NextResponse } from 'next/server';
import { z } from 'zod';

import { getOwnerOr401 } from '@/lib/auth';
import { getTask } from '@/lib/maintenance/registry';
import { planRun } from '@/lib/maintenance/run-args';
import { getRun, isRunning, startRun } from '@/lib/maintenance/run-store';

// Start (POST) / poll (GET) a maintenance run. The rails mirror the CLI
// (scripts/maintain.ts) via the shared planRun() — the UI cannot bypass them.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  slug: z.string().min(1),
  apply: z.boolean(),
  confirmSpend: z.boolean().optional(),
  forceRetired: z.boolean().optional(),
});

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  return NextResponse.json({ run: getRun() });
}

export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;

  const raw = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }

  const task = getTask(parsed.data.slug);
  if (!task) {
    return NextResponse.json({ error: `unknown task "${parsed.data.slug}"` }, { status: 404 });
  }

  const plan = planRun(task, parsed.data, process.env);
  if (!plan.ok) {
    return NextResponse.json({ error: plan.error }, { status: plan.status });
  }

  if (isRunning()) {
    return NextResponse.json(
      { error: 'a maintenance run is already in progress' },
      { status: 409 },
    );
  }

  const started = startRun(task, plan.args, plan.live);
  if (!started.ok) {
    return NextResponse.json({ error: started.error }, { status: 409 });
  }
  return NextResponse.json({ id: started.id, run: getRun() });
}
