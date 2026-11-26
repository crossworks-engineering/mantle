/**
 * POST /api/secrets/[id]/reveal — return the decrypted note and fields.
 *
 * A workspace kind since 0400 (owner, 2026-11-26): whoever reads the secret
 * may reveal it, by hand. Each reveal is logged first (`secret.reveal`, the
 * secret's id, never its value), awaited: a reveal whose row could not be
 * written reveals nothing. An Admin user with the users area reads the
 * trail, so IT knows what to change when someone leaves.
 *
 * Its own path, so a reveal stands out in access logs. No MCP tool calls
 * it (route-mcp-ledger: the value would enter the model), and no API key
 * reaches it (the secrets routes have no /api/v1 row). No cache headers;
 * never proxied.
 */
import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { getSecretMetadata, revealSecret } from '@/lib/secrets';
import { logAudit, requestMeta } from '@/lib/audit';
import { CACHE_CONTROL } from '@/lib/cache-control';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

/** The [id] is a uuid: any other names nothing, the one 404 before the
 *  handler (lib/route-params.ts). */
export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  POST: {
    class: 'content',
    open: 'owner',
    item: { param: 'id', need: 'read' },
    // Its own row (secret.reveal), not the generic api.write.
    audit: 'own',
  },
});

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  // A secret the caller does not read is not found, and logs nothing.
  if (!(await getSecretMetadata(user.id, id))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  await logAudit({
    actorId: user.actor.id,
    actorEmail: user.actor.email,
    action: 'secret.reveal',
    method: 'POST',
    path: `/api/secrets/${id}/reveal`,
    ...(await requestMeta()),
    detail: { secretId: id },
  });
  const result = await revealSecret(user.id, id);
  if (!result) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(
    { metadata: result.metadata, payload: result.payload },
    {
      headers: {
        // Sensitive: never stored in any cache between us and the browser.
        'Cache-Control': CACHE_CONTROL.secret,
      },
    },
  );
}
