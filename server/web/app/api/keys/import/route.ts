import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { importVaultKeys, vaultActor, vaultKeyReply } from '@/lib/api-keys';
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

const Body = z.object({
  csv: z
    .string()
    .min(1)
    .max(1024 * 1024),
});

/**
 * Import secrets from CSV text: name, kind, target, user, secret, tags (the
 * vault's write gateway). Every row is checked first; a bad row writes
 * nothing and answers 400 with each bad row's number and reason (never a
 * cell's content). Never answers a value.
 */
export async function POST(req: Request) {
  const user = ownerCaller();
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Send csv: name,kind,target,user,secret,tags, one secret per row.' },
      { status: 400 },
    );
  }
  const result = await importVaultKeys(vaultActor(user), user.id, parsed.data.csv);
  if (!result.ok) {
    return NextResponse.json(
      { error: 'Some rows were refused; nothing was written.', failed: result.failed },
      { status: 400 },
    );
  }
  for (const { key, secretWritten } of result.keys) {
    if (!secretWritten) continue;
    await afterVaultKeyReplaced(user.id, key.service, key.label);
    await retryProvidersAfterKeyChange(user.id, key.service);
  }
  return NextResponse.json({
    added: result.added,
    replaced: result.replaced,
    keys: result.keys.map((k) => vaultKeyReply(k.key)),
  });
}
