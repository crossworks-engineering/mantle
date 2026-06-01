import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireOwner } from '@/lib/auth';
import { runIntegritySuite } from '@/lib/integrity/runner';

// The run inserts fixtures and waits on the (eventually-consistent) extractor,
// so it can take tens of seconds. Operator-only debug surface; synchronous.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const Body = z.object({
  only: z.array(z.string()).optional(),
  timeoutMs: z.number().int().min(5_000).max(120_000).optional(),
  includeUpdate: z.boolean().optional(),
  includeDelete: z.boolean().optional(),
});

export async function POST(req: Request) {
  const user = await requireOwner();
  const raw = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'invalid input' }, { status: 400 });
  }
  const report = await runIntegritySuite(user.id, parsed.data);
  return NextResponse.json(report);
}
