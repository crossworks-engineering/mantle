/**
 * POST /s/[token]/db-broker — a SHARED app's host.db calls, brokered for an
 * anonymous visitor: `query` only; `exec` (writes) is rejected so a link
 * can't mutate the owner's app database. (Team links, whose members could
 * write, are retired: a member runs the app from their own login,
 * /api/member/apps/:id/db-broker.)
 *
 * Runs against the app's own SQLite under the share owner's scope.
 */
import { NextResponse } from '@/server/http-compat';
import { resolveActiveShareByToken } from '@/lib/shares';
import { getApp, recordAppAccess } from '@mantle/content';
import { appDbQuery } from '@mantle/content/app-broker';
import { rateLimit, clientIp } from '@/lib/rate-limit';

import { AppDbBody, appDbBodyError, appDbErrorResponse } from '@/lib/app-db-broker-body';

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;

  // Generous — a running app is query-chatty — but bounded, like the other
  // /s/[token] surfaces: this endpoint executes SQL for strangers.
  const { ok, retryAfterSec } = rateLimit(`share-db-broker:${clientIp(req)}`, {
    max: 300,
    windowMs: 60_000,
  });
  if (!ok) {
    return NextResponse.json(
      { ok: false, error: 'too many requests' },
      { status: 429, headers: { 'retry-after': String(retryAfterSec) } },
    );
  }

  const share = await resolveActiveShareByToken(token);
  if (!share || share.nodeType !== 'app') {
    return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  }

  const parsed = AppDbBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success)
    return NextResponse.json({ ok: false, error: appDbBodyError(parsed.error) }, { status: 400 });

  if (parsed.data.op === 'exec') {
    return NextResponse.json(
      {
        ok: false,
        error: 'Shared apps are read-only — database writes are disabled on public links.',
      },
      { status: 403 },
    );
  }

  const app = await getApp(share.ownerId, share.nodeId);
  if (!app || !app.publishedBuild?.ok) {
    return NextResponse.json({ ok: false, error: 'app not found' }, { status: 404 });
  }

  recordAppAccess({
    ownerId: share.ownerId,
    appNodeId: share.nodeId,
    shareId: share.id,
    kind: 'db',
    detail: { op: parsed.data.op },
  });

  try {
    const output = await appDbQuery(
      share.ownerId,
      share.nodeId,
      parsed.data.sql,
      parsed.data.params,
      app.manifest.sqlite,
      // One statement at a time per link (client tier audit I1).
      { callerKey: `share:${share.id}` },
    );
    return NextResponse.json({ ok: true, output });
  } catch (err) {
    return appDbErrorResponse(err, 'share-db-broker');
  }
}
