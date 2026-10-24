/**
 * DELETE /api/access-keys/:id : revoke one inbound API key (plan page
 * 1e62e204). Every login, any role. The key stops on its next request. The
 * row stays (revoked) so the list and the audit trail still name it.
 *
 * A member or client revokes only their own keys (another key is a 404, as
 * if it did not exist). Any admin may revoke any key, another admin's own
 * key included (audit item 4, decided): revoke is the safe direction, and a
 * leaked key must be stoppable by whoever sees it first. Making a key is
 * the guarded step: a key acts only as the login that made it.
 */
import { NextResponse } from '@/server/http-compat';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@mantle/db';
import { forgetRequestLogins, loginCaller, type AnyLogin } from '@/lib/auth';
import { auditFireAndForget, requestMeta } from '@/lib/audit';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  DELETE: {
    class: 'self',
    scope: null,
    open: 'any',
    item: { none: 'not decided yet: the write names an item no check reads' },
    audit: 'own',
  },
});

const Params = z.object({ id: z.string().uuid() });

type Ctx = { params: Promise<{ id: string }> };

async function handleDELETE(login: AnyLogin, ctx: Ctx) {
  const params = Params.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  // By its definer (mantle_access_key_revoke, 0293): the login's own live
  // key, any live key for an Admin user; the workspace and write roles hold
  // no right on the keys (A6b: on the system pool before, 'rule-in-query').
  // A write: its own transaction, on the write role in the login's scope
  // (an Admin user's as a member's).
  const [row] = await db.transaction(
    async (tx) =>
      (await tx.execute(
        sql`select id::text as id, key_prefix as "keyPrefix", name, login_id::text as "loginId"
              from "public"."mantle_access_key_revoke"(${params.data.id}::uuid, ${login.loginId}::uuid)`,
      )) as unknown as { id: string; keyPrefix: string; name: string; loginId: string }[],
  );
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  // A later guard read in this request finds the login row afresh (A4 step
  // 3a audit L1), not the key: findKeyLogin reads the gate's grant and never
  // checks the key again, so a request that came in on the key it revokes
  // keeps the key's login for the rest of the request, as on main.
  forgetRequestLogins();
  auditFireAndForget({
    actorId: login.loginId,
    actorEmail: login.email,
    action: 'key.revoked',
    method: 'DELETE',
    path: `/api/access-keys/${row.id}`,
    ...(await requestMeta()),
    detail: {
      keyId: row.id,
      keyPrefix: `mtlk_${row.keyPrefix}`,
      name: row.name,
      loginId: row.loginId,
    },
  });
  return NextResponse.json({ ok: true });
}

/** The login the pipeline answered (A4 hand batch A); the handler runs
 *  where the request runs. */
export async function DELETE(_req: Request, ctx: Ctx) {
  const login = loginCaller();
  return handleDELETE(login, ctx);
}
