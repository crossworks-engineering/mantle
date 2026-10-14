import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { testTts } from '@/lib/ai-worker-rpc';
import { errorMessage } from '@mantle/std';
import { readJson } from '@/lib/read-body';

const Body = z.object({ text: z.string().optional() });

/** Synthesize a short audio sample with a tts worker's config (base64 mp3). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) return NextResponse.json({ error: 'invalid input' }, { status: 400 });
  try {
    return NextResponse.json(await testTts(user.id, id, parsed.data.text));
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 400 });
  }
}
