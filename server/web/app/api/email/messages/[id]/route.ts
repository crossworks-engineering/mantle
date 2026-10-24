import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import {
  getMessageWithAttachments,
  sanitizeEmailHtml,
  setReadStatus,
  setStarred,
} from '@mantle/email';
import type { MessageDetailDTO } from '@mantle/client-types';
import { ownerCaller } from '@/lib/auth';
import { readBody } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'connectors' },
  PATCH: {
    class: 'area',
    area: 'connectors',
    item: { none: 'manages the connectors area: the Admin step checks it' },
  },
});

/**
 * One owner-scoped message with its attachments. Mapped to the wire DTO: the raw
 * `bodyHtml` is sanitised here (so untrusted HTML never reaches the browser —
 * the client renders `bodyHtmlSafe` into a sandboxed iframe as a second layer)
 * and the row's server-only columns (account/node/provider ids, headers, labels)
 * are dropped. The `MessageDetailDTO` annotation makes a row↔wire drift a
 * compile error.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await params;
  const result = await getMessageWithAttachments(user.id, id);
  if (!result) return NextResponse.json({ error: 'Message not found.' }, { status: 404 });
  const { email, attachments } = result;
  const dto: MessageDetailDTO = {
    email: {
      id: email.id,
      subject: email.subject,
      fromAddr: email.fromAddr,
      fromName: email.fromName,
      toAddrs: email.toAddrs,
      ccAddrs: email.ccAddrs,
      internalDate: email.internalDate.toISOString(),
      folder: email.folder,
      isRead: email.isRead,
      isStarred: email.isStarred,
      bodyText: email.bodyText,
    },
    attachments: attachments.map((a) => ({
      id: a.id,
      filename: a.filename,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
    })),
    bodyHtmlSafe: email.bodyHtml ? sanitizeEmailHtml(email.bodyHtml) : null,
  };
  return NextResponse.json(dto);
}

const PatchBody = z
  .object({ read: z.boolean().optional(), starred: z.boolean().optional() })
  .refine((b) => b.read !== undefined || b.starred !== undefined, 'nothing to update');

/** Flip read / starred flags on one message (owner-scoped, idempotent). */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await params;
  const body = await readBody(req, PatchBody);
  if (body.read !== undefined) await setReadStatus(user.id, id, body.read);
  if (body.starred !== undefined) await setStarred(user.id, id, body.starred);
  return NextResponse.json({ ok: true });
}
