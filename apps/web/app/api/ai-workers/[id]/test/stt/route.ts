import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { testStt } from '@/lib/ai-worker-rpc';

const Body = z.object({
  audioBase64: z.string().min(1),
  mimeType: z.string().default('audio/webm'),
});

/** Transcribe a user-supplied audio sample (base64) via an stt worker. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'audioBase64 required' }, { status: 400 });
  try {
    return NextResponse.json(
      await testStt(user.id, id, parsed.data.audioBase64, parsed.data.mimeType),
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
