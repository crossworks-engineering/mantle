import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { probeApiKey } from '@/lib/api-key-test';
import { getOwnerOr401 } from '@/lib/auth';

const Body = z.object({ keyId: z.string().min(1), service: z.string().min(1) });

/** Probe a stored API key against its provider — "does this key work?". */
export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid input' }, { status: 400 });
  }
  return NextResponse.json(await probeApiKey(parsed.data.keyId, parsed.data.service));
}
