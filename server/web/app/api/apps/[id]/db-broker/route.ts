/**
 * /api/apps/[id]/db-broker — the host relays a running app's host.db.query /
 * host.db.exec here. Runs against the app's OWN SQLite database (one file per
 * app, resolved from the registry by the authenticated app id — no path input,
 * so an app structurally cannot reach another app's data). The app's declared
 * schema (manifest.sqlite) is applied lazily on first use.
 *
 * op:'query' runs on a READ-ONLY open (appDbQuery) — writes must go through
 * op:'exec'. Same semantics as the share broker, where public links depend on
 * query being unable to mutate.
 *
 * App identity: the admin login fills the reserved `:host_me_*` parameters
 * (kind 'admin'); a value the browser sends for one is refused.
 *
 * Every login since W7e: a member's run goes through lib/app-runner.ts (an
 * app its workspaces hold, its data written only with the grant's Write and
 * not informational, rows only). A client login is refused (403
 * client-login), never the admin path below.
 */
import { NextResponse } from '@/server/http-compat';
import { ownerCallerWithLogin } from '@/lib/auth';
import { memberDbBroker } from '@/lib/app-runner';
import { getAppRuntime } from '@mantle/content';
import { appDbQuery } from '@mantle/content/app-broker';
import { appDbWrite } from '@mantle/content/app-db-write';
import { AppDbBody, appDbBodyError, appDbErrorResponse } from '@/lib/app-db-broker-body';
import { readJson } from '@/lib/read-body';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const got = ownerCallerWithLogin();
  const { id } = await ctx.params;
  // A member's run (W7e): the app's holders decide, its data rules apply.
  if (got.kind === 'member') return memberDbBroker(req, got.member, id);
  const user = got.user;
  const parsed = AppDbBody.safeParse(await readJson(req));
  if (!parsed.success)
    return NextResponse.json({ ok: false, error: appDbBodyError(parsed.error) }, { status: 400 });

  const app = await getAppRuntime(user.id, id);
  if (!app) return NextResponse.json({ ok: false, error: 'app not found' }, { status: 404 });
  const schema = app.manifest.sqlite;
  // One statement at a time per login, like every other broker: an app
  // cannot hold every SQL process while other callers wait.
  const caller = {
    callerKey: `admin:${user.actor.id}`,
    viewer: { kind: 'admin' as const, loginId: user.actor.id, name: user.actor.displayName },
  };

  try {
    if (parsed.data.op === 'query') {
      const rows = await appDbQuery(
        user.id,
        id,
        parsed.data.sql,
        parsed.data.params,
        schema,
        caller,
      );
      return NextResponse.json({ ok: true, output: rows });
    }
    // The one write path: a write may feed a linked app-table export.
    const res = await appDbWrite(user.id, id, parsed.data.sql, parsed.data.params, schema, caller);
    return NextResponse.json({ ok: true, output: res });
  } catch (err) {
    return appDbErrorResponse(err, 'apps/db-broker', {
      ownerId: user.id,
      appNodeId: id,
      actorId: user.actor.id,
      via: 'owner',
      op: parsed.data.op,
      sql: parsed.data.sql,
    });
  }
}
