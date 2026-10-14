import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { testStt } from '@/lib/ai-worker-rpc';
import { errorMessage } from '@mantle/std';
import { readJson } from '@/lib/read-body';

const Body = z.object({
  audioBase64: z.string().min(1),
  mimeType: z.string().default('audio/webm'),
});

/** Transcribe a user-supplied audio sample (base64) via an stt worker. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) return NextResponse.json({ error: 'audioBase64 required' }, { status: 400 });
  try {
    return NextResponse.json(
      await testStt(user.id, id, parsed.data.audioBase64, parsed.data.mimeType),
    );
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 400 });
  }
}
