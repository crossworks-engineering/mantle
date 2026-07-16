/**
 * Email builtin — lets an agent SEND mail from the user's own mailbox via SMTP
 * submission (the provider relays it; we never run our own MTA). The send-enable
 * config lives on `email_accounts` (smtp_host/port/secure); the password is the
 * same app-password already sealed for IMAP. See docs/email-send.md.
 *
 * Gate: requiresConfirm is FALSE (operator choice) — flip it per-row at
 * /settings/tools if injected-send ever becomes a concern.
 */

import { and, desc, eq, gte, or } from 'drizzle-orm';
import { db, emailAccounts, emails, type EmailAccount } from '@mantle/db';
import { accountCanSend, sendEmail, type EmailAttachment } from '@mantle/email';
import {
  getPage,
  docToText,
  renderPageEmail,
  cidForPageImage,
  createShare,
  shareUrlForToken,
  contactEmails,
  findContactsByEmails,
  recordContactSent,
  normalizeEmail,
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
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length <= 1 ? (parts[0] ?? raw) : parts;
}

/** Flatten one or more comma-separated recipient strings into a clean list. */
function flatRecipients(...raws: (string | undefined)[]): string[] {
  const out: string[] = [];
  for (const raw of raws) {
    if (!raw) continue;
    for (const p of raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean))
      out.push(p);
  }
  return out;
}

/** Recipients NOT permitted by the allowlist. The allowlist is the user's own
 *  account addresses plus their `contact` nodes. Fail CLOSED: with no contacts
 *  yet, an agent can still email the user themselves but not arbitrary outside
 *  addresses — so a prompt-injected agent on a fresh install can't exfiltrate
 *  by emailing a stranger. Add a contact to permit sending to them. */
async function blockedRecipients(ownerId: string, addrs: string[]): Promise<string[]> {
  // Concrete contact addresses only — `contactEmails` excludes `@domain`
  // wildcards by design. Domains are an INBOUND-only notion ("trust mail FROM
  // this domain"); you can't send to a whole domain. The inbound ContactGate
  // (@mantle/content) is the side that honours domains.
  const contacts = await contactEmails(ownerId); // already lower-cased + deduped
  const accounts = await db
    .select({ address: emailAccounts.address })
    .from(emailAccounts)
    .where(eq(emailAccounts.userId, ownerId));
  const allowed = new Set<string>([...contacts, ...accounts.map((a) => a.address.toLowerCase())]);
  return addrs.filter((a) => !allowed.has(normalizeEmail(a)));
}

/** Shared allowlist guard for the send tools. Returns an error result to bail
 *  with, or null when every recipient is permitted. */
async function allowlistError(
  ownerId: string,
  ...raws: (string | undefined)[]
): Promise<{ ok: false; error: string } | null> {
  const blocked = await blockedRecipients(ownerId, flatRecipients(...raws));
  if (blocked.length === 0) return null;
  return {
    ok: false,
    error:
      `these recipients aren't in the user's contact list: ${blocked.join(', ')}. ` +
      `Ask the user to confirm and add them as contacts at /contacts (they will then be reachable).`,
  };
}

/** Look up each recipient against the contact list and bump that contact's
 *  outbound counter + last-contacted timestamp for the given method. Best
 *  effort: per-contact errors are logged, not surfaced — a stats-tracking
 *  miss must never make a successful send look failed to the caller. */
