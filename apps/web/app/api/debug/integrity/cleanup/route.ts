import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireOwner } from '@/lib/auth';
import { cleanupProbes } from '@/lib/integrity/cleanup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  /** A run tag (`integrity-probe-<run>`) to clean one run; omit to clean ALL probe data. */
  tag: z.string().max(40).optional(),
});

export async function POST(req: Request) {
  const user = await requireOwner();
  const raw = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'invalid input' }, { status: 400 });
  }
  const result = await cleanupProbes(user.id, parsed.data.tag);
  return NextResponse.json(result);
}
