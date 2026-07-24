/**
 * POST /s/[token]/db-broker — a SHARED app's host.db calls, brokered for an
 * external viewer. Admission and capability follow the share's mode:
 *
 *   public — anonymous: `query` only; `exec` (writes) rejected so a link
 *            can't mutate the owner's app database.
 *   team   — an identified team member (live visitor cookie, membership
 *            re-checked per request): `query` AND `exec`, every statement
 *            stamped with their contactId in the app access log.
 *
 * Runs against the app's own SQLite under the share owner's scope.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { resolveActiveShareByToken } from '@/lib/shares';
import { getApp, recordAppAccess } from '@mantle/content';
import { appDbQuery, appDbExec } from '@mantle/content/app-broker';
import { resolveShareVisitorFromRequest } from '@/lib/team-gate';


const Body = z.object({
  op: z.enum(['query', 'exec']),
  sql: z.string().min(1).max(20_000),
  params: z.array(z.unknown()).max(100).optional().default([]),
});

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const share = await resolveActiveShareByToken(token);
  if (!share || share.nodeType !== 'app') {
    return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  }

  const visitor = await resolveShareVisitorFromRequest(req, share);
  if (!visitor) {
    return NextResponse.json(
      { ok: false, error: 'team session required — enter your team token to use this app' },
      { status: 401 },
    );
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success)
    return NextResponse.json({ ok: false, error: 'invalid input' }, { status: 400 });

  if (parsed.data.op === 'exec' && visitor.mode === 'public') {
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
    contactId: visitor.contactId,
    kind: 'db',
    detail: { op: parsed.data.op },
  });

  try {
    const output =
      parsed.data.op === 'query'
        ? await appDbQuery(
            share.ownerId,
            share.nodeId,
            parsed.data.sql,
            parsed.data.params,
            app.manifest.sqlite,
          )
        : await appDbExec(
            share.ownerId,
            share.nodeId,
            parsed.data.sql,
            parsed.data.params,
            app.manifest.sqlite,
          );
    return NextResponse.json({ ok: true, output });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
