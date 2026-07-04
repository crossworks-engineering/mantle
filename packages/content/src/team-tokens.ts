/**
 * Team membership for contacts. "Team member" is a ROLE a contact holds, not a
 * different kind of node — contacts stay the address book / email allowlist,
 * and a live `contact_team_tokens` row grants the role (single source of
 * truth; no flag on the node to drift).
 *
 * Each team member holds ONE short token (e.g. `Xk3mP2vQ`) that identifies
 * them on external surfaces — first consumer is the `/s/` shared-app token
 * prompt (Phase B), which maps token → contact for access + audit. Only the
 * SHA-256 of the token is stored; the plaintext is returned exactly once by
 * `enableTeamMember` / `rotateTeamToken` and shown to the operator to hand
 * over out-of-band. Lost token ⇒ rotate.
 *
 * Security posture: ~46 bits of entropy (8 chars × 56-char alphabet) is
 * deliberate — the token is a SECOND factor behind an unguessable share URL,
 * not a bearer credential on a public route. Verification is one indexed
 * lookup by hash; consumers must rate-limit their prompt endpoints.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, contactTeamTokens, nodes } from '@mantle/db';

export const TEAM_TOKEN_LENGTH = 8;

/** Mixed-case alphanumerics minus the look-alikes (0/O/o, 1/l/I) so a token
 *  read over the phone or retyped from paper survives the trip. 56 chars. */
const TOKEN_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

export function generateTeamToken(): string {
  const out: string[] = [];
  while (out.length < TEAM_TOKEN_LENGTH) {
    // Rejection sampling: only accept bytes below the largest multiple of the
    // alphabet size (56 × 4 = 224) so every character is equally likely.
    const bytes = randomBytes(TEAM_TOKEN_LENGTH * 2);
    for (const b of bytes) {
      if (b >= 224) continue;
      out.push(TOKEN_ALPHABET[b % TOKEN_ALPHABET.length]!);
      if (out.length === TEAM_TOKEN_LENGTH) break;
    }
  }
  return out.join('');
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
 * Result of enabling the team-member role:
 *   { token }            — newly enrolled; the PLAINTEXT token, shown once.
 *   { alreadyMember }    — the contact was ALREADY a member; NOT re-minted
 *                          (rotating a live token is `rotateTeamToken`'s job,
 *                          never a silent side effect of "enable").
 *   null                 — the contact doesn't exist / isn't this owner's.
 */
export type EnableTeamResult = { token: string } | { alreadyMember: true } | null;

/**
 * Grant the team-member role, minting the contact's token. Idempotent and
 * non-destructive: enabling an already-enabled member does NOT rotate their
 * token (which would strand whatever they hold) — it returns `alreadyMember`.
 * Use `rotateTeamToken` for a deliberate re-mint.
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
 * Re-mint an EXISTING member's token (lost/compromised secret). Null when the
 * contact isn't currently a team member — rotation never silently enrolls.
 */
export async function rotateTeamToken(
  ownerId: string,
  contactId: string,
): Promise<{ token: string } | null> {
  const token = generateTeamToken();
  const updated = await db
    .update(contactTeamTokens)
    .set({ tokenHash: hashTeamToken(token), createdAt: new Date(), lastUsedAt: null })
    .where(
      and(eq(contactTeamTokens.ownerId, ownerId), eq(contactTeamTokens.contactId, contactId)),
    )
    .returning({ id: contactTeamTokens.id });
  return updated.length > 0 ? { token } : null;
}

/** Revoke the role (and the token with it). False when there was no membership. */
export async function disableTeamMember(ownerId: string, contactId: string): Promise<boolean> {
  const deleted = await db
    .delete(contactTeamTokens)
    .where(
      and(eq(contactTeamTokens.ownerId, ownerId), eq(contactTeamTokens.contactId, contactId)),
    )
    .returning({ id: contactTeamTokens.id });
  return deleted.length > 0;
}

/**
 * Map a presented token to its team member. Does NOT bump `last_used_at` — the
 * caller does that via `markTeamTokenUsed` only AFTER confirming the token
 * belongs to the relevant share's owner, so presenting a valid token from
 * brain A to brain B's link never touches brain A's row. Callers on
 * unauthenticated surfaces MUST rate-limit before calling this.
 */
export async function verifyTeamToken(
  token: string,
): Promise<{ ownerId: string; contactId: string } | null> {
  const trimmed = token.trim();
  if (trimmed.length < 6 || trimmed.length > 64) return null;
  const [row] = await db
    .select({
      ownerId: contactTeamTokens.ownerId,
      contactId: contactTeamTokens.contactId,
    })
    .from(contactTeamTokens)
    .where(eq(contactTeamTokens.tokenHash, hashTeamToken(trimmed)))
    .limit(1);
  return row ? { ownerId: row.ownerId, contactId: row.contactId } : null;
}

/** Record that a team member just used their token (owner-scoped liveness
 *  signal for the operator's contact screen). Best-effort. */
export async function markTeamTokenUsed(ownerId: string, contactId: string): Promise<void> {
  await db
    .update(contactTeamTokens)
    .set({ lastUsedAt: new Date() })
    .where(
      and(eq(contactTeamTokens.ownerId, ownerId), eq(contactTeamTokens.contactId, contactId)),
    );
}

/** Is this contact currently a team member? The live-row check the external
 *  surfaces run PER REQUEST, so revoking membership kills sessions mid-flight
 *  (the visitor cookie alone is never enough). */
export async function isTeamMember(ownerId: string, contactId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: contactTeamTokens.id })
    .from(contactTeamTokens)
    .where(
      and(eq(contactTeamTokens.ownerId, ownerId), eq(contactTeamTokens.contactId, contactId)),
    )
    .limit(1);
  return !!row;
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
    .where(
      and(eq(contactTeamTokens.ownerId, ownerId), eq(contactTeamTokens.contactId, contactId)),
    )
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
