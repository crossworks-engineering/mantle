/**
 * Email builtin — lets an agent SEND mail from the user's own mailbox via SMTP
 * submission (the provider relays it; we never run our own MTA). The send-enable
 * config lives on `email_accounts` (smtp_host/port/secure); the password is the
 * same app-password already sealed for IMAP. See docs/email-send.md.
 *
 * Gate: requiresConfirm is FALSE (operator choice) — flip it per-row at
 * /settings/tools if injected-send ever becomes a concern.
 */

import { and, eq } from 'drizzle-orm';
import { db, emailAccounts, type EmailAccount } from '@mantle/db';
import { accountCanSend, sendEmail, type EmailAttachment } from '@mantle/email';
import {
  getPage,
  docToText,
  renderPageEmail,
  cidForPageImage,
  createShare,
  shareUrlForToken,
} from '@mantle/content';
import { readFileById } from '@mantle/files';
import type { BuiltinToolDef } from './types';

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function strOpt(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}
/** Split a comma-separated recipient string into one-or-many. */
function recipients(raw: string): string | string[] {
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length <= 1 ? (parts[0] ?? raw) : parts;
}

/** Pick the account to send from: an explicit `from` address if it matches one
 *  of the user's accounts, else the first enabled account with SMTP configured. */
async function resolveSendAccount(
  ownerId: string,
  fromAddr?: string,
): Promise<EmailAccount | null> {
  const rows = await db
    .select()
    .from(emailAccounts)
    .where(and(eq(emailAccounts.userId, ownerId), eq(emailAccounts.enabled, true)));
  if (fromAddr) {
    const match = rows.find((r) => r.address.toLowerCase() === fromAddr.toLowerCase());
    if (match) return accountCanSend(match) ? match : null;
  }
  return rows.find(accountCanSend) ?? null;
}

