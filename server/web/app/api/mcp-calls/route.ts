/**
 * GET /api/mcp-calls: the MCP call log (Journal v3 J8, migration 0345), one
 * row per MCP tool call, newest first. The read runs in the caller's scope,
 * where the table's row rule decides what it sees: a login its own calls,
 * an Admin user every login's. No reply bodies are kept (the arguments are
 * redacted and capped when written, @mantle/mcp-core call-log.ts).
 *
 * Query: `login` (an Admin user's narrowing to one login), `session`,
 * `tool`, `before` (an ISO time: the next page), `limit` (1 to 200,
 * default 50).
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { listMcpCalls } from '@mantle/db';
import { firstIssue } from '@/lib/zod-issue';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'content', open: 'owner' },
});

const Query = z.object({
  login: z.string().uuid().optional(),
  session: z.string().uuid().optional(),
  tool: z
    .string()
    .regex(/^[A-Za-z0-9_.:-]{1,128}$/)
    .optional(),
  before: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export async function GET(req: Request) {
  ownerCaller();
  const sp = new URL(req.url).searchParams;
  const parsed = Query.safeParse(Object.fromEntries(sp.entries()));
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  const q = parsed.data;
  const rows = await listMcpCalls({
    loginId: q.login,
    sessionId: q.session,
    tool: q.tool,
    before: q.before ? new Date(q.before) : undefined,
    limit: q.limit,
  });
  return NextResponse.json({
    rows: rows.map((r) => ({
      id: r.id,
      loginId: r.loginId,
      via: r.via,
      workspaceId: r.workspaceId,
      sessionId: r.sessionId,
      tool: r.tool,
      args: r.args,
      ok: r.ok,
      error: r.error,
      durationMs: r.durationMs,
      itemIds: r.itemIds,
      resultBytes: r.resultBytes,
      createdAt: r.createdAt.toISOString(),
    })),
  });
}
