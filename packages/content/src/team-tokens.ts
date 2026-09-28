/**
 * Team codes: the old team-code portal's per-contact credential, one
 * `contact_team_tokens` row per contact (only the SHA-256 of the code is
 * stored). The portal (Phase 6 stage 5) and team links on /s (stage 6) are
 * retired, so a code opens nothing now and nothing mints a new one. What is
 * left: an old code redeems a member invite once while its contact has an
 * open invite (`verifyTeamToken`, member-invites.ts), and the contact rows
 * show when a code was made and last used (`teamStatusFor`,
 * `teamStatusByContact`). The alphabet and hash are shared with invite codes.
 *
 * Security posture: ~46 bits of entropy (8 chars × 56-char alphabet). The
 * invite redeem that checks a code is rate limited per IP and per brain.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, contactTeamTokens, nodes } from '@mantle/db';

export const TEAM_TOKEN_LENGTH = 8;

/** Mixed-case alphanumerics minus the look-alikes (0/O/o, 1/l/I) so a token
 *  read over the phone or retyped from paper survives the trip. 56 chars. */
const TOKEN_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

/** A random code of `length` characters from the look-alike-free alphabet.
 *  Team tokens are 8; member invite codes (member-invites.ts) are longer. */
export function generateAlphabetCode(length: number): string {
  const out: string[] = [];
  while (out.length < length) {
    // Rejection sampling: only accept bytes below the largest multiple of the
    // alphabet size (56 × 4 = 224) so every character is equally likely.
    const bytes = randomBytes(length * 2);
    for (const b of bytes) {
      if (b >= 224) continue;
      out.push(TOKEN_ALPHABET[b % TOKEN_ALPHABET.length]!);
      if (out.length === length) break;
    }
  }
  return out.join('');
}

export function generateTeamToken(): string {
  return generateAlphabetCode(TEAM_TOKEN_LENGTH);
}

export function hashTeamToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Owner-scoped guard: the id must be one of this owner's contact nodes. */
async function isOwnContact(ownerId: string, contactId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, contactId), eq(nodes.ownerId, ownerId), eq(nodes.type, 'contact')))
    .limit(1);
  return !!row;
}

/**
 * Result of minting a contact's team code:
 *   { token }            — newly minted; the PLAINTEXT code, shown once.
 *   { alreadyMember }    — the contact already had one; NOT re-minted.
 *   null                 — the contact doesn't exist / isn't this owner's.
 */
export type EnableTeamResult = { token: string } | { alreadyMember: true } | null;

/**
 * Mint a team code for a contact. Nothing in the product calls it since
 * member logins Phase 6 stage 6 (POST /api/contacts/:id/team is gone); the
 * invite tests use it to seed the old code an invite still accepts once.
 */
export async function enableTeamMember(
  ownerId: string,
  contactId: string,
): Promise<EnableTeamResult> {
  if (!(await isOwnContact(ownerId, contactId))) return null;
  const token = generateTeamToken();
  const inserted = await db
    .insert(contactTeamTokens)
    .values({ ownerId, contactId, tokenHash: hashTeamToken(token) })
    .onConflictDoNothing({ target: contactTeamTokens.contactId })
    .returning({ id: contactTeamTokens.id });
  if (inserted.length === 0) return { alreadyMember: true };
  return { token };
}

/**
 * Map a presented code to its contact. Callers on unauthenticated surfaces
 * MUST rate-limit before calling this. `exec` lets a caller read inside its
 * own transaction (the member invite redeem).
 */
export async function verifyTeamToken(
  token: string,
  exec: Pick<typeof db, 'select'> = db,
): Promise<{ ownerId: string; contactId: string } | null> {
  const trimmed = token.trim();
  if (trimmed.length < 6 || trimmed.length > 64) return null;
  const [row] = await exec
    .select({
      ownerId: contactTeamTokens.ownerId,
      contactId: contactTeamTokens.contactId,
    })
    .from(contactTeamTokens)
    .where(eq(contactTeamTokens.tokenHash, hashTeamToken(trimmed)))
    .limit(1);
  return row ? { ownerId: row.ownerId, contactId: row.contactId } : null;
}

export type TeamStatus = { since: string; lastUsedAt: string | null };

/** Membership status for ONE contact (or null if not a team member). The
 *  single-row path used by getContact/updateContact — avoids loading the whole
 *  owner team-map to read one row. */
export async function teamStatusFor(
  ownerId: string,
  contactId: string,
): Promise<TeamStatus | null> {
  const [row] = await db
    .select({ createdAt: contactTeamTokens.createdAt, lastUsedAt: contactTeamTokens.lastUsedAt })
    .from(contactTeamTokens)
    .where(and(eq(contactTeamTokens.ownerId, ownerId), eq(contactTeamTokens.contactId, contactId)))
    .limit(1);
  if (!row) return null;
  return {
    since: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
  };
}

/** Membership status for every team member of this owner, keyed by contact id.
 *  Used to annotate contact rows in list/get without an N+1. */
export async function teamStatusByContact(ownerId: string): Promise<Map<string, TeamStatus>> {
  const rows = await db
    .select({
      contactId: contactTeamTokens.contactId,
      createdAt: contactTeamTokens.createdAt,
      lastUsedAt: contactTeamTokens.lastUsedAt,
    })
    .from(contactTeamTokens)
    .where(eq(contactTeamTokens.ownerId, ownerId));
  const out = new Map<string, TeamStatus>();
  for (const r of rows) {
    out.set(r.contactId, {
      since: r.createdAt.toISOString(),
      lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
    });
  }
  return out;
}
