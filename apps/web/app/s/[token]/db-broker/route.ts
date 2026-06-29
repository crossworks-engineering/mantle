/**
 * POST /s/[token]/db-broker — a SHARED app's host.db.query(), brokered for an
 * unauthenticated viewer. READ-ONLY: only `query` is allowed; `exec` (writes)
 * are rejected so a public link can't mutate the owner's app database. Runs
 * against the app's own SQLite under the share owner's scope.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveActiveShareByToken } from '@/lib/shares';
import { getApp } from '@mantle/content';
import { appDbQuery } from '@mantle/content/app-broker';

export const runtime = 'nodejs';

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
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ ok: false, error: 'invalid input' }, { status: 400 });

  if (parsed.data.op !== 'query') {
    return NextResponse.json(
      { ok: false, error: 'Shared apps are read-only — database writes are disabled on public links.' },
      { status: 403 },
    );
  }

  const app = await getApp(share.ownerId, share.nodeId);
  if (!app || !app.publishedBuild?.ok) {
    return NextResponse.json({ ok: false, error: 'app not found' }, { status: 404 });
  }

  try {
    const rows = await appDbQuery(share.ownerId, share.nodeId, parsed.data.sql, parsed.data.params, app.manifest.sqlite);
    return NextResponse.json({ ok: true, output: rows });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
