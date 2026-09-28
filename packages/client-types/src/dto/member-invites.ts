/**
 * Member invites (member logins Phase 6): an admin invites a person, who
 * opens the invite link, sets a password and becomes a MEMBER login.
 *
 * Admin: /api/team-admin/invites (create, list, revoke). Public, no session:
 * /api/auth/invite/:code (preview) and /api/auth/invite/accept (redeem). The
 * plaintext code is in the create response only, never in a list.
 */

/** Where an invite stands. A revoked invite is not listed. */
export type MemberInviteState = 'open' | 'redeemed' | 'expired';

/** One invite in GET /api/team-admin/invites (no code). */
export type MemberInviteRow = {
  id: string;
  /** The contact it was made for; null for an email-only invite, or once
   *  the contact is deleted. */
  contactId: string | null;
  /** The contact's current name; null when there is no contact. */
  contactName: string | null;
  /** The email the member login is created with (lower-cased). */
  email: string;
  displayName: string | null;
  state: MemberInviteState;
  createdAt: string;
  expiresAt: string;
  redeemedAt: string | null;
  /** The member login the invite created. */
  redeemedLoginId: string | null;
  /** The admin login that made it; null once that login is deleted. */
  createdBy: string | null;
};

/** GET /api/team-admin/invites: newest first. */
export type MemberInviteList = { invites: MemberInviteRow[] };

/**
 * POST /api/team-admin/invites (201). `code` and `linkPath` are shown ONCE:
 * only the code's hash is stored. `linkPath` is a client-app path
 * (`/invite?code=…`); prefix the client's origin to share it.
 */
export type MemberInviteCreated = {
  invite: MemberInviteRow;
  code: string;
  linkPath: string;
};

/** GET /api/auth/invite/:code (public): who the invite is for, so the page
 *  can greet them. Any code that cannot be redeemed is a uniform 404. */
export type MemberInvitePreview = {
  email: string;
  displayName: string | null;
  siteName: string | null;
};

/** POST /api/auth/invite/accept (public) { code, password, email? }: the
 *  member login is created and the session cookie is set, as a login does.
 *  Any failure about the code is a uniform 401. */
export type MemberInviteAccepted = { ok: true; email: string };
