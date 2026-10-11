/**
 * Running an app as a non-Admin login (workspaces W7e). The owner runner
 * routes (/api/apps/:id/{frame-ticket,frame,db-broker,tool-broker}) are open
 * to every login since W7e; an Admin user runs an app as before, a member
 * through these functions. The member runner routes (/api/member/apps/:id/*)
 * call the same functions: they are deprecated and kept this release only,
 * for an older UI.
 *
 * The rules (member logins Phase 4b, plan R2, unchanged):
 *  - the app: one a workspace of the login holds, with a green PUBLISHED
 *    build (never the draft), read in the login's own scope
 *    (memberAppOr404). Anything else is the same plain 404.
 *  - its data: the app's own SQLite. The login writes it when a workspace of
 *    its holds the app with Write on and the app is not informational
 *    (memberMayWriteAppData); else a write answers 403 `read-only`. Rows
 *    only, never the schema (dataOnly).
 *  - its tools: the team rules (appToolLevel 'team': the author ceiling and
 *    the holders never lift a member's run above them), on a team surface
 *    naming the login, reading through the app (its holders met with the
 *    login's workspaces), never the login's other workspaces. A tool that
 *    needs the owner's confirmation is refused.
 *
 * Where it runs: the lookup of the app in the login's request scope (the
 * session guard entered it). The app's SQLite work (its registry rows) and
 * the tool registry are system bookkeeping, done after that lookup found the
 * app, by the named door ('app-data', AS_SYSTEM_TURN_REASONS), exactly as
 * the member brokers always ran them; a tool call then enters the app's run
 * scope (appToolScope). Outside a request scope (a frame, which a ticket
 * opens) asSystem changes nothing.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { asSystem, withViewer } from '@mantle/db';
import { memberMayWriteAppData, recordAppAccess, recordAppError } from '@mantle/content';
import { appDbExec, appDbQuery } from '@mantle/content/app-broker';
import { scheduleAppTableExportSync } from '@mantle/content/app-table-exports';
import {
  appToolLevel,
  appToolScope,
  appToolVerdict,
  dispatchTool,
  outsideCallLogDetail,
} from '@mantle/tools';
import {
  buildAppFrameTicket,
  memberLoginActive,
  type AppFrameTicket,
  type MemberCaller,
} from '@/lib/auth';
import {
  AppDbBody,
  appDbBodyError,
  appDbErrorResponse,
  readOnlyAppResponse,
} from '@/lib/app-db-broker-body';
import { renderAppFrame } from '@/lib/app-frame';
import { memberAppOr404, memberName } from '@/lib/member-apps';
import { readJsonCapped } from '@/lib/body-limit';
import { rateLimit } from '@/lib/rate-limit';

function tooMany(retryAfterSec: number): NextResponse {
  return NextResponse.json(
    { ok: false, error: 'too many requests' },
    { status: 429, headers: { 'retry-after': String(retryAfterSec) } },
  );
}

/**
 * The seconds-lived frame ticket for a member's run (POST frame-ticket). It
 * names the login (`mem`), so the frame serves the published build and
 * re-checks the login; the owner frame's draft path refuses it.
 */
export async function memberFrameTicket(member: MemberCaller, id: string): Promise<Response> {
  // One ticket per frame load; a burst beyond this is a token-mint loop.
  const gate = rateLimit(`member-frame-ticket:${member.loginId}`, { max: 30, windowMs: 60_000 });
  if (!gate.ok) return tooMany(gate.retryAfterSec);
  const app = await memberAppOr404(member.anchorId, id, member.loginId);
  if (app instanceof Response) return app;
  recordAppAccess({
    ownerId: app.ownerId,
    appNodeId: app.id,
    actorId: member.loginId,
    kind: 'auth',
    detail: { via: 'member' },
  });
  return NextResponse.json({
    ticket: buildAppFrameTicket({
      ownerId: member.anchorId,
      appId: app.id,
      loginId: member.loginId,
    }),
  });
}

/**
 * Whether a frame ticket is a member's (a login ticket, not a client's, a
 * share's or an admin's test run) for this app.
 */
export function isMemberFrameTicket(ticket: AppFrameTicket | null, id: string): boolean {
  return (
    !!ticket?.loginId &&
    ticket.clientEpoch === undefined &&
    !ticket.shareId &&
    !ticket.reviewTest &&
    ticket.appId === id.toLowerCase()
  );
}

/**
 * The frame document of a member's run (GET frame with a member ticket):
 * the login must still be an active member and the app still one it may
 * run. PUBLISHED build only, never the draft.
 */
