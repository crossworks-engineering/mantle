import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { deleteContact, getContact, updateContact } from '@/lib/contacts';
import { enqueueBackfills } from '@mantle/email';

const PatchBody = z.object({
  first_name: z.string().max(200).optional(),
  last_name: z.string().max(200).optional(),
  company: z.string().max(200).optional(),
  emails: z.array(z.string().max(200)).max(50).optional(),
  /** @deprecated single-email shorthand; prefer `emails`. */
  email: z.string().max(200).optional(),
  country_code: z.string().max(8).optional(),
  cell: z.string().max(32).optional(),
  description: z.string().max(4000).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
});

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const row = await getContact(user.id, id);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ contact: row });
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
  try {
    const result = await updateContact(user.id, id, {
      firstName: parsed.data.first_name,
      lastName: parsed.data.last_name,
      company: parsed.data.company,
      emails: parsed.data.emails,
      email: parsed.data.email,
      countryCode: parsed.data.country_code,
      cell: parsed.data.cell,
      description: parsed.data.description,
      tags: parsed.data.tags,
    });
    if (!result) return NextResponse.json({ error: 'not found' }, { status: 404 });
    await enqueueBackfills(user.id, result.addedEmails);
    return NextResponse.json({ contact: result.contact });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'update failed' },
      { status: 400 },
    );
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const ok = await deleteContact(user.id, id);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
