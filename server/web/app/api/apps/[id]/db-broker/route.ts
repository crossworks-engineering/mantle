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
 */
import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { getAppRuntime } from '@mantle/content';
import { appDbQuery, appDbExec } from '@mantle/content/app-broker';
import { scheduleAppTableExportSync } from '@mantle/content/app-table-exports';
import { AppDbBody, appDbBodyError, appDbErrorResponse } from '@/lib/app-db-broker-body';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const parsed = AppDbBody.safeParse(await req.json().catch(() => ({})));
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
    const res = await appDbExec(user.id, id, parsed.data.sql, parsed.data.params, schema, caller);
    // A write may feed a linked app-table export — debounced, hash-gated.
    scheduleAppTableExportSync(user.id, id);
    return NextResponse.json({ ok: true, output: res });
  } catch (err) {
    return appDbErrorResponse(err, 'apps/db-broker');
  }
}
