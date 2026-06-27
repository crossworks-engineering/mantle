import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { testImageGen } from '@/lib/ai-worker-rpc';

const Body = z.object({
  prompt: z.string().default(''),
  overrides: z
    .object({ size: z.string().optional(), style: z.string().optional(), quality: z.string().optional() })
    .optional(),
});

/** Generate an image from a prompt via an image_gen worker (base64 bytes). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'invalid input' }, { status: 400 });
  try {
    return NextResponse.json(await testImageGen(user.id, id, parsed.data.prompt, parsed.data.overrides));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