async function noteContactActivity(
  ownerId: string,
  method: 'email',
  raws: (string | undefined)[],
): Promise<void> {
  const addrs = flatRecipients(...raws)
    .map(normalizeEmail)
    .filter(Boolean);
  if (addrs.length === 0) return;
  try {
    const idsByEmail = await findContactsByEmails(ownerId, addrs);
    if (idsByEmail.size === 0) return;
    await Promise.all(
      [...idsByEmail.values()].map((id) =>
        recordContactSent(ownerId, id, method).catch((err) =>
          console.error('[email_send] recordContactSent failed', { id, err }),
        ),
      ),
    );
  } catch (err) {
    console.error('[email_send] noteContactActivity lookup failed', err);
  }
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
  // Outward-facing under the user's real address — gated like telegram_send.
  // Operators who trust the flow clear it per-tool in Settings → Tools (the
  // seed never re-asserts the flag on existing rows).
  requiresConfirm: true,
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'recipient email (comma-separate for multiple)' },
      subject: {
        type: 'string',
        description: 'subject line, e.g. "Quote request: aluminium profiles"',
      },
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
    const gate = await allowlistError(ctx.ownerId, to, cc, bcc);
    if (gate) return gate;
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
      // Bump per-contact stats (count + last_contacted_at) for any recipients
      // that resolved to a contact. Best-effort; can't fail the send.
      await noteContactActivity(ctx.ownerId, 'email', [to, cc, bcc]);
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
  // Outward-facing under the user's real address — same gate as email_send.
  requiresConfirm: true,
  preconditions: [
    { kind: 'node_exists', param: 'pageId', nodeType: 'page', lookup: 'page_list / search_nodes' },
  ],
  inputSchema: {
    type: 'object',
    properties: {
      pageId: {
        type: 'string',
        description: "The page's id (UUID) — from `page_list` / `search_nodes`.",
      },
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

    const gate = await allowlistError(ctx.ownerId, to, strOpt(input.cc), strOpt(input.bcc));
    if (gate) return gate;

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
      ctx.step?.setMeta({
        from: account.address,
        to,
        subject,
        page_id: pageId,
        message_id: res.messageId,
      });
      ctx.step?.setOutput({
        messageId: res.messageId,
        accepted: res.accepted,
        rejected: res.rejected,
        images: attachments.length,
        shareUrl,
      });
      // Same per-contact stats bump as email_send — keeps the counts honest
      // regardless of which send-shaped tool delivered the message.
      await noteContactActivity(ctx.ownerId, 'email', [to, strOpt(input.cc), strOpt(input.bcc)]);
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

// ─── Read side: list + get ───────────────────────────────────────────────────

const email_list: BuiltinToolDef = {
  slug: 'email_list',
  name: 'List recent emails',
  description:
    'Recent emails newest-first (sorted by `internal_date` desc, NOT by ingest time). ' +
    "**Use this for any time-windowed email question** — 'what came in today / last 5 days', " +
    "'any new mail from X', 'this week's billing', 'anything urgent recently'. Pass `since` " +
    'for a window; `accountId` to filter to one mailbox. ' +
    "For topic/keyword searches across emails ('emails about the Lister contract') use " +
    "`search_nodes` with `type='email'` — that's similarity-ranked, not date-sorted, and won't " +
    "respect a time window. For a single email's full body/headers use `email_get`.",
  inputSchema: {
    type: 'object',
    properties: {
      accountId: { type: 'string', description: 'uuid of an email_accounts row to filter to' },
      since: {
        type: 'string',
        description:
          "ISO date or datetime (e.g. '2026-05-21' or '2026-05-21T00:00:00Z') — returns emails with internal_date ≥ this",
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 200,
        default: 50,
        description: 'Max results to return.',
      },
    },
  },
  handler: async (input, ctx) => {
    const accountId = strOpt(input.accountId);
    const since = strOpt(input.since);
    const limit =
      typeof input.limit === 'number' && Number.isFinite(input.limit)
        ? Math.min(Math.max(1, Math.floor(input.limit)), 200)
        : 50;

    const conds = [] as ReturnType<typeof eq>[];
    if (accountId) conds.push(eq(emails.accountId, accountId));
    if (since) {
      const d = new Date(since);
      if (!Number.isNaN(d.getTime())) conds.push(gte(emails.internalDate, d));
    }
    try {
      const rows = await db
        .select({
          id: emails.id,
          nodeId: emails.nodeId,
          accountId: emails.accountId,
          from: emails.fromAddr,
          fromName: emails.fromName,
          to: emails.toAddrs,
          subject: emails.subject,
          snippet: emails.snippet,
          internalDate: emails.internalDate,
          folder: emails.folder,
          isRead: emails.isRead,
          isStarred: emails.isStarred,
          hasAttachments: emails.hasAttachments,
        })
        .from(emails)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(emails.internalDate))
        .limit(limit);
      ctx.step?.setOutput({ count: rows.length });
      return { ok: true, output: rows };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

/** Crude HTML→text for the body_html FALLBACK path only (body_text absent).
 *  Drops style/script subtrees, turns breaks/blocks into newlines, strips the
 *  rest of the tags, and decodes the handful of entities that matter in mail.
 *  Not a sanitizer — output goes to an LLM as plain text, never to a browser.
 *  Exported for unit tests only. */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

const email_get: BuiltinToolDef = {
  slug: 'email_get',
  name: 'Get one email by id',
  description:
    'Fetch a single email by id — headers (from/to/cc, subject, date, folder, flags) plus the ' +
    'plain-text body. HTML-only emails are converted to text; raw markup is never returned. ' +
    'Use after `email_list` or `search_nodes` returns the id you want to read in full. ' +
    'For a date-windowed list of recent emails use `email_list`; for searching emails by topic/content ' +
    "use `search_nodes` with `type='email'`.",
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description:
          "the email's id — accepts EITHER the email-row id (from `email_list`) OR the node id " +
          "(from `search_nodes` with type='email'). Both forms resolve to the same email.",
      },
    },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    try {
      // Explicit columns — the full row carries body_html, which for a typical
      // newsletter/marketing mail is ~50 KB of markup wrapping a few hundred
      // chars of text. Shipping it blew past the inline tool-result cap, forced
      // a spill, and sent the model paging through HTML soup (2026-06-11 turn
      // that 500'd on an empty reply). body_text is canonical (it's what the
      // extractor indexes); HTML is only a fallback source, converted to text.
      //
      // Match on EITHER the email-row id OR the node id: `email_list` hands the
      // model `id` (the row PK) but `search_nodes` (the topic-search path this
      // tool's own description points at) hands it `nodeId`. Accepting both
      // closes the gap where a search → open → reply flow died on "not found"
      // because the model passed the node id it had just been given.
      const [row] = await db
        .select({
          id: emails.id,
          nodeId: emails.nodeId,
          accountId: emails.accountId,
          from: emails.fromAddr,
          fromName: emails.fromName,
          to: emails.toAddrs,
          cc: emails.ccAddrs,
          subject: emails.subject,
          bodyText: emails.bodyText,
          bodyHtml: emails.bodyHtml,
          internalDate: emails.internalDate,
          labels: emails.labels,
          folder: emails.folder,
          isRead: emails.isRead,
          isStarred: emails.isStarred,
          hasAttachments: emails.hasAttachments,
          deliveryKind: emails.deliveryKind,
        })
        .from(emails)
        .where(or(eq(emails.id, id), eq(emails.nodeId, id)))
        .limit(1);
      if (!row) return { ok: false, error: `email '${id}' not found` };
      const text = row.bodyText?.trim();
      const body = text || (row.bodyHtml ? htmlToPlainText(row.bodyHtml) : '');
      const { bodyText: _t, bodyHtml: _h, ...head } = row;
      ctx.step?.setOutput({ id: row.id, subject: row.subject });
      return {
        ok: true,
        output: {
          ...head,
          body,
          ...(text ? {} : { body_source: row.bodyHtml ? 'html_converted' : 'empty' }),
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const EMAIL_TOOLS: BuiltinToolDef[] = [email_send, email_page, email_list, email_get];
