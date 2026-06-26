/**
 * Message data layer — owner-scoped reads/writes for the inbox.
 *
 * Lifted out of `apps/web` (the inbox page + email row actions) so the inbox is
 * reachable over HTTP and renderable by any client. Ownership is always enforced
 * through the account join, so a stolen email UUID — even from another account —
 * can't surface or mutate another owner's mail.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  db,
  emailAccounts,
  emails,
  emailAttachments,
  type Email,
  type EmailAttachment,
} from '@mantle/db';

export const INBOX_LIMIT = 100;

export interface NavAccount {
  id: string;
  address: string;
  provider: string;
}

/** Accounts for the inbox nav/gate — id/address/provider, ordered by address. */
export function navAccounts(userId: string): Promise<NavAccount[]> {
  return db
    .select({ id: emailAccounts.id, address: emailAccounts.address, provider: emailAccounts.provider })
    .from(emailAccounts)
    .where(eq(emailAccounts.userId, userId))
    .orderBy(emailAccounts.address);
}

export interface FolderFacet {
  folder: string;
  count: number;
  unread: number;
}

/**
 * Per-folder counts for one owned account (drives the folder nav). Counts
 * reflect INGESTED mail, not server totals. Verifies ownership first; a
 * non-owned account yields an empty list.
 */
export async function folderFacets(userId: string, accountId: string): Promise<FolderFacet[]> {
  const owns = await accountOwned(userId, accountId);
  if (!owns) return [];
  const rows = await db
    .select({
      folder: emails.folder,
      n: sql<number>`count(*)::int`,
      unread: sql<number>`count(*) filter (where ${emails.isRead} = false)::int`,
    })
    .from(emails)
    .where(eq(emails.accountId, accountId))
    .groupBy(emails.folder)
    .orderBy(desc(sql`count(*)`));
  return rows
    .filter((r): r is { folder: string; n: number; unread: number } => !!r.folder)
    .map((r) => ({ folder: r.folder, count: r.n, unread: r.unread }));
}

export interface ListMessagesInput {
  accountId: string;
  folder?: string | null;
  unreadOnly?: boolean;
  limit?: number;
}

export interface MessageListItem {
  id: string;
  fromAddr: string;
  fromName: string | null;
  subject: string | null;
  snippet: string | null;
  internalDate: Date;
  isRead: boolean;
}

/** Message list for the centre pane of one owned account. */
export async function listMessages(
  userId: string,
  input: ListMessagesInput,
): Promise<MessageListItem[]> {
  const owns = await accountOwned(userId, input.accountId);
  if (!owns) return [];
  const conds = [eq(emails.accountId, input.accountId)];
  if (input.folder) conds.push(eq(emails.folder, input.folder));
  if (input.unreadOnly) conds.push(eq(emails.isRead, false));
  return db
    .select({
      id: emails.id,
      fromAddr: emails.fromAddr,
      fromName: emails.fromName,
      subject: emails.subject,
      snippet: emails.snippet,
      internalDate: emails.internalDate,
      isRead: emails.isRead,
    })
    .from(emails)
    .where(and(...conds))
    .orderBy(desc(emails.internalDate))
    .limit(input.limit ?? INBOX_LIMIT);
}

/** One owner-scoped message with its attachments, or null. */
export async function getMessageWithAttachments(
  userId: string,
  emailId: string,
): Promise<{ email: Email; attachments: EmailAttachment[] } | null> {
  const [row] = await db
    .select()
    .from(emails)
    .innerJoin(emailAccounts, eq(emails.accountId, emailAccounts.id))
    .where(and(eq(emails.id, emailId), eq(emailAccounts.userId, userId)))
    .limit(1);
  const email = row?.emails ?? null;
  if (!email) return null;
  const attachments = await db
    .select()
    .from(emailAttachments)
    .where(eq(emailAttachments.emailId, email.id));
  return { email, attachments };
}

/**
 * Flip the read flag on one email. Owner-scoped via an account-id subquery so a
 * stolen email UUID can't change another owner's mail. Idempotent.
 */
export async function setReadStatus(userId: string, emailId: string, read: boolean): Promise<void> {
  if (!emailId) return;
  await db
    .update(emails)
    .set({ isRead: read })
    .where(and(eq(emails.id, emailId), inArray(emails.accountId, ownedAccountIds(userId))));
}

/** Flip the starred flag on one email (local-only; not written back to IMAP). */
export async function setStarred(userId: string, emailId: string, starred: boolean): Promise<void> {
  if (!emailId) return;
  await db
    .update(emails)
    .set({ isStarred: starred })
    .where(and(eq(emails.id, emailId), inArray(emails.accountId, ownedAccountIds(userId))));
}

/** Subquery of the owner's account ids — reused by the mutation WHERE clauses. */
function ownedAccountIds(userId: string) {
  return db.select({ id: emailAccounts.id }).from(emailAccounts).where(eq(emailAccounts.userId, userId));
}

async function accountOwned(userId: string, accountId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: emailAccounts.id })
    .from(emailAccounts)
    .where(and(eq(emailAccounts.id, accountId), eq(emailAccounts.userId, userId)))
    .limit(1);
  return !!row;
}
