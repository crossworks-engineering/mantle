/**
 * Contact shares (migration 0214; docs/sharing.md, "Contact shares"): one
 * workspace item shared with one contact. Each contact gets their own share
 * row, so their own token and link; the link opens with that contact's code
 * (contact-share-codes.ts, the /s gate in server/web/lib/
 * contact-share-gate.ts).
 *
 * The rules, here and in every caller:
 *  - a contact share NEVER changes a level or a grant (no link does), and
 *    removing one is a revoke only (revokeShare);
 *    it holds no served list: it serves what its item names;
 *  - only workspace kinds, never a folder, never a contact;
 *  - only for a contact with sharing on; a switch off revokes them all;
 *  - `can_write` only on an app (the database CHECK says so too);
 *  - one live share per (item, contact): asking again returns it.
 */
import { randomBytes } from 'node:crypto';
import { and, desc, eq, gt, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { db, nodes, shares, SNAPSHOT_COPY_NO_SHARE } from '@mantle/db';
import { defineDomainError, UUID_RE } from '@mantle/std';
import { contactSharingByContact } from './contact-share-codes';
import { kindsWhere, type ContactShareKind } from '@mantle/client-types/kinds';
import type {
  AccessContactShare,
  ContactShareRefusedReason,
  ContactShareRow,
  CreatedContactShare,
} from '@mantle/client-types';

/** Why a contact share was refused. `reason` goes on the wire. */
export class ContactShareRefusedError extends Error {
  constructor(
    readonly reason: ContactShareRefusedReason,
    message: string,
  ) {
    super(message);
    this.name = 'ContactShareRefusedError';
  }
}

// The one error answer (@mantle/std domain-errors.ts).
defineDomainError(ContactShareRefusedError, {
  reason: 'the share cannot be made as asked; the message and the reason say why',
  status: 400,
  body: (e) => ({ error: e.message, reason: e.reason }),
});

/** Kinds a contact share may name: the kind registry's `contactShare`
 *  (@mantle/client-types/kinds), never a folder. Its own field, not the
 *  workspace class: tasks, events and Recall maps are in that class and
 *  stay out of contact shares until a reviewed change says so. */
export const CONTACT_SHAREABLE_TYPES: readonly string[] = kindsWhere<ContactShareKind>(
  (s) => s.contactShare,
);

const live = () =>
  and(
    isNull(shares.revokedAt),
    or(isNull(shares.expiresAt), gt(shares.expiresAt, new Date())),
    isNotNull(shares.contactId),
  );

function genToken(): string {
  return randomBytes(16).toString('base64url');
}

/** One row of a share act (mantle_share_with_contacts_rows, 0308). */
export type ContactShareActRow = {
  share_id: string | null;
  contact_id: string | null;
  token: string | null;
  refused: string | null;
};

/** The refusal a share act's `refused` names, in today's words. */
function refusalOf(refused: string): ContactShareRefusedError {
  if (refused === 'missing') return new ContactShareRefusedError('not-shareable', 'item not found');
  // A read-only snapshot copy is shared with no one (the database refuses
  // it too).
  if (refused === 'snapshot') {
    return new ContactShareRefusedError('not-shareable', SNAPSHOT_COPY_NO_SHARE);
  }
  if (refused === 'folder') {
    return new ContactShareRefusedError(
      'folder',
      'A folder cannot be shared with a contact. Share the items in it one by one.',
    );
  }
  if (refused.startsWith('kind:')) {
    return new ContactShareRefusedError(
      'not-shareable',
      `A ${refused.slice('kind:'.length)} cannot be shared with a contact.`,
    );
  }
  if (refused === 'write-not-app') {
    return new ContactShareRefusedError('write-not-app', 'Only an app can let a contact write.');
  }
  if (refused === 'not-a-contact') {
    return new ContactShareRefusedError('not-a-contact', 'Not a contact of this brain.');
  }
  if (refused === 'sharing-off') {
    return new ContactShareRefusedError(
      'sharing-off',
      'Sharing is off for this contact. Turn it on in Contacts first.',
    );
  }
  throw new Error(`contact share: an unknown refusal ${refused}`);
}

/**
 * A share act's call (migration 0308): the contacts each once (lower case, first
 * seen first), a new token for each, the act's rows from `run` (the SQL
 * body for an owner here, the Admin act's definer in admin-acts.ts), and
 * the answer: the shares in the order asked, or the refusal. The rows are
 * written in SQL alone (migration 0308); what only TypeScript knows comes
 * in as arguments: the tokens and the kinds a contact share may name.
 */
export async function contactShareAct(
  contactIds: readonly string[],
  run: (args: { contacts: string; tokens: string; kinds: string }) => Promise<ContactShareActRow[]>,
): Promise<CreatedContactShare[]> {
  const ids = [...new Set(contactIds.map((c) => c.toLowerCase()))];
  if (ids.length === 0) return [];
  if (!ids.every((c) => UUID_RE.test(c))) {
    throw new ContactShareRefusedError('not-a-contact', 'Not a contact of this brain.');
  }
  const rows = await run({
    contacts: `{${ids.join(',')}}`,
    tokens: `{${ids.map(() => genToken()).join(',')}}`,
    kinds: `{${CONTACT_SHAREABLE_TYPES.join(',')}}`,
  });
  const refused = rows.find((r) => r.refused)?.refused;
  if (refused) throw refusalOf(refused);
  return rows.map((r) => ({
    shareId: r.share_id!,
    contactId: r.contact_id!,
    path: `/s/${r.token!}`,
  }));
}

/**
 * Share one item with each of `contactIds`. One share per contact, made or
 * found (idempotent per item and contact: an existing live share is
 * returned as it is). Refused, as a whole, for a contact with sharing off
 * or not this owner's, an item that is not a workspace kind or is a folder,
 * and `canWrite` on anything but an app. Changes no level. The SQL body for
 * an owner (system work: no Admin check; the Admin act is
 * mantle_share_with_contacts).
 */
export async function createContactShares(
  ownerId: string,
  nodeId: string,
  contactIds: readonly string[],
  canWrite = false,
): Promise<CreatedContactShare[]> {
  return contactShareAct(
    contactIds,
    // In a transaction: the system actor is bound on it (the actor check).
    async (a) =>
      (await db.transaction((tx) =>
        tx.execute(
          sql`select share_id::text, contact_id::text, token, refused
                from mantle_share_with_contacts_rows(${ownerId}::uuid, ${nodeId}::uuid,
                       ${a.contacts}::uuid[], ${a.tokens}::text[], ${canWrite}, ${a.kinds}::text[])`,
        ),
      )) as unknown as ContactShareActRow[],
  );
}

/** Set "Can write" on a live contact share of an app. False when there is
 *  no such share (an open link, another kind, revoked, not this owner's). */
export async function setContactShareCanWrite(
  ownerId: string,
  shareId: string,
  canWrite: boolean,
): Promise<boolean> {
  const rows = await db
    .update(shares)
    .set({ canWrite })
    .where(
      and(eq(shares.id, shareId), eq(shares.ownerId, ownerId), eq(shares.nodeType, 'app'), live()),
    )
    .returning({ id: shares.id });
  return rows.length > 0;
}

/** Revoke every live share of one contact (the "Shared" tab's Revoke all)
 *  and answer how many (0 for a contact of another owner, as before). No
 *  level changes; the contact's sharing stays on. The SQL body for an
 *  owner (system work: no Admin check; the Admin act is
 *  mantle_contact_shares_revoke_all). */
export async function revokeAllContactShares(ownerId: string, contactId: string): Promise<number> {
  // In a transaction: the system actor is bound on it (the actor check).
  const rows = (await db.transaction((tx) =>
    tx.execute(
      sql`select mantle_contact_shares_revoke_rows(${ownerId}::uuid, ${contactId}::uuid) as n`,
    ),
  )) as unknown as { n: number | null }[];
  return rows[0]?.n ?? 0;
}

/** One item of the contact's "Shared with you" menu. */
export type ContactMenuItem = {
  token: string;
  kind: string;
  title: string;
  icon: string | null;
};

/** The contact-side menu reads at most this many. */
export const CONTACT_MENU_LIMIT = 50;

/**
 * The live shares of ONE contact, newest first, for the "Shared with you"
 * menu on a contact share's /s view (section 6a): one query, `shares`
 * joined to `nodes` on the item and the owner, served from
 * `shares_contact_idx`. Token, kind, title and icon only. `limit` + 1 rows
 * are read so the caller knows there are more.
 */
export async function listContactShares(
  ownerId: string,
  contactId: string,
  opts: { limit?: number } = {},
): Promise<{ items: ContactMenuItem[]; more: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? CONTACT_MENU_LIMIT, 1), CONTACT_MENU_LIMIT);
  const rows = await db
    .select({ token: shares.token, kind: nodes.type, title: nodes.title, data: nodes.data })
    .from(shares)
    .innerJoin(nodes, and(eq(nodes.id, shares.nodeId), eq(nodes.ownerId, shares.ownerId)))
    .where(and(eq(shares.ownerId, ownerId), eq(shares.contactId, contactId), live()))
    .orderBy(desc(shares.createdAt), desc(shares.id))
    .limit(limit + 1);
  return {
    items: rows.slice(0, limit).map((r) => {
      const d = (r.data ?? {}) as Record<string, unknown>;
      return {
        token: r.token,
        kind: r.kind,
        title: r.title,
        icon: typeof d.icon === 'string' ? d.icon : null,
      };
    }),
    more: rows.length > limit,
  };
}

