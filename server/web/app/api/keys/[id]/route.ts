import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { deleteApiKey, setApiKeyAnthropicWorkspace } from '@/lib/api-keys';
import { retryProvidersAfterKeyChange } from '@/lib/embedding-config';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  PATCH: {
    class: 'area',
    area: 'keys',
    item: { none: 'manages the keys area: the Admin step checks it' },
  },
  DELETE: {
    class: 'area',
    area: 'keys',
    item: { none: 'manages the keys area: the Admin step checks it' },
  },
});

const IdParams = z.object({ id: z.string().uuid() });

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const parsed = IdParams.safeParse(await ctx.params);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  }
  const ok = await deleteApiKey(user.id, parsed.data.id);
  if (!ok) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  return NextResponse.json({ ok: true });
}

const PatchBody = z.object({
  /** The Anthropic workspace id to send with this key; null or blank clears
   *  it. The key value is never part of this call. */
  anthropicWorkspaceId: z.string().max(256).nullable(),
});

/** Set or clear the Anthropic workspace id on a stored key. A key of another
 *  service, or an id that could never be a header value, answers 400 with
 *  the reason (InputError from @mantle/api-keys). On success an open
 *  provider alert probes now (retryProvidersAfterKeyChange). */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const parsed = IdParams.safeParse(await ctx.params);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  }
  const body = PatchBody.safeParse(await readJson(req));
  if (!body.success) {
    return NextResponse.json(
      { error: 'anthropicWorkspaceId required (null clears it).' },
      { status: 400 },
    );
  }
  const row = await setApiKeyAnthropicWorkspace(
    user.id,
    parsed.data.id,
    body.data.anthropicWorkspaceId,
  );
  if (!row) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  // The key's credential changed: an open provider alert probes now, so a
  // fixed workspace id clears it. Only an Anthropic key gets
  // here (setApiKeyAnthropicWorkspace refuses another service).
  await retryProvidersAfterKeyChange(user.id, 'anthropic');
  return NextResponse.json(row);
}
