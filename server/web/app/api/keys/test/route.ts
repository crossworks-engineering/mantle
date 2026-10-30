import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { testVaultKey, vaultActor } from '@/lib/api-keys';
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

/** `service` is the older form's; the key's own row names it now. */
const Body = z.object({ keyId: z.string().uuid(), service: z.string().min(1).optional() });

/** Test a stored secret (the vault's write gateway): a token against its
 *  provider, "does this key work?"; another kind its stored shape. */
export async function POST(req: Request) {
  const user = ownerCaller();
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid input' }, { status: 400 });
  }
  const result = await testVaultKey(vaultActor(user), user.id, { id: parsed.data.keyId });
  if (!result) {
    return NextResponse.json({
      ok: false,
      message: 'Key not found or could not be decrypted.',
      provider: parsed.data.service ?? '',
      adapter: '',
    });
  }
  return NextResponse.json(result);
}
