/**
 * POST /s/[token]/db-broker — a SHARED app's host.db calls, brokered for a
 * link visitor. An open link is `query` only: `exec` (writes) is refused so
 * a link can't mutate the owner's app database. (Team links, whose members
 * could write, are retired: a member runs the app from their own login,
 * /api/member/apps/:id/db-broker.)
 *
 * A CONTACT share (migration 0214) runs behind the contact gate (401
 * without the contact's cookie). It writes only when the share has
 * `can_write` and names an app: the write schedules the app-table export
 * sync and stamps `app_databases.client_written_at`, so rows exported from
 * the app count as written from outside for the lowering guard
 * (docs/client-logins.md section 8). Anything else: 403 `read-only`.
 *
 * Runs against the app's own SQLite under the share owner's scope, one
 * statement at a time per share (caller key `share:<id>`).
 *
 * App identity: on a contact share the contact fills the reserved
 * `:host_me_*` parameters (kind 'contact', the contact's name, a per-app
 * id); on an open link they are the anonymous value (id and name NULL, kind
 * 'public'). A value the browser sends for one is refused.
 */
import { NextResponse } from '@/server/http-compat';
import { contactCodeRequired, gateShare } from '@/lib/contact-share-gate';
import { getAppRuntime, recordAppAccess, recordShareAccess } from '@mantle/content';
import { appDbExec, appDbQuery, markAppClientWritten } from '@mantle/content/app-broker';
import { scheduleAppTableExportSync } from '@mantle/content/app-table-exports';
import { clientIpKey, rateLimit } from '@/lib/rate-limit';

import { AppDbBody, appDbBodyError, appDbErrorResponse } from '@/lib/app-db-broker-body';
import { SHARE_BODY_CEILING_BYTES, readJsonCapped } from '@/lib/body-limit';

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;

  // Generous — a running app is query-chatty — but bounded, like the other
  // /s/[token] surfaces: this endpoint executes SQL for strangers.
  const { ok, retryAfterSec } = rateLimit(`share-db-broker:${clientIpKey(req)}`, {
    max: 300,
    windowMs: 60_000,
  });
  if (!ok) {
    return NextResponse.json(
      { ok: false, error: 'too many requests' },
      { status: 429, headers: { 'retry-after': String(retryAfterSec) } },
    );
  }

  const gate = await gateShare(req, token);
  if (gate.kind === 'code') return contactCodeRequired(gate.share);
  const share = gate.kind === 'ok' ? gate.share : null;
  if (!share || share.nodeType !== 'app') {
    return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  }
  const contactId = share.contactId ?? null;

  // Capped (apps audit S2): a chunked body declares no length for the gate
  // to refuse, so the read itself stops at the ceiling (413).
  const parsed = AppDbBody.safeParse(await readJsonCapped(req, SHARE_BODY_CEILING_BYTES));
  if (!parsed.success)
    return NextResponse.json({ ok: false, error: appDbBodyError(parsed.error) }, { status: 400 });
  const { op } = parsed.data;

  // Writes: only a contact share with "Can write", on an app.
  const mayWrite = !!contactId && share.canWrite === true && share.nodeType === 'app';
  if (op === 'exec' && !mayWrite) {
    if (contactId) {
      recordShareAccess({
        ownerId: share.ownerId,
        shareId: share.id,
        contactId,
        kind: 'refused',
        detail: { op, refused: 'read-only' },
      });
    }
    return NextResponse.json(
      {
        ok: false,
        reason: 'read-only',
        error: contactId
          ? 'This app is shared with you read only.'
          : 'Shared apps are read-only — database writes are disabled on public links.',
      },
      { status: 403 },
    );
  }

  const app = await getAppRuntime(share.ownerId, share.nodeId);
  if (!app || !app.publishedBuild?.ok) {
    return NextResponse.json({ ok: false, error: 'app not found' }, { status: 404 });
  }

  // The app's Activity tab names the contact (app_access_log.contact_id).
  recordAppAccess({
    ownerId: share.ownerId,
    appNodeId: share.nodeId,
    shareId: share.id,
    contactId,
    kind: 'db',
    detail: { op, ...(contactId ? { via: 'contact', contactId } : {}) },
  });
  if (contactId) {
    recordShareAccess({
      ownerId: share.ownerId,
      shareId: share.id,
      contactId,
      kind: op === 'exec' ? 'write' : 'query',
    });
  }

  // One statement at a time per link (client tier audit I1).
  const caller = {
    callerKey: `share:${share.id}`,
    viewer: contactId ? { kind: 'contact' as const, contactId } : { kind: 'public' as const },
    // Rows only (access matrix audit, M1): below admin a write changes rows,
    // never the schema, a trigger or a view; the schema is the author's
    // (app_db_schema_set). The same authorizer as the MCP app_data_write.
    dataOnly: true,
  };
  try {
    if (op === 'exec') {
      const output = await appDbExec(
        share.ownerId,
        share.nodeId,
        parsed.data.sql,
        parsed.data.params,
        app.manifest.sqlite,
        caller,
      );
      // Rows a contact wrote are written from outside: an export of them
      // must not be lowered as if the brain wrote them.
      await markAppClientWritten(share.ownerId, share.nodeId);
      scheduleAppTableExportSync(share.ownerId, share.nodeId);
      return NextResponse.json({ ok: true, output });
    }
    const output = await appDbQuery(
      share.ownerId,
      share.nodeId,
      parsed.data.sql,
      parsed.data.params,
      app.manifest.sqlite,
      caller,
    );
    return NextResponse.json({ ok: true, output });
  } catch (err) {
    return appDbErrorResponse(err, 'share-db-broker', {
      ownerId: share.ownerId,
      appNodeId: share.nodeId,
      shareId: share.id,
      contactId,
      via: contactId ? 'contact' : 'public',
      op,
      sql: parsed.data.sql,
    });
  }
}
