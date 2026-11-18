/**
 * Email builtins: read the stored mail (email_list, email_get). Sending left
 * the brain with the old mail sync (Sync plan, M4): it is rebuilt in the
 * Sync service, where the send policy (MANTLE_POLICY_EMAIL_SEND) gates it
 * again (docs/services.md, "Sync").
 */

import { and, desc, eq, gte, inArray, or, sql } from 'drizzle-orm';
import { db, emailAccounts, emails } from '@mantle/db';
import { parserText } from '@mantle/files';
import { str, strOptTrim as strOpt } from './coerce';
import type { BuiltinToolDef } from './types';
import { errorMessage } from '@mantle/std';
import { areaSystem } from './admin-gate';

/**
 * The email tools run in the caller's scope: the
 * page, the files and the contacts they read are items, and the mail rows
 * follow their item (an Admin kind: a scope that holds Admin reads them).
 * The mail accounts (sealed credentials), the Microsoft accounts and the
 * logins' addresses are system tables, read here through areaSystem.
 */
function mailSystem<T>(fn: () => Promise<T>): Promise<T> {
  return areaSystem('connectors', fn);
}

/** The ids of the owner's mail accounts (system pool, by the named reason). */
async function ownerAccountIds(ownerId: string): Promise<string[]> {
  const rows = await mailSystem(() =>
    db
      .select({ id: emailAccounts.id })
      .from(emailAccounts)
      .where(eq(emailAccounts.userId, ownerId)),
  );
  return rows.map((r) => r.id);
}

const email_list: BuiltinToolDef = {
  slug: 'email_list',
  usageTier: 3,
  // Mail from outside the brain: fenced as data. The owner's
  // private corpus: a workspace user's turn only with teamPrivateReads.
  policy: {
    effect: 'read',
    spends: 'none',
    scope: { area: 'connectors' },
    outside: { untrusted: true },
    privateCorpus: true,
  },
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

    // `emails` carries no owner column: it scopes through account_id to
    // email_accounts.user_id, so the join IS the scope. Without it this would
    // list every email row on the box. See builtins-read-scope.test.ts.
    // The owner's accounts are read on the system pool (their credentials are
    // sealed there); the mail rows in the caller's scope.
    const accountIds = await ownerAccountIds(ctx.ownerId);
    if (accountIds.length === 0) return { ok: true, output: [] };
    const conds = [inArray(emails.accountId, accountIds)] as ReturnType<typeof eq>[];
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
        .where(and(...conds))
        .orderBy(desc(emails.internalDate))
        .limit(limit);
      ctx.step?.setOutput({ count: rows.length });
      return { ok: true, output: rows };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

const email_get: BuiltinToolDef = {
  slug: 'email_get',
  usageTier: 3,
  // Mail from outside the brain: fenced as data. The owner's
  // private corpus: a workspace user's turn only with teamPrivateReads.
  policy: {
    matrix: { none: 'a mail message: an Admin kind, not a workspace kind' },
    effect: 'read',
    spends: 'none',
    scope: { area: 'connectors' },
    outside: { untrusted: true },
    privateCorpus: true,
  },
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
      const accountIds = await ownerAccountIds(ctx.ownerId);
      // Explicit columns: the full row carries body_html, which for a typical
      // newsletter/marketing mail is ~50 KB of markup wrapping a few hundred
      // chars of text. Shipping it blows past the inline tool-result cap,
      // forces a spill, and sends the model paging through HTML soup.
      // body_text is canonical (it's what the
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
        // Owner scope, the owner's accounts as email_list: an id on its own
        // must not open another owner's mail.
        .where(
          and(
            accountIds.length > 0 ? inArray(emails.accountId, accountIds) : sql`false`,
            or(eq(emails.id, id), eq(emails.nodeId, id)),
          ),
        )
        .limit(1);
      if (!row) return { ok: false, error: `email '${id}' not found` };
      const text = row.bodyText?.trim();
      // No text part: the HTML part's text, taken out by the parser service
      // (the linear markup reader). Mail from outside is untrusted markup, so
      // it is never stripped here; a parser that cannot read it now leaves
      // the body empty and says so.
      let htmlBody = '';
      let htmlFailed = false;
      if (!text && row.bodyHtml) {
        try {
          htmlBody = (await parserText(Buffer.from(row.bodyHtml, 'utf8'), 'html')).trim();
        } catch {
          htmlFailed = true;
        }
      }
      const body = text || htmlBody;
      const { bodyText: _t, bodyHtml: _h, ...head } = row;
      ctx.step?.setOutput({ id: row.id, subject: row.subject });
      return {
        ok: true,
        output: {
          ...head,
          body,
          ...(text
            ? {}
            : {
                body_source: !row.bodyHtml
                  ? 'empty'
                  : htmlFailed
                    ? 'html_unreadable_now'
                    : 'html_converted',
              }),
        },
      };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const EMAIL_TOOLS: BuiltinToolDef[] = [email_list, email_get];
