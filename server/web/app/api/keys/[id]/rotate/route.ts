import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { setVaultKey, vaultActor } from '@/lib/api-keys';
import { afterVaultKeyReplaced } from '@/lib/mcp-connectors';
import { retryProvidersAfterKeyChange } from '@/lib/embedding-config';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'area',
    area: 'keys',
    item: { none: 'manages the keys area: the Admin step checks it' },
  },
});

const RotateBody = z.object({
  plaintext: z.string().min(1).max(16384),
});

/** A new value for a stored secret, its kind, fields and target kept (the
 *  vault's write gateway). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  const idParse = z.string().uuid().safeParse(id);
  if (!idParse.success) {
    return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  }
  const raw = await readJson(req);
  const body = RotateBody.safeParse(raw);
  if (!body.success) {
    return NextResponse.json({ error: 'Plaintext required.' }, { status: 400 });
  }
  const result = await setVaultKey(vaultActor(user), user.id, {
    ref: { id: idParse.data },
    value: body.data.plaintext,
  });
  if (!result) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  const { key } = result;
  // Another key may be another account: a connector's marks were for the
  // old one (access matrix T7).
  await afterVaultKeyReplaced(user.id, key.service, key.label);
  // A new model provider key value: an open provider alert probes now (no
  // alert open, nothing is sent).
  await retryProvidersAfterKeyChange(user.id, key.service);
  return NextResponse.json({ id: key.id, updatedAt: key.updatedAt });
}
