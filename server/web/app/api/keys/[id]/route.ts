import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { deleteVaultKey, setVaultKey, vaultActor, vaultKeyReply } from '@/lib/api-keys';
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
  const gone = await deleteVaultKey(vaultActor(user), user.id, { id: parsed.data.id });
  if (!gone) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  return NextResponse.json({ ok: true });
}

const PatchBody = z
  .object({
    /** The Anthropic workspace id to send with this key; null or blank
     *  clears it. */
    anthropicWorkspaceId: z.string().max(256).nullable().optional(),
    /** Where the secret may be used: hosts or web origins (replaces the
     *  list). */
    target: z.array(z.string().max(300)).max(32).optional(),
    tags: z.array(z.string().max(40)).max(20).optional(),
    needsApproval: z.boolean().optional(),
    viaTailnet: z.boolean().optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined));

/** Change what a stored secret carries besides its value: the Anthropic
 *  workspace id, its target, tags, approval or tailnet switch. The value is
 *  never part of this call (rotate replaces it). A refusal answers 400 with
 *  the reason (InputError from the vault's write gateway). On a workspace id
 *  change an open provider alert probes now (retryProvidersAfterKeyChange). */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const parsed = IdParams.safeParse(await ctx.params);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  }
  const body = PatchBody.safeParse(await readJson(req));
  if (!body.success) {
    return NextResponse.json(
      {
        error:
          'Send anthropicWorkspaceId (null clears it), target, tags, needsApproval or viaTailnet.',
      },
      { status: 400 },
    );
  }
  const b = body.data;
  const result = await setVaultKey(vaultActor(user), user.id, {
    ref: { id: parsed.data.id },
    ...(b.anthropicWorkspaceId !== undefined
      ? { anthropicWorkspaceId: b.anthropicWorkspaceId }
      : {}),
    ...(b.target !== undefined ? { target: b.target } : {}),
    ...(b.tags !== undefined ? { tags: b.tags } : {}),
    ...(b.needsApproval !== undefined ? { needsApproval: b.needsApproval } : {}),
    ...(b.viaTailnet !== undefined ? { viaTailnet: b.viaTailnet } : {}),
  });
  if (!result) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  // The key's credential changed: an open provider alert probes now, so a
  // fixed workspace id clears it.
  if (b.anthropicWorkspaceId !== undefined) {
    await retryProvidersAfterKeyChange(user.id, result.key.service);
  }
  return NextResponse.json(vaultKeyReply(result.key));
}
