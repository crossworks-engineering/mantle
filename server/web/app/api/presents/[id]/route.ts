import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { cappedOne } from '@/lib/list-workspaces';
import { ownerCaller } from '@/lib/auth';
import {
  compileCanvasCss,
  deletePresent,
  getPresent,
  savePresentSource,
  updatePresent,
} from '@/lib/presents';
import { firstIssue } from '@/lib/zod-issue';
import { readJson } from '@/lib/read-body';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

/** The [id] is a uuid: any other names nothing (lib/route-params.ts). */
export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  GET: { class: 'content', open: 'owner' },
  PATCH: {
    class: 'content',
    open: 'owner',
    item: { param: 'id', need: 'edit' },
  },
  DELETE: {
    class: 'content',
    open: 'owner',
    item: { param: 'id', need: 'manage' },
  },
});

/**
 * Metadata (title, tags, icon), and the canvas itself (`source`): live at
 * once, no draft (latest is latest). `ifRev` guards the source against a
 * second writer: a stale rev answers 409 with the current one.
 */
const PatchBody = z.object({
  title: z.string().min(1).max(200).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  icon: z.string().max(16).optional(),
  source: z.string().max(1_100_000).optional(),
  ifRev: z.number().int().positive().optional(),
});

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  const row = await getPresent(user.id, id);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ present: await cappedOne(row) });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  const parsed = PatchBody.safeParse(await readJson(req));
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  const { source, ifRev, ...meta } = parsed.data;
  if (source !== undefined) {
    // Compiled from the source as stored, after the right and the save's
    // checks (savePresentSource calls it then).
    const saved = await savePresentSource(user.id, id, {
      source,
      css: compileCanvasCss,
      ...(ifRev !== undefined ? { ifRev } : {}),
    });
    if (!saved.ok) {
      return 'conflict' in saved
        ? NextResponse.json({ error: 'stale rev', rev: saved.rev }, { status: 409 })
        : NextResponse.json({ error: 'not found' }, { status: 404 });
    }
  }
  if (Object.keys(meta).length > 0) {
    const row = await updatePresent(user.id, id, meta);
    if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const row = await getPresent(user.id, id);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ present: row });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  const ok = await deletePresent(user.id, id);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
