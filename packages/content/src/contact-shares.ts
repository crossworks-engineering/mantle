/**
 * Contact shares (migration 0214; docs/sharing.md, "Contact shares"): one
 * workspace item shared with one contact. Each contact gets their own share
 * row, so their own token and link; the link opens with that contact's code
 * (contact-share-codes.ts, the /s gate in server/web/lib/
 * contact-share-gate.ts).
 *
 * The rules, here and in every caller:
 *  - a contact share NEVER changes a level. Every level path in shares.ts
 *    reads open links only (`openPredicate`), so a level change (admin,
 *    team, client or public) leaves contact shares alone, and removing one
 *    is a revoke only (unshareItem);
 *  - only workspace kinds, never a folder (v1, decision 2), never a contact;
 *  - only for a contact with sharing on; a switch off revokes them all;
 *  - `can_write` only on an app (the database CHECK says so too);
 *  - one live share per (item, contact): asking again returns it.
 */
import { randomBytes } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { contactShareCodes, db, nodes, shares, WORKSPACE_NODE_TYPES } from '@mantle/db';
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

/** Kinds a contact share may name: the workspace kinds, never a folder. */
export const CONTACT_SHAREABLE_TYPES: readonly string[] = WORKSPACE_NODE_TYPES.filter(
  (t) => t !== 'branch',
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

/**
 * Share one item with each of `contactIds`. One share per contact, made or
 * found (idempotent per item and contact: an existing live share is
 * returned as it is). Refused, as a whole, for a contact with sharing off
 * or not this owner's, an item that is not a workspace kind or is a folder,
 * and `canWrite` on anything but an app. Changes no level.
 */
export async function createContactShares(
  ownerId: string,
  nodeId: string,
  contactIds: readonly string[],
  canWrite = false,
): Promise<CreatedContactShare[]> {
  const ids = [...new Set(contactIds.map((c) => c.toLowerCase()))];
  if (ids.length === 0) return [];
  return db.transaction(async (tx) => {
    const [node] = await tx
      .select({ id: nodes.id, type: nodes.type })
      .from(nodes)
      .where(and(eq(nodes.id, nodeId), eq(nodes.ownerId, ownerId)))
      .limit(1);
    if (!node) throw new ContactShareRefusedError('not-shareable', 'item not found');
    if (node.type === 'branch') {
      throw new ContactShareRefusedError(
        'folder',
        'A folder cannot be shared with a contact. Share the items in it one by one.',
      );
    }
    if (!CONTACT_SHAREABLE_TYPES.includes(node.type)) {
      throw new ContactShareRefusedError(
        'not-shareable',
        `A ${node.type} cannot be shared with a contact.`,
      );
    }
    if (canWrite && node.type !== 'app') {
      throw new ContactShareRefusedError('write-not-app', 'Only an app can let a contact write.');
    }
    const contacts = await tx
      .select({ id: nodes.id, on: contactShareCodes.codeHash })
      .from(nodes)
      .leftJoin(contactShareCodes, eq(contactShareCodes.contactId, nodes.id))
      .where(and(eq(nodes.ownerId, ownerId), eq(nodes.type, 'contact'), inArray(nodes.id, ids)));
    if (contacts.length !== ids.length) {
      throw new ContactShareRefusedError('not-a-contact', 'Not a contact of this brain.');
    }
    if (contacts.some((c) => !c.on)) {
      throw new ContactShareRefusedError(
        'sharing-off',
        'Sharing is off for this contact. Turn it on in Contacts first.',
      );
    }
    // An expired share still holds its (item, contact) slot
    // (shares_node_contact_uq is WHERE revoked_at IS NULL): retire it first.
    await tx
      .update(shares)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(shares.ownerId, ownerId),
          eq(shares.nodeId, nodeId),
          inArray(shares.contactId, ids),
          isNull(shares.revokedAt),
          lt(shares.expiresAt, new Date()),
        ),
      );
    const existing = await tx
      .select({ id: shares.id, contactId: shares.contactId, token: shares.token })
      .from(shares)
      .where(
        and(
          eq(shares.ownerId, ownerId),
          eq(shares.nodeId, nodeId),
          inArray(shares.contactId, ids),
          isNull(shares.revokedAt),
        ),
      );
    const have = new Map(existing.map((e) => [e.contactId!, e]));
    const missing = ids.filter((c) => !have.has(c));
    if (missing.length) {
      const made = await tx
        .insert(shares)
        .values(
          missing.map((contactId) => ({
            ownerId,
            nodeId,
            nodeType: node.type as (typeof shares.$inferInsert)['nodeType'],
            token: genToken(),
            contactId,
            canWrite,
          })),
        )
        .returning({ id: shares.id, contactId: shares.contactId, token: shares.token });
      for (const m of made) have.set(m.contactId!, m);
    }
    return ids.map((contactId) => {
      const s = have.get(contactId)!;
      return { shareId: s.id, contactId, path: `/s/${s.token}` };
    });
  });
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

/** Revoke every live share of one contact (the "Shared" tab's Revoke all).
 *  No level changes; the contact's sharing stays on. */
export async function revokeAllContactShares(ownerId: string, contactId: string): Promise<number> {
  const rows = await db
    .update(shares)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(shares.ownerId, ownerId), eq(shares.contactId, contactId), isNull(shares.revokedAt)),
    )
    .returning({ id: shares.id });
  return rows.length;
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

/** The contacts one item is shared with, for the Access control. */
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
      on: contactShareCodes.codeHash,
    })
    .from(shares)
    .innerJoin(nodes, and(eq(nodes.id, shares.contactId), eq(nodes.ownerId, shares.ownerId)))
    .leftJoin(contactShareCodes, eq(contactShareCodes.contactId, shares.contactId))
    .where(and(eq(shares.ownerId, ownerId), eq(shares.nodeId, nodeId), live()))
    .orderBy(nodes.title);
  return rows.map((r) => ({
    shareId: r.id,
    contactId: r.contactId!,
    name: r.name,
    canWrite: r.canWrite,
    sharingOn: r.on !== null,
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
