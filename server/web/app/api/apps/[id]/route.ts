/**
 * /api/apps/[id] — get (GET), update metadata (PATCH), delete (DELETE).
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { APP_ICON_MAX, APP_TINTS } from '@mantle/client-types/app-nav';
import { getOwnerOr401 } from '@/lib/auth';
import { getApp, updateAppMeta, deleteApp, notifyAppNavChanged } from '@mantle/content';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const app = await getApp(user.id, id);
  if (!app) return NextResponse.json({ error: 'app not found' }, { status: 404 });
  return NextResponse.json({ app });
}

const PatchBody = z.object({
  name: z.string().min(1).max(200).optional(),
  // Emoji or `lucide:<name>`; '' clears. Shape is projected on write.
  icon: z.string().max(APP_ICON_MAX).optional(),
  // A tint key, or null to clear back to the neutral tile.
  color: z.enum(APP_TINTS).nullable().optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
});

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid input' }, { status: 400 });
  }
  const { name, ...rest } = parsed.data;
  const app = await updateAppMeta(user.id, id, { ...(name ? { title: name } : {}), ...rest });
  if (!app) return NextResponse.json({ error: 'app not found' }, { status: 404 });
  // The sidebar tree shows name, icon and colour: refresh it everywhere.
  void notifyAppNavChanged(user.id);
  return NextResponse.json({ app });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const ok = await deleteApp(user.id, id);
  if (!ok) return NextResponse.json({ error: 'app not found' }, { status: 404 });
  void notifyAppNavChanged(user.id);
  return NextResponse.json({ ok: true });
}
