import { NextResponse } from 'next/server';
import { Readable } from 'node:stream';
import { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { and, eq } from 'drizzle-orm';
import { db, emailAccounts, emailAttachments, emails } from '@mantle/db';
import { getContent } from '@mantle/storage';
import { getOwnerOr401 } from '@/lib/auth';
import { safeDownloadHeaders } from '@/lib/safe-download';

/**
 * Attachment download. Looks up the attachment by id, verifies it belongs to
 * a user-owned email, then streams the bytes back through Next. We proxy
 * (rather than redirect to a presigned URL) so the browser never needs to
 * reach the internal object store endpoint — important now that storage is
 * self-hosted MinIO on a docker-network address.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;

  const [row] = await db
    .select({
      storageKey: emailAttachments.storageKey,
      filename: emailAttachments.filename,
      mimeType: emailAttachments.mimeType,
    })
    .from(emailAttachments)
    .innerJoin(emails, eq(emails.id, emailAttachments.emailId))
    .innerJoin(emailAccounts, eq(emails.accountId, emailAccounts.id))
    .where(and(eq(emailAttachments.id, id), eq(emailAccounts.userId, user.id)))
    .limit(1);

  if (!row) {
    return new NextResponse('not found', { status: 404 });
  }

  const { body, contentType, contentLength } = await getContent(row.storageKey);

  const headers = new Headers(safeDownloadHeaders(contentType ?? row.mimeType, row.filename));
  if (contentLength !== undefined) headers.set('content-length', String(contentLength));

  const webStream = Readable.toWeb(body) as unknown as NodeReadableStream<Uint8Array>;
  return new NextResponse(webStream as unknown as ReadableStream, { status: 200, headers });
}
