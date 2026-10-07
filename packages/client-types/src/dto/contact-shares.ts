/**
 * Contact shares (migration 0214; docs/sharing.md, "Contact shares"): one
 * workspace item shared with one contact. The contact opens the item's own
 * link (`/s/<token>`) with their personal code. The item's level never
 * changes, so the team never sees it. Read only, except an app with
 * "Can write". Never brain tools.
 */

/** A contact's sharing (the contact DTO's `sharing`); null: sharing off. */
export type ContactSharing = {
  /** When the current code was made (Enable or Regenerate). */
  enabledAt: string;
  lastUsedAt: string | null;
  /** 30 wrong codes in a day lock the contact for 24 hours. Regenerate
   *  clears the lock. */
  locked: boolean;
  /** Live contact shares of this contact. */
  shareCount: number;
};

/** POST /api/contacts/:id/sharing body. */
export type ContactSharingAction = 'enable' | 'regenerate' | 'disable';

/** POST /api/contacts/:id/sharing answer. `code` comes ONCE (enable and
 *  regenerate); `revoked` is how many shares a disable ended. */
export type ContactSharingResponse = {
  sharing: ContactSharing | null;
  code?: string;
  revoked?: number;
};

/** One row of a contact's "Shared" tab (GET /api/contacts/:id/shares). */
export type ContactShareRow = {
  shareId: string;
  nodeId: string;
  /** The item's node type ('page', 'app', ...). */
  kind: string;
  icon: string | null;
  title: string;
  canWrite: boolean;
  /** When the item was shared with the contact. */
  sharedAt: string;
  /** When the contact last opened it (null: never). */
  lastOpenedAt: string | null;
  /** Server-relative: `/s/<token>`. */
  path: string;
};

/** GET /api/contacts/:id/shares?cursor= : live shares, newest first, 100 a
 *  page. `nextCursor` null: the last page. */
export type ContactSharesPage = {
  shares: ContactShareRow[];
  nextCursor: string | null;
};

/** DELETE /api/contacts/:id/shares (Revoke all): no level changes, sharing
 *  stays on. */
export type ContactSharesRevokedAll = { revoked: number };

/** POST /api/shares/contacts body. `canWrite` only for an app. */
export type CreateContactSharesBody = {
  nodeId: string;
  contactIds: string[];
  canWrite?: boolean;
};

/** One share POST /api/shares/contacts made (or found: the call is
 *  idempotent per item and contact). */
export type CreatedContactShare = {
  shareId: string;
  contactId: string;
  /** Server-relative: `/s/<token>`. */
  path: string;
};

/** POST /api/shares/contacts answer. */
export type CreateContactSharesResponse = { shares: CreatedContactShare[] };

/** Why POST /api/shares/contacts refused (400 `{ error, reason }`). */
export type ContactShareRefusedReason =
  'sharing-off' | 'not-a-contact' | 'not-shareable' | 'folder' | 'write-not-app';

/** PATCH /api/shares/:id body for a contact share of an app. */
export type ContactShareUpdate = { canWrite: boolean };

/** One contact an item is shared with (`AccessNodeView.contactShares`). */
export type AccessContactShare = {
  shareId: string;
  contactId: string;
  name: string;
  canWrite: boolean;
  /** The contact's sharing is on: off means the link opens nothing (a
   *  switch off revokes the shares, so this is rarely false). */
  sharingOn: boolean;
  lastOpenedAt: string | null;
  /** Server-relative: `/s/<token>`. */
  path: string;
};
