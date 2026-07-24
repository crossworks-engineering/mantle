import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { deleteFolder, folderById, renameFolderById, updateFolderDescription } from '@/lib/files';

const IdParams = z.object({ id: z.string().uuid() });
const PatchBody = z.union([
  z.object({ description: z.string().max(2000) }),
  z.object({ rename: z.string().min(1).max(64) }),
]);

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }
  const folder = await folderById({ ownerId: user.id, folderId: idParsed.data.id });
  if (!folder) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ folder });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }
  const raw = await req.json().catch(() => ({}));
  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  try {
    if ('rename' in parsed.data) {
      const folder = await renameFolderById({
        ownerId: user.id,
        folderId: idParsed.data.id,
        newSlug: parsed.data.rename,
      });
      if (!folder) return NextResponse.json({ error: 'not found' }, { status: 404 });
      return NextResponse.json({ folder });
    }
    const folder = await updateFolderDescription({
      ownerId: user.id,
      folderId: idParsed.data.id,
      description: parsed.data.description,
    });
    if (!folder) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json({ folder });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'rename failed' },
      { status: 400 },
    );
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }
  const res = await deleteFolder({ ownerId: user.id, folderId: idParsed.data.id });
  if (!res.ok) {
    return NextResponse.json({ error: res.reason }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
