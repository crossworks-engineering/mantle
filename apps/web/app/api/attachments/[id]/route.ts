import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db, emailAccounts, emailAttachments, emails } from '@mantle/db';
import { getSignedUrl } from '@mantle/storage';
import { requireOwner } from '@/lib/auth';

/**
 * Attachment download: looks up the attachment by id, verifies it belongs
 * to a user-owned email, mints a short-lived signed URL against Supabase
 * Storage, and redirects the browser there. The URL never embeds bucket
 * credentials and the lookup is owner-scoped — a stolen attachment id
 * can't be used by another logged-in user.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const { id } = await ctx.params;

  const [row] = await db
    .select({ storageKey: emailAttachments.storageKey })
    .from(emailAttachments)
    .innerJoin(emails, eq(emails.id, emailAttachments.emailId))
    .innerJoin(emailAccounts, eq(emails.accountId, emailAccounts.id))
    .where(and(eq(emailAttachments.id, id), eq(emailAccounts.userId, user.id)))
    .limit(1);

  if (!row) {
    return new NextResponse('not found', { status: 404 });
  }

  const url = await getSignedUrl(row.storageKey, 300);
  return NextResponse.redirect(url, { status: 302 });
}
