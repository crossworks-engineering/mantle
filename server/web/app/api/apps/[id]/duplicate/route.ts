/**
 * POST /api/apps/[id]/duplicate — copy an app in this brain (apps first-class
 * plan, Phase 3): its code with the builds (a published app is live at once),
 * its draft, declared tools and schema, and its data unless `withData` is
 * false. Sharing, level, history and table exports stay with the original;
 * the copy starts admin-only in Unsorted. Owner only. 409 when the app's
 * database file is lost (copy with `withData: false` then).
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { duplicateApp } from '@mantle/content/app-package';
import { readBody } from '@/lib/read-body';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

/** The ids are uuids: any other names nothing, the params gateway's one
 *  404 before the handler (lib/route-params.ts). */
export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  POST: {
    class: 'content',
    makesItems: false,
    item: { param: 'id', need: 'read' },
  },
});

const Body = z.object({
  title: z.string().min(1).max(200).optional(),
  withData: z.boolean().optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  const body = await readBody(req, Body);
  // A lost database file (AppDbMissingError): 409, reason 'db-missing', by
  // the one table.
  const app = await duplicateApp(user.id, id, { ...body, actor: 'owner' });
  if (!app) return NextResponse.json({ error: 'app not found' }, { status: 404 });
  return NextResponse.json({ app }, { status: 201 });
}
