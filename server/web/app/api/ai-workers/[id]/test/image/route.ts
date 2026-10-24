import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { testImageGen } from '@/lib/ai-worker-rpc';
import { errorMessage } from '@mantle/std';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'area',
    area: 'settings',
    item: { none: 'manages the settings area: the Admin step checks it' },
  },
});

const Body = z.object({
  prompt: z.string().default(''),
  overrides: z
    .object({
      size: z.string().optional(),
      style: z.string().optional(),
      quality: z.string().optional(),
    })
    .optional(),
});

/** Generate an image from a prompt via an image_gen worker (base64 bytes). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) return NextResponse.json({ error: 'invalid input' }, { status: 400 });
  try {
    return NextResponse.json(
      await testImageGen(user.id, id, parsed.data.prompt, parsed.data.overrides),
    );
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 400 });
  }
}
