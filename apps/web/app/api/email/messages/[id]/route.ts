import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getMessageWithAttachments, setReadStatus, setStarred } from '@mantle/email';
import { requireOwner } from '@/lib/auth';

/** One owner-scoped message with its attachments. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const { id } = await params;
  const result = await getMessageWithAttachments(user.id, id);
  if (!result) return NextResponse.json({ error: 'Message not found.' }, { status: 404 });
  return NextResponse.json(result);
}

const PatchBody = z
  .object({ read: z.boolean().optional(), starred: z.boolean().optional() })
  .refine((b) => b.read !== undefined || b.starred !== undefined, 'nothing to update');

/** Flip read / starred flags on one message (owner-scoped, idempotent). */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const { id } = await params;
  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  if (parsed.data.read !== undefined) await setReadStatus(user.id, id, parsed.data.read);
  if (parsed.data.starred !== undefined) await setStarred(user.id, id, parsed.data.starred);
  return NextResponse.json({ ok: true });
}
