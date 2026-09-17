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
 */
import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { getApp } from '@mantle/content';
import { appDbQuery, appDbExec } from '@mantle/content/app-broker';
import { scheduleAppTableExportSync } from '@mantle/content/app-table-exports';
import { AppDbBody, appDbBodyError } from '@/lib/app-db-broker-body';
import { errorMessage } from '@mantle/std';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const parsed = AppDbBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success)
    return NextResponse.json({ ok: false, error: appDbBodyError(parsed.error) }, { status: 400 });

  const app = await getApp(user.id, id);
  if (!app) return NextResponse.json({ ok: false, error: 'app not found' }, { status: 404 });
  const schema = app.manifest.sqlite;

  try {
    if (parsed.data.op === 'query') {
      const rows = await appDbQuery(user.id, id, parsed.data.sql, parsed.data.params, schema);
      return NextResponse.json({ ok: true, output: rows });
    }
    const res = await appDbExec(user.id, id, parsed.data.sql, parsed.data.params, schema);
    // A write may feed a linked app-table export — debounced, hash-gated.
    scheduleAppTableExportSync(user.id, id);
    return NextResponse.json({ ok: true, output: res });
  } catch (err) {
    return NextResponse.json({ ok: false, error: errorMessage(err) }, { status: 400 });
  }
}
