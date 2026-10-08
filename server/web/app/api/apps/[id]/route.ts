/**
 * /api/apps/[id] — get (GET), update metadata (PATCH), delete (DELETE).
 * PATCH also sets the informational flag (`dataReadOnly`, client logins C6)
 * and MCP access (`mcpAccess`, team apps Phase 1).
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { APP_ICON_MAX, APP_TINTS } from '@mantle/client-types/app-nav';
import { getOwnerOr401 } from '@/lib/auth';
import { APP_DESCRIPTION_MAX } from '@/lib/app-meta';
import { getApp, updateAppMeta, deleteApp, notifyAppNavChanged } from '@mantle/content';
import { firstIssue } from '@/lib/zod-issue';

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
  // '' clears it.
  description: z.string().max(APP_DESCRIPTION_MAX).optional(),
  // Informational (client logins C6): members and clients only read the
  // app's data. This route (admin only) is its one writer.
  dataReadOnly: z.boolean().optional(),
  // MCP access (team apps Phase 1, 0234): a member's or client's MCP
  // connection reaches the app's data. This route (admin only) is its one
  // writer: no agent tool and no API key sets it (a key never reaches it).
  mcpAccess: z.boolean().optional(),
});

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
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
