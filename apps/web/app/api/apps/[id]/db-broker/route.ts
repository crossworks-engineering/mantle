/**
 * /api/apps/[id]/db-broker — the host relays a running app's host.db.query /
 * host.db.exec here. Runs against the app's OWN SQLite database (one file per
 * app, resolved from the registry by the authenticated app id — no path input,
 * so an app structurally cannot reach another app's data). The app's declared
 * schema (manifest.sqlite) is applied lazily on first use.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOwner } from '@/lib/auth';
import { getApp } from '@mantle/content';
import { appDbQuery, appDbExec } from '@mantle/content/app-broker';

export const runtime = 'nodejs';

const Body = z.object({
  op: z.enum(['query', 'exec']),
  sql: z.string().min(1).max(20_000),
  params: z.array(z.unknown()).max(100).optional().default([]),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ ok: false, error: 'invalid input' }, { status: 400 });

  const app = await getApp(user.id, id);
  if (!app) return NextResponse.json({ ok: false, error: 'app not found' }, { status: 404 });
  const schema = app.manifest.sqlite;

  try {
    if (parsed.data.op === 'query') {
      const rows = await appDbQuery(user.id, id, parsed.data.sql, parsed.data.params, schema);
      return NextResponse.json({ ok: true, output: rows });
    }
    const res = await appDbExec(user.id, id, parsed.data.sql, parsed.data.params, schema);
    return NextResponse.json({ ok: true, output: res });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
