import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOwner } from '@/lib/auth';
import { testChat } from '@/lib/ai-worker-rpc';

const Body = z.object({ prompt: z.string().default('') });

/** One-shot prompt through a chat-shaped worker's adapter. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'invalid input' }, { status: 400 });
  try {
    return NextResponse.json(await testChat(user.id, id, parsed.data.prompt));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
