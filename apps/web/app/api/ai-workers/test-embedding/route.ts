import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOwner } from '@/lib/auth';
import { testEmbeddingModel } from '@/lib/ai-worker-rpc';

const Body = z.object({ model: z.string().min(1) });

/** Embed a sentinel string and report the model's actual output dimension. */
export async function POST(req: Request) {
  const user = await requireOwner();
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ ok: false, error: 'model required' }, { status: 400 });
  return NextResponse.json(await testEmbeddingModel(user.id, parsed.data.model));
}
