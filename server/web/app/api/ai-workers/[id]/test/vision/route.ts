import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { testVision } from '@/lib/ai-worker-rpc';
import { errorMessage } from '@mantle/std';
import { readJson } from '@/lib/read-body';

const Body = z.object({
  imageBase64: z.string().min(1),
  mimeType: z.string().default('image/jpeg'),
});

/** Extract text/description from a user-supplied image via a vision worker. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) return NextResponse.json({ error: 'imageBase64 required' }, { status: 400 });
  try {
    return NextResponse.json(
      await testVision(user.id, id, parsed.data.imageBase64, parsed.data.mimeType),
    );
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 400 });
  }
}
