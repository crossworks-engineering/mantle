/**
 * GET /api/mcp-logins : the member and client logins and their MCP access
 * (MCP as a login, plan page e5b854dd): the per-login switch, the write
 * switch, and the live static tokens (label and dates, never the secret).
 * Owner only. Settings, MCP renders it.
 */
import { NextResponse } from '@/server/http-compat';
import { and, asc, inArray, isNull } from 'drizzle-orm';
import { authUsers, db, mcpLoginAccess, mcpLoginTokens } from '@mantle/db';
import { getOwnerOr401 } from '@/lib/auth';

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const logins = await db
    .select({
      id: authUsers.id,
      email: authUsers.email,
      displayName: authUsers.displayName,
      role: authUsers.role,
      disabledAt: authUsers.disabledAt,
    })
    .from(authUsers)
    .where(inArray(authUsers.role, ['member', 'client']))
    .orderBy(asc(authUsers.email));
  const ids = logins.map((l) => l.id);
  const [access, tokens] = ids.length
    ? await Promise.all([
        db.select().from(mcpLoginAccess).where(inArray(mcpLoginAccess.loginId, ids)),
        db
          .select({
            id: mcpLoginTokens.id,
            loginId: mcpLoginTokens.loginId,
            label: mcpLoginTokens.label,
            createdAt: mcpLoginTokens.createdAt,
            lastUsedAt: mcpLoginTokens.lastUsedAt,
          })
          .from(mcpLoginTokens)
          .where(and(inArray(mcpLoginTokens.loginId, ids), isNull(mcpLoginTokens.revokedAt)))
          .orderBy(asc(mcpLoginTokens.createdAt)),
      ])
    : [[], []];
  const accessBy = new Map(access.map((a) => [a.loginId, a]));
  return NextResponse.json(
    {
      logins: logins.map((l) => ({
        id: l.id,
        email: l.email,
        displayName: l.displayName,
        role: l.role,
        disabled: !!l.disabledAt,
        enabled: accessBy.get(l.id)?.enabled === true,
        writeEnabled: accessBy.get(l.id)?.writeEnabled === true,
        tokens: tokens
          .filter((t) => t.loginId === l.id)
          .map((t) => ({
            id: t.id,
            label: t.label,
            createdAt: t.createdAt.toISOString(),
            lastUsedAt: t.lastUsedAt ? t.lastUsedAt.toISOString() : null,
          })),
      })),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
