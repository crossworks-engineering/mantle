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
 *  - its data: the app's own SQLite. The login writes it when it may edit
 *    the app (a Moderator of its home, or a workspace of its holds the app
 *    with Write on) and the app is not informational
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
import { asSystem } from '@mantle/db';
import { memberMayWriteAppData, recordAppAccess } from '@mantle/content';
import { appDbQuery } from '@mantle/content/app-broker';
import { appDbWrite } from '@mantle/content/app-db-write';
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
import { runAppToolBroker } from '@/lib/app-tool-broker';
import { memberAppOr404, memberName } from '@/lib/member-apps';
import { JSON_BODY_CEILING_BYTES } from '@/lib/body-limit';
import { readJson } from '@/lib/read-body';

/**
 * This file's one system door (arch A6): a member's app run reaches its app's
 * database, and the tool broker's verdict reads the tool registry, on the system
 * pool by the named reason 'app-data'. Every call below goes through it, and
 * the Admin branch of the owner db broker's (F4 fix round 2: an Admin user's
 * run, in its scope since F4, after the app's lookup there; its data writes
 * follow ADMIN_DATA_ACCESS, the registry, schema and salt are the app's
 * bookkeeping, as for a member's run).
 */
export function appDataSystem<T>(fn: () => Promise<T>): Promise<T> {
  return asSystem(fn, 'app-data');
}

/**
 * The seconds-lived frame ticket for a member's run (POST frame-ticket). It
 * names the login (`mem`), so the frame serves the published build and
 * re-checks the login; the owner frame's draft path refuses it.
 */
export async function memberFrameTicket(member: MemberCaller, id: string): Promise<Response> {
  // One ticket per frame load; a burst beyond this is a token-mint loop:
  // the gate took the row's limit (lib/route-limits.ts memberFrameTicket).
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
  // Generous (a running app is query-chatty) but bounded: the gate took
  // the row's limit (lib/route-limits.ts memberDbBroker).
  const parsed = AppDbBody.safeParse(
    (await readJson(req, { empty: null, maxBytes: JSON_BODY_CEILING_BYTES })) ?? {},
  );
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
        ? await appDataSystem(() =>
            appDbQuery(app.ownerId, app.id, sql, params, app.manifest.sqlite, caller),
          )
        : // The one write path: a write may feed a linked app-table export,
          // scheduled here for the brain too (the sync is not a member act).
          await appDataSystem(() =>
            appDbWrite(app.ownerId, app.id, sql, params, app.manifest.sqlite, caller),
          );
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

/**
 * host.tools.call() of a member's run: the one app tool broker
 * (lib/app-tool-broker.ts, A10 #9) at the team rules (see the top of this
 * file), checked at dispatch time, every call. Refused calls are logged.
 */
export async function memberToolBroker(
  req: Request,
  member: MemberCaller,
  id: string,
): Promise<Response> {
  // The gate took the row's limit (lib/route-limits.ts memberToolBroker).
  return runAppToolBroker(req, {
    via: 'member',
    ownerId: member.anchorId,
    runner: { loginId: member.loginId, name: memberName(member) },
    maxBytes: JSON_BODY_CEILING_BYTES,
    app: () => memberAppOr404(member.anchorId, id, member.loginId),
    // The verdict reads the tool registry, and the run enters the app's
    // scope from outside the login's: system bookkeeping, by the named door.
    system: (fn) => appDataSystem(fn),
  });
}
