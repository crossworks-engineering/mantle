/**
 * PATCH /api/secrets/[id]  — update metadata and/or the sealed payload
 * DELETE /api/secrets/[id] — drop the node (cascades to `secrets` row)
 *
 * Reveal lives at /api/secrets/[id]/reveal so it audits separately.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { SECRET_KINDS, deleteSecret, getSecretMetadata, updateSecret } from '@/lib/secrets';

const FieldSchema = z.object({
  label: z.string().max(80),
  value: z.string().max(8000),
});

const PatchBody = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).optional(),
  kind: z.enum(SECRET_KINDS).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  note: z.string().max(50_000).optional(),
  fields: z.array(FieldSchema).max(32).optional(),
});

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const row = await getSecretMetadata(user.id, id);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ secret: row });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const raw = await req.json().catch(() => ({}));
  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  const row = await updateSecret(user.id, id, parsed.data);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ secret: row });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const ok = await deleteSecret(user.id, id);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