const email_send: BuiltinToolDef = {
  slug: 'email_send',
  name: 'Send an email',
  description:
    "Send an email FROM the user's own mailbox via their provider's SMTP. Provide `to`, `subject`, and a plain-text `body`. Optional `cc`/`bcc`, and `from` to choose which of the user's accounts sends it (defaults to the first send-enabled account). Use only when the user explicitly asks to send or email something. The message goes out under the user's real address, so write it accurately and professionally; when relaying research, include the source links in the body. If no account has SMTP configured the call fails with a clear message.",
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'recipient email (comma-separate for multiple)' },
      subject: { type: 'string' },
      body: { type: 'string', description: 'plain-text body' },
      cc: { type: 'string', description: 'optional cc (comma-separate for multiple)' },
      bcc: { type: 'string', description: 'optional bcc (comma-separate for multiple)' },
      from: {
        type: 'string',
        description: "optional: which of the user's account addresses to send from",
      },
    },
    required: ['to', 'subject', 'body'],
  },
  handler: async (input, ctx) => {
    const to = str(input.to).trim();
    const subject = str(input.subject).trim();
    const body = str(input.body);
    if (!to) return { ok: false, error: 'to is required' };
    if (!subject) return { ok: false, error: 'subject is required' };
    if (!body) return { ok: false, error: 'body is required' };

    const account = await resolveSendAccount(ctx.ownerId, strOpt(input.from));
    if (!account) {
      return {
        ok: false,
        error:
          'no send-enabled email account found — configure SMTP host/port on an account at /settings/accounts',
      };
    }

    const cc = strOpt(input.cc);
    const bcc = strOpt(input.bcc);
    try {
      const res = await sendEmail(account, {
        to: recipients(to),
        subject,
        text: body,
        ...(cc ? { cc: recipients(cc) } : {}),
        ...(bcc ? { bcc: recipients(bcc) } : {}),
      });
      ctx.step?.setMeta({ from: account.address, to, subject, message_id: res.messageId });
      ctx.step?.setOutput({
        messageId: res.messageId,
        accepted: res.accepted,
        rejected: res.rejected,
      });
      return {
        ok: true,
        output: {
          from: account.address,
          to,
          subject,
          messageId: res.messageId,
          accepted: res.accepted,
          rejected: res.rejected,
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const email_page: BuiltinToolDef = {
  slug: 'email_page',
  name: 'Email a page',
  description:
    "Send one of the user's pages as a richly-formatted HTML email — the page's headings, callouts, columns, tables, lists, highlights, and embedded images all render inline in the recipient's mail client (images are attached inline; a plain-text version is included as a fallback). Provide the page's `pageId` (from page_list) and the recipient `to`. `subject` defaults to the page title. Optional `cc`/`bcc`, `from` (which account sends), and `includeLink` to also mint a public read-only link and add a 'View online' footer. The mail goes out under the user's real address, so only use it when they ask to email or send a page. If no account has SMTP configured the call fails with a clear message.",
  inputSchema: {
    type: 'object',
    properties: {
      pageId: { type: 'string', description: 'page node id (from page_list / page_create)' },
      to: { type: 'string', description: 'recipient email (comma-separate for multiple)' },
      subject: { type: 'string', description: 'optional — defaults to the page title' },
      cc: { type: 'string', description: 'optional cc (comma-separate for multiple)' },
      bcc: { type: 'string', description: 'optional bcc (comma-separate for multiple)' },
      from: {
        type: 'string',
        description: "optional: which of the user's account addresses to send from",
      },
      includeLink: {
        type: 'boolean',
        description:
          "optional: also create a public read-only share link and add a 'View online' footer",
      },
    },
    required: ['pageId', 'to'],
  },
  handler: async (input, ctx) => {
    const pageId = str(input.pageId).trim();
    const to = str(input.to).trim();
    if (!pageId) return { ok: false, error: 'pageId is required' };
    if (!to) return { ok: false, error: 'to is required' };

    const page = await getPage(ctx.ownerId, pageId);
    if (!page) return { ok: false, error: `page ${pageId} not found` };

    const account = await resolveSendAccount(ctx.ownerId, strOpt(input.from));
    if (!account) {
      return {
        ok: false,
        error:
          'no send-enabled email account found — configure SMTP host/port on an account at /settings/accounts',
      };
    }

    const subject = strOpt(input.subject) ?? page.title;

    // Optionally mint a public link and surface it in the email footer + text.
    let shareUrl: string | undefined;
    if (input.includeLink === true) {
      try {
        const share = await createShare(ctx.ownerId, pageId);
        shareUrl = shareUrlForToken(share.token);
      } catch {
        // Non-fatal: send the page without the online link if sharing fails.
      }
    }
    const footerHtml = shareUrl
      ? `<a href="${shareUrl}" style="color:#2563eb;text-decoration:underline">View this page online &rarr;</a>`
      : undefined;

    const { html, imageFileIds } = renderPageEmail(page.doc, { title: page.title, footerHtml });

    // Inline the embedded images as cid attachments so they render even when
    // the client blocks remote images (and without exposing private files).
    const attachments: EmailAttachment[] = [];
    for (const fileId of imageFileIds) {
      const file = await readFileById({ ownerId: ctx.ownerId, fileId });
      if (!file) continue;
      attachments.push({
        cid: cidForPageImage(fileId),
        content: file.bytes,
        filename: file.row.filename,
        contentType: file.row.mimeType,
      });
    }

    const text = docToText(page.doc) + (shareUrl ? `\n\n— View online: ${shareUrl}` : '');
    const cc = strOpt(input.cc);
    const bcc = strOpt(input.bcc);
    try {
      const res = await sendEmail(account, {
        to: recipients(to),
        subject,
        html,
        text,
        ...(cc ? { cc: recipients(cc) } : {}),
        ...(bcc ? { bcc: recipients(bcc) } : {}),
        ...(attachments.length ? { attachments } : {}),
      });
      ctx.step?.setMeta({ from: account.address, to, subject, page_id: pageId, message_id: res.messageId });
      ctx.step?.setOutput({
        messageId: res.messageId,
        accepted: res.accepted,
        rejected: res.rejected,
        images: attachments.length,
        shareUrl,
      });
      return {
        ok: true,
        output: {
          from: account.address,
          to,
          subject,
          pageId,
          messageId: res.messageId,
          accepted: res.accepted,
          rejected: res.rejected,
          inlineImages: attachments.length,
          ...(shareUrl ? { shareUrl } : {}),
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const EMAIL_TOOLS: BuiltinToolDef[] = [email_send, email_page];
