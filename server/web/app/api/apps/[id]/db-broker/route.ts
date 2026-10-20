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
 * An Admin user's run: the app found in its scope, then its SQLite work by
 * the 'app-data' door (lib/app-runner.ts, F4 fix round 2).
 *
 * Every login since W7e: a member's run goes through lib/app-runner.ts (an
 * app its workspaces hold, its data written only with the grant's Write and
 * not informational, rows only). A client login is refused (403
 * client-login), never the admin path below.
 */
import { NextResponse } from '@/server/http-compat';
import { ownerLoginCaller } from '@/lib/auth';
import { adminFacts } from '@/lib/auth/login';
import { appDataSystem, memberDbBroker } from '@/lib/app-runner';
import { getAppRuntime } from '@mantle/content';
import { appDbQuery } from '@mantle/content/app-broker';
import { appDbWrite } from '@mantle/content/app-db-write';
import { AppDbBody, appDbBodyError, appDbErrorResponse } from '@/lib/app-db-broker-body';
import { readJson } from '@/lib/read-body';
import type { RouteParams } from '@/lib/route-params';

/** The ids are uuids: any other names nothing, the params gateway's one
 *  404 before the handler (lib/route-params.ts; the item gate answered it
 *  until the pre-check removal part 2). */
export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const login = ownerLoginCaller();
  const { id } = await ctx.params;
  // A run by a login that is not an Admin user (adminFacts, asked of its
  // scope): the app's holders decide, its data rules apply.
  if (!(await adminFacts(login)).admin) return memberDbBroker(req, login, id);
  const user = { id: login.brainId, actor: login.actor };
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

  // The app was found in the Admin user's scope (getAppRuntime: the item
  // check, a read; the gate asked the same). Its SQLite work is the app's
  // bookkeeping on the system pool, by the 'app-data' door, as a member's
  // run's is (F4 fix round 2): an Admin user's data write is never refused
  // (ADMIN_DATA_ACCESS), and the write sequence, the lazy schema and the
  // per-app salt (app_databases) are the app's rows, not the caller's
  // edit. In its scope an Admin user who only reads the app was refused.
  const { sql: text, params } = parsed.data;
  try {
    if (parsed.data.op === 'query') {
      const rows = await appDataSystem(() => appDbQuery(user.id, id, text, params, schema, caller));
      return NextResponse.json({ ok: true, output: rows });
    }
    // The one write path: a write may feed a linked app-table export.
    const res = await appDataSystem(() => appDbWrite(user.id, id, text, params, schema, caller));
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
