/**
 * The subject box's invite case (docs/control-center.md, "Add a person from
 * the CC"): one more fixed case on the signed route (box.ts), so the route's
 * own checks hold it first and no agent, MCP client or API key on the box
 * reaches it. It is not a tool.
 *
 *  - `invite { nonce, by, email, key }`: the box makes a member invite for
 *    `email` with its own invite code (createMemberInvite, the Users
 *    screen's path): the same refusals (a former client's email, an email
 *    that already has a login here), the same 72 hours, one use, and a new
 *    invite for the same email replaces the open one. The redeem makes a
 *    MEMBER login that joins no workspace; nothing here makes a login, sets
 *    a password or a role.
 *  - The code leaves the box only locked to `key`: a one-time RSA public
 *    key (SPKI, DER, base64, 2048 to 4096 bits) that the CC's web process
 *    made for this one ask and keeps in memory. The answer is
 *    `{ ok, sealed, expiresAt }`, `sealed` the code under RSA-OAEP
 *    (SHA-256). A key that is not such a key is refused (`key`) before any
 *    invite is made.
 *  - `by` is the CC person, for the audit row. The nonce is the call's id,
 *    taken once (tool-channel.ts takeNonce).
 *
 * The box's scope line rules it as the other users-area calls:
 * MANTLE_CONTROL_CENTER_SCOPE=none refuses it (`scope`).
 */
import { constants, createPublicKey, publicEncrypt, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { createMemberInvite, MemberInviteError } from '@mantle/content';
import { controlScope, takeNonce } from './tool-channel';

/** The longest email (the box's own invite route's cap). */
export const INVITE_EMAIL_MAX = 320;
/** The longest key: base64 of a 4096-bit RSA public key is about 740. */
export const INVITE_KEY_MAX = 1024;
const KEY_BITS_MIN = 2048;
const KEY_BITS_MAX = 4096;

/** The case, as box.ts's switch takes it. */
export const INVITE_CALLS = [
  z
    .object({
      op: z.literal('invite'),
      args: z
        .object({
          nonce: z.string().uuid(),
          by: z.string().max(200),
          email: z.string().max(INVITE_EMAIL_MAX),
          key: z
            .string()
            .max(INVITE_KEY_MAX)
            .regex(/^[A-Za-z0-9+/]+={0,2}$/),
        })
        .strict(),
    })
    .strict(),
] as const;

export type InviteCall = z.infer<(typeof INVITE_CALLS)[number]>;

/** What the invite case answers. Never the code in plain text. */
export type InviteAnswer = {
  ok: boolean;
  reason?:
    'scope' | 'replay' | 'busy' | 'key' | 'no-email' | 'email-has-login' | 'email-was-client';
  /** The code, locked to the asker's key (base64). */
  sealed?: string;
  expiresAt?: string;
};

/** The asker's one-time key, or null when it is not an RSA public key of
 *  2048 to 4096 bits. */
export function inviteKey(b64: string): KeyObject | null {
  try {
    const k = createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
    const bits = k.asymmetricKeyDetails?.modulusLength ?? 0;
    return k.asymmetricKeyType === 'rsa' && bits >= KEY_BITS_MIN && bits <= KEY_BITS_MAX ? k : null;
  } catch {
    return null;
  }
}

/** The code locked to `key`: RSA-OAEP with SHA-256, base64. */
export function lockCode(key: KeyObject, code: string): string {
  return publicEncrypt(
    { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(code, 'utf8'),
  ).toString('base64');
}

/** The invite case, as the anchor's brain (`anchorId` owns the invite and
 *  is its maker, as for an invite an Admin makes on the Users screen). */
export async function runInviteCall(anchorId: string, call: InviteCall): Promise<InviteAnswer> {
  if (!controlScope()) return { ok: false, reason: 'scope' };
  const nonce = takeNonce(call.args.nonce);
  if (nonce !== 'ok') return { ok: false, reason: nonce };
  // The key first: an invite with no way to hand over its code is not made.
  const key = inviteKey(call.args.key);
  if (!key) return { ok: false, reason: 'key' };
  let made: Awaited<ReturnType<typeof createMemberInvite>>;
  try {
    made = await createMemberInvite(anchorId, { email: call.args.email, createdBy: anchorId });
  } catch (err) {
    if (err instanceof MemberInviteError) {
      // With no contact, only these three are possible; any other is no-email.
      const reason =
        err.reason === 'email-has-login' || err.reason === 'email-was-client'
          ? err.reason
          : 'no-email';
      return { ok: false, reason };
    }
    throw err;
  }
  return { ok: true, sealed: lockCode(key, made.code), expiresAt: made.invite.expiresAt };
}

/** What the invite case's audit row names: who at the CC, the email, and
 *  the answer without the locked code. */
export function inviteAuditDetail(call: InviteCall, answer: InviteAnswer): Record<string, unknown> {
  return {
    by: call.args.by,
    email: call.args.email.trim().toLowerCase(),
    result: {
      ok: answer.ok,
      ...(answer.reason ? { reason: answer.reason } : {}),
      ...(answer.expiresAt ? { expiresAt: answer.expiresAt } : {}),
    },
  };
}
