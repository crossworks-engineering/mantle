import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { testEmbeddingModel } from '@/lib/ai-worker-rpc';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'area',
    area: 'settings',
    item: { none: 'manages the settings area: the Admin step checks it' },
  },
});

const Body = z.object({ model: z.string().min(1) });

/** Embed a sentinel string and report the model's actual output dimension. */
export async function POST(req: Request) {
  const user = ownerCaller();
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success)
    return NextResponse.json({ ok: false, error: 'model required' }, { status: 400 });
  return NextResponse.json(await testEmbeddingModel(user.id, parsed.data.model));
}