/** The admin's "Shared" tab reads this many a page. */
export const CONTACT_SHARES_PAGE = 100;

/** A page cursor: the last row's share time and id. */
function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | null | undefined): { at: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    const at = new Date(iso ?? '');
    if (Number.isNaN(+at) || !id || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    return { at, id };
  } catch {
    return null;
  }
}

/**
 * The admin's "Shared" tab of one contact: its live shares, newest first,
 * 100 a page, one query (the shape of {@link listContactShares}, with what
 * the admin needs). `lastOpenedAt` is `shares.last_viewed_at`, which the gate
 * sets on a contact's open.
 */
export async function listContactSharesForAdmin(
  ownerId: string,
  contactId: string,
  cursor?: string | null,
): Promise<{ shares: ContactShareRow[]; nextCursor: string | null }> {
  const after = decodeCursor(cursor);
  const rows = await db
    .select({
      id: shares.id,
      token: shares.token,
      nodeId: shares.nodeId,
      kind: nodes.type,
      title: nodes.title,
      data: nodes.data,
      canWrite: shares.canWrite,
      createdAt: shares.createdAt,
      lastViewedAt: shares.lastViewedAt,
    })
    .from(shares)
    .innerJoin(nodes, and(eq(nodes.id, shares.nodeId), eq(nodes.ownerId, shares.ownerId)))
    .where(
      and(
        eq(shares.ownerId, ownerId),
        eq(shares.contactId, contactId),
        live(),
        after
          ? sql`(${shares.createdAt}, ${shares.id}) < (${after.at.toISOString()}::timestamptz, ${after.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(desc(shares.createdAt), desc(shares.id))
    .limit(CONTACT_SHARES_PAGE + 1);
  const page = rows.slice(0, CONTACT_SHARES_PAGE);
  const last = page[page.length - 1];
  return {
    shares: page.map((r) => {
      const d = (r.data ?? {}) as Record<string, unknown>;
      return {
        shareId: r.id,
        nodeId: r.nodeId,
        kind: r.kind,
        icon: typeof d.icon === 'string' ? d.icon : null,
        title: r.title,
        canWrite: r.canWrite,
        sharedAt: r.createdAt.toISOString(),
        lastOpenedAt: r.lastViewedAt ? r.lastViewedAt.toISOString() : null,
        path: `/s/${r.token}`,
      };
    }),
    nextCursor:
      rows.length > CONTACT_SHARES_PAGE && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

/** The contacts one item is shared with, for the Access control. Whether
 *  a contact's sharing is on comes from contactSharingByContact, the one
 *  reader of the codes table (contact-share-codes.ts): the workspace role
 *  never reads it, so this list reads in the caller's scope too (the Grant
 *  Access panel). */
export async function contactSharesForNode(
  ownerId: string,
  nodeId: string,
): Promise<AccessContactShare[]> {
  const rows = await db
    .select({
      id: shares.id,
      token: shares.token,
      contactId: shares.contactId,
      name: nodes.title,
      canWrite: shares.canWrite,
      lastViewedAt: shares.lastViewedAt,
    })
    .from(shares)
    .innerJoin(nodes, and(eq(nodes.id, shares.contactId), eq(nodes.ownerId, shares.ownerId)))
    .where(and(eq(shares.ownerId, ownerId), eq(shares.nodeId, nodeId), live()))
    .orderBy(nodes.title);
  const on = rows.length
    ? await contactSharingByContact(ownerId, [...new Set(rows.map((r) => r.contactId!))])
    : new Map();
  return rows.map((r) => ({
    shareId: r.id,
    contactId: r.contactId!,
    name: r.name,
    canWrite: r.canWrite,
    sharingOn: on.has(r.contactId!),
    lastOpenedAt: r.lastViewedAt ? r.lastViewedAt.toISOString() : null,
    path: `/s/${r.token}`,
  }));
}

/** A live contact share by id (owner-scoped), or null: what the share
 *  routes need to tell a contact share from an open link. */
export async function getContactShare(
  ownerId: string,
  shareId: string,
): Promise<{ id: string; nodeId: string; nodeType: string; contactId: string } | null> {
  const [row] = await db
    .select({
      id: shares.id,
      nodeId: shares.nodeId,
      nodeType: shares.nodeType,
      contactId: shares.contactId,
    })
    .from(shares)
    .where(and(eq(shares.id, shareId), eq(shares.ownerId, ownerId), live()))
    .limit(1);
  return row ? { ...row, contactId: row.contactId! } : null;
}
