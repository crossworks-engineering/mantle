import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { requestUpdate } from '@/lib/updates';
import { getOwnerOr401 } from '@/lib/auth';

const Body = z
  .object({
    target: z.string().min(1).optional(),
    clientTarget: z.string().min(1).optional(),
  })
  .refine((b) => b.target || b.clientTarget, { message: 'target or clientTarget required' });

/** Ask the updater sidecar to roll: `target` is the server release tag (the
 *  sidecar pairs the owner UI from the target image), `clientTarget` alone
 *  rolls just the interface. Returns the updater's {ok}|{ok:false,error}
 *  result with a 200 so the client can branch on it (a sidecar-absent / busy
 *  state isn't an HTTP error). */
export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  return NextResponse.json(
    await requestUpdate(parsed.data.target ?? null, parsed.data.clientTarget ?? null),
  );
}
