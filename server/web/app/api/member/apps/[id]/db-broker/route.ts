import { NextResponse } from '@/server/http-compat';
import { recordAppAccess } from '@mantle/content';
import { appDbExec, appDbQuery } from '@mantle/content/app-broker';
import { scheduleAppTableExportSync } from '@mantle/content/app-table-exports';
import { errorMessage } from '@mantle/std';
import { getMemberOr401 } from '@/lib/auth';
import { AppDbBody, appDbBodyError } from '@/lib/app-db-broker-body';
import { memberAppOr404 } from '@/lib/member-apps';
import { rateLimit } from '@/lib/rate-limit';

/**
 * POST /api/member/apps/:id/db-broker: a member's run of an app calls
 * host.db.query / host.db.exec on the app's own SQLite (member logins Phase
 * 4b). Row security does not reach SQLite, so the audience check is explicit
 * (memberAppOr404: team level or lower, published). Team apps may write, as
 * team-mode shares do. App data is shared per app, not per member (v1):
 * every member reads and writes the same database.
 *
 * The SQLite work runs on the admin pool: it writes the app's database
 * registry rows, which the team role cannot.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  // Generous (a running app is query-chatty) but bounded.
  const gate = rateLimit(`member-db-broker:${member.loginId}`, { max: 300, windowMs: 60_000 });
  if (!gate.ok) {
    return NextResponse.json(
      { ok: false, error: 'too many requests' },
      { status: 429, headers: { 'retry-after': String(gate.retryAfterSec) } },
    );
  }
  const parsed = AppDbBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: appDbBodyError(parsed.error) }, { status: 400 });
  }
  const { id } = await ctx.params;
  const app = await memberAppOr404(member.anchorId, id);
  if (app instanceof Response) return app;

  recordAppAccess({
    ownerId: member.anchorId,
    appNodeId: app.id,
    actorId: member.loginId,
    kind: 'db',
    detail: { op: parsed.data.op },
  });
  const { op, sql, params } = parsed.data;
  try {
    const output =
      op === 'query'
        ? await appDbQuery(member.anchorId, app.id, sql, params, app.manifest.sqlite)
        : await appDbExec(member.anchorId, app.id, sql, params, app.manifest.sqlite);
    // A write may feed a linked app-table export: debounced, hash-gated, and
    // run for the brain (the sync is not a member act). Cost is bounded, not
    // zero (decided 2026-09-26); exported tables stay admin level.
    if (op === 'exec') scheduleAppTableExportSync(member.anchorId, app.id);
    return NextResponse.json({ ok: true, output });
  } catch (err) {
    return NextResponse.json({ ok: false, error: errorMessage(err) }, { status: 400 });
  }
}
