import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { probeApiKey } from '@/lib/api-key-test';
import { ownerCaller } from '@/lib/auth';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'area',
    area: 'keys',
    item: { none: 'manages the keys area: the Admin step checks it' },
  },
});

const Body = z.object({ keyId: z.string().min(1), service: z.string().min(1) });

/** Probe a stored API key against its provider — "does this key work?". */
export async function POST(req: Request) {
  ownerCaller();
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid input' }, { status: 400 });
  }
  return NextResponse.json(await probeApiKey(parsed.data.keyId, parsed.data.service));
}
