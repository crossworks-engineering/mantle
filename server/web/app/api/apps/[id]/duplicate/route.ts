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
import { getOwnerOr401 } from '@/lib/auth';
import { firstIssue } from '@/lib/zod-issue';
import { AppDbMissingError } from '@mantle/content/app-broker';
import { duplicateApp } from '@mantle/content/app-package';

const Body = z.object({
  title: z.string().min(1).max(200).optional(),
  withData: z.boolean().optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success)
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  try {
    const app = await duplicateApp(user.id, id, { ...parsed.data, actor: 'owner' });
    if (!app) return NextResponse.json({ error: 'app not found' }, { status: 404 });
    return NextResponse.json({ app }, { status: 201 });
  } catch (err) {
    if (err instanceof AppDbMissingError) {
      return NextResponse.json({ error: err.message, reason: 'db-missing' }, { status: 409 });
    }
    throw err;
  }
}
