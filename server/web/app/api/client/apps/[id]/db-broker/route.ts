import { NextResponse } from '@/server/http-compat';
import { recordAppAccess } from '@mantle/content';
import { appDbExec, appDbQuery } from '@mantle/content/app-broker';
import { scheduleAppTableExportSync } from '@mantle/content/app-table-exports';
import { errorMessage } from '@mantle/std';
import { getClientOr401 } from '@/lib/auth';
import { AppDbBody, appDbBodyError } from '@/lib/app-db-broker-body';
import { clientAppOr404, readOnlyAppResponse } from '@/lib/client-apps';
import { readJsonCapped } from '@/lib/body-limit';
import { rateLimit } from '@/lib/rate-limit';

/**
 * POST /api/client/apps/:id/db-broker: a client's run of an app calls
 * host.db.query / host.db.exec on the app's own SQLite (client logins C6).
 * Row security does not reach SQLite, so the audience check is explicit
 * (clientAppOr404: client level exactly, published). A client-level app is a
 * shared workspace (Jason's rule, 2026-09-30): every client login and every
 * member who runs it reads and writes the same database, unless an admin
 * marked it informational (`dataReadOnly`), and then a write answers 403
 * `reason: 'read-only'`.
 *
 * The SQLite work runs on the admin pool: it writes the app's database
 * registry rows, which the client role cannot.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const client = await getClientOr401();
  if (client instanceof Response) return client;
  // Generous (a running app is query-chatty) but bounded.
  const gate = rateLimit(`client-db-broker:${client.loginId}`, { max: 300, windowMs: 60_000 });
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
  const app = await clientAppOr404(client.anchorId, id);
  if (app instanceof Response) return app;

  const { op, sql, params } = parsed.data;
  if (op === 'exec' && app.dataReadOnly) {
    recordAppAccess({
      ownerId: client.anchorId,
      appNodeId: app.id,
      actorId: client.loginId,
      kind: 'db',
      detail: { via: 'client', op, refused: 'read-only' },
    });
    return readOnlyAppResponse('This app is read-only.');
  }
  recordAppAccess({
    ownerId: client.anchorId,
    appNodeId: app.id,
    actorId: client.loginId,
    kind: 'db',
    detail: { via: 'client', op },
  });
  try {
    const output =
      op === 'query'
        ? await appDbQuery(client.anchorId, app.id, sql, params, app.manifest.sqlite)
        : await appDbExec(client.anchorId, app.id, sql, params, app.manifest.sqlite);
    // A write may feed a linked app-table export: debounced, hash-gated, and
    // run for the brain (the sync is not a client act). The exported table
    // stays admin level, and a staff turn that reads it is marked as having
    // read client-written text (namesClientSourced).
    if (op === 'exec') scheduleAppTableExportSync(client.anchorId, app.id);
    return NextResponse.json({ ok: true, output });
  } catch (err) {
    return NextResponse.json({ ok: false, error: errorMessage(err) }, { status: 400 });
  }
}