export async function memberFrame(
  req: Request,
  id: string,
  ticket: AppFrameTicket,
): Promise<Response> {
  // Liveness: the ticket proves who the member WAS at mint time.
  if (!ticket.loginId || !(await memberLoginActive(ticket.loginId))) {
    return new NextResponse('member session required', { status: 401 });
  }
  const app = await memberAppOr404(ticket.ownerId, id, ticket.loginId);
  if (app instanceof Response) return new NextResponse('not found', { status: 404 });
  return renderAppFrame(req, app.publishedBuild, {
    viewer: {
      ownerId: app.ownerId,
      appId: app.id,
      subject: { kind: 'member', loginId: ticket.loginId },
    },
  });
}

/**
 * host.db.query / host.db.exec of a member's run, on the app's own SQLite.
 * App identity: the member fills the reserved `:host_me_*` parameters (kind
 * 'member', the login's display name, a per-app id); a value the browser
 * sends for one is refused.
 */
export async function memberDbBroker(
  req: Request,
  member: MemberCaller,
  id: string,
): Promise<Response> {
  // Generous (a running app is query-chatty) but bounded.
  const gate = rateLimit(`member-db-broker:${member.loginId}`, { max: 300, windowMs: 60_000 });
  if (!gate.ok) return tooMany(gate.retryAfterSec);
  const parsed = AppDbBody.safeParse((await readJsonCapped(req)) ?? {});
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: appDbBodyError(parsed.error) }, { status: 400 });
  }
  const app = await memberAppOr404(member.anchorId, id, member.loginId);
  if (app instanceof Response) return app;

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
    const output: unknown =
      op === 'query'
        ? await asSystem(
            () => appDbQuery(app.ownerId, app.id, sql, params, app.manifest.sqlite, caller),
            'app-data',
          )
        : await asSystem(
            () => appDbExec(app.ownerId, app.id, sql, params, app.manifest.sqlite, caller),
            'app-data',
          );
    // A write may feed a linked app-table export: debounced, hash-gated, and
    // run for the brain (the sync is not a member act).
    if (op === 'exec') {
      await asSystem(async () => scheduleAppTableExportSync(member.anchorId, app.id), 'app-data');
    }
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

const ToolBody = z.object({
  slug: z.string().min(1).max(120),
  input: z.record(z.string(), z.unknown()).optional().default({}),
});

/**
 * host.tools.call() of a member's run, checked at dispatch time, every call,
 * by the team rules (see the top of this file). Refused calls are logged.
 */
export async function memberToolBroker(
  req: Request,
  member: MemberCaller,
  id: string,
): Promise<Response> {
  const gate = rateLimit(`member-tool-broker:${member.loginId}`, { max: 60, windowMs: 60_000 });
  if (!gate.ok) return tooMany(gate.retryAfterSec);
  const parsed = ToolBody.safeParse((await readJsonCapped(req)) ?? {});
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'invalid input' }, { status: 400 });
  }
  const app = await memberAppOr404(member.anchorId, id, member.loginId);
  if (app instanceof Response) return app;

  const { slug, input } = parsed.data;
  // An app a member runs is held by a workspace of theirs, so it runs the
  // team rules (R2) whatever its author ceiling.
  const level = appToolLevel('team', 'team', 'admin');
  // The member's login: a connector tool also needs the login's workspace
  // rule; every workspace that holds the app must hold the connector (R2).
  const verdict = await asSystem(
    () =>
      appToolVerdict(level, member.anchorId, app.manifest.toolSlugs ?? [], slug, member.loginId, {
        appId: app.id,
      }),
    'app-data',
  );
  recordAppAccess({
    ownerId: app.ownerId,
    appNodeId: app.id,
    actorId: member.loginId,
    kind: 'tool',
    // An outside tool names its kind, so the log shows which member calls
    // reached outside the brain; a write keeps its input too.
    detail: verdict.ok
      ? { via: 'member', slug, ...outsideCallLogDetail(verdict, input) }
      : { via: 'member', slug, refused: verdict.reason },
  });
  const logError = (message: string, status: number) =>
    recordAppError({
      ownerId: app.ownerId,
      appNodeId: app.id,
      actorId: member.loginId,
      source: 'tool',
      via: 'member',
      slug,
      message,
      status,
    });
  if (!verdict.ok) {
    logError(verdict.reason, verdict.status);
    return NextResponse.json({ ok: false, error: verdict.reason }, { status: verdict.status });
  }
  // The run reads through the app (its holders met with the member's
  // workspaces), never the member's other workspaces (plan R2, H1).
  const scope = appToolScope(level, { loginId: member.loginId, name: memberName(member) }, {
    id: app.id,
  });
  const result = await asSystem(
    () =>
      withViewer(scope.viewer, scope.actsFor, () =>
        dispatchTool(verdict.tool, input, { ownerId: member.anchorId, surface: scope.surface }),
      ),
    'app-data',
  );
  if (!result.ok) logError(result.error, 200);
  return NextResponse.json(result);
}
