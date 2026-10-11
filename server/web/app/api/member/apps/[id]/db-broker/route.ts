import { NextResponse } from '@/server/http-compat';
import { memberMayWriteAppData, recordAppAccess } from '@mantle/content';
import { appDbExec, appDbQuery } from '@mantle/content/app-broker';
import { scheduleAppTableExportSync } from '@mantle/content/app-table-exports';
import { getMemberOr401 } from '@/lib/auth';
import {
  AppDbBody,
  appDbBodyError,
  appDbErrorResponse,
  readOnlyAppResponse,
} from '@/lib/app-db-broker-body';
import { memberAppOr404 } from '@/lib/member-apps';
import { readJsonCapped } from '@/lib/body-limit';
import { rateLimit } from '@/lib/rate-limit';

/**
 * POST /api/member/apps/:id/db-broker: a member's run of an app calls
 * host.db.query / host.db.exec on the app's own SQLite (member logins Phase
 * 4b). Row security does not reach SQLite, so the reach check is explicit
 * (memberAppOr404: a workspace of the member holds the app's grant, and its
 * published build is green). A member writes the data when a workspace of
 * theirs holds the app with Write on AND the app is not informational
 * (`dataReadOnly`, PATCH /api/apps/:id; it writes no grant, contract change
 * 36), else a write answers 403 `reason: 'read-only'`
 * (memberMayWriteAppData over memberWritesSql). The levels decide nothing. App
 * data is shared per app, not per member (v1): every member who may write it
 * writes the same database.
 *
 * App identity: the member fills the reserved `:host_me_*` parameters
 * (kind 'member', the login's display name, a per-app id); a value the
 * browser sends for one is refused.
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
  const parsed = AppDbBody.safeParse((await readJsonCapped(req)) ?? {});
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: appDbBodyError(parsed.error) }, { status: 400 });
  }
  const { id } = await ctx.params;
  const app = await memberAppOr404(member.anchorId, id, member.loginId);
  if (app instanceof Response) return app;
  // A member-built app (team apps Phase 3) runs at team level: every member
  // who may run it writes it, unless it is under review (read only). Its
  // database is keyed to the author's space (`app.ownerId`).

  const { op, sql, params } = parsed.data;
  if (op === 'exec' && !memberMayWriteAppData(app)) {
    recordAppAccess({
      ownerId: app.ownerId,
      appNodeId: app.id,
      actorId: member.loginId,
      kind: 'db',
      detail: { via: 'member', op, refused: 'read-only' },
    });
    return readOnlyAppResponse('This app is read-only for team members.');
  }
  recordAppAccess({
    ownerId: app.ownerId,
    appNodeId: app.id,
    actorId: member.loginId,
    kind: 'db',
    detail: { via: 'member', op },
  });
  // One statement at a time per login (client tier audit I1): a second
  // waits its turn, so one login never holds every SQL process.
  const caller = {
    callerKey: `member:${member.loginId}`,
    viewer: { kind: 'member' as const, loginId: member.loginId, name: member.displayName },
    // Rows only (access matrix audit, M1): below admin a write changes rows,
    // never the schema, a trigger or a view; the schema is the author's
    // (app_db_schema_set). The same authorizer as the MCP app_data_write.
    dataOnly: true,
  };
  try {
    const output =
      op === 'query'
        ? await appDbQuery(app.ownerId, app.id, sql, params, app.manifest.sqlite, caller)
        : await appDbExec(app.ownerId, app.id, sql, params, app.manifest.sqlite, caller);
    // A write may feed a linked app-table export: debounced, hash-gated, and
    // run for the brain (the sync is not a member act). Cost is bounded, not
    // zero (decided 2026-09-26); exported tables stay admin level.
    if (op === 'exec' && !app.spaceApp) scheduleAppTableExportSync(member.anchorId, app.id);
    return NextResponse.json({ ok: true, output });
  } catch (err) {
    return appDbErrorResponse(err, 'member-db-broker', {
      ownerId: app.ownerId,
      appNodeId: app.id,
      actorId: member.loginId,
      via: 'member',
      op,
      sql,
    });
  }
}
