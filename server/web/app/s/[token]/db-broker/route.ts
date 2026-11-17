/**
 * POST /s/[token]/db-broker: a SHARED app's host.db calls, brokered for a
 * link visitor. An open link is `query` only: `exec` and `batch` (writes) are
 * refused so a link can't mutate the owner's app database. (Team links, whose members
 * could write, are retired: a member runs the app from their own login,
 * /api/member/apps/:id/db-broker. Contact shares, which could write with
 * Can write, are gone since migration 0378.)
 *
 * Runs against the app's own SQLite under the share owner's scope, one
 * statement at a time per share (caller key `share:<id>`).
 *
 * App identity: the reserved `:host_me_*` parameters are the anonymous
 * value (id and name NULL, kind 'public'). A value the browser sends for
 * one is refused.
 */
import { NextResponse } from '@/server/http-compat';
import { openShareLink } from '@/lib/share-gate';
import { getAppRuntime, recordAppAccess } from '@mantle/content';
import { appDbQuery } from '@mantle/content/app-broker';

import {
  AppDbBody,
  appDbBodyError,
  appDbErrorResponse,
  appDbFailedSql,
} from '@/lib/app-db-broker-body';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'link',
    item: { none: 'a link route: its share token names what it opens' },
    limits: { rateLimit: ['shareDbBroker'] },
  },
});

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;

  // Generous (a running app is query-chatty) but bounded, like the other
  // /s/[token] surfaces: this endpoint executes SQL for strangers.
  // The gate took the row's per-address limit (lib/route-limits.ts shareDbBroker).

  const share = await openShareLink(token);
  if (!share || share.nodeType !== 'app') {
    return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  }

  // Capped: a chunked body declares no length for the gate
  // to refuse, so the read itself stops at the ceiling (413).
  const parsed = AppDbBody.safeParse(await readJson(req, { empty: null }));
  if (!parsed.success)
    return NextResponse.json({ ok: false, error: appDbBodyError(parsed.error) }, { status: 400 });
  const body = parsed.data;
  const { op } = body;

  // An open link only reads.
  if (body.op !== 'query') {
    return NextResponse.json(
      {
        ok: false,
        reason: 'read-only',
        error: 'Shared apps are read-only: database writes are disabled on public links.',
      },
      { status: 403 },
    );
  }

  const app = await getAppRuntime(share.ownerId, share.nodeId);
  if (!app || !app.publishedBuild?.ok) {
    return NextResponse.json({ ok: false, error: 'app not found' }, { status: 404 });
  }

  recordAppAccess({
    ownerId: share.ownerId,
    appNodeId: share.nodeId,
    shareId: share.id,
    contactId: null,
    kind: 'db',
    detail: { op },
  });

  // One statement at a time per link.
  const caller = {
    callerKey: `share:${share.id}`,
    viewer: { kind: 'public' as const },
    // Rows only, as the MCP app_data_write (the link reads, so this only
    // keeps the authorizer the same everywhere).
    dataOnly: true,
  };
  try {
    const output = await appDbQuery(
      share.ownerId,
      share.nodeId,
      body.sql,
      body.params,
      app.manifest.sqlite,
      caller,
    );
    return NextResponse.json({ ok: true, output });
  } catch (err) {
    return appDbErrorResponse(err, 'share-db-broker', {
      ownerId: share.ownerId,
      appNodeId: share.nodeId,
      shareId: share.id,
      contactId: null,
      via: 'public',
      op,
      sql: appDbFailedSql(body, err),
    });
  }
}
