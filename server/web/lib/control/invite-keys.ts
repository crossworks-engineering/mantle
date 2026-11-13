/**
 * The one-time keys of the Fleet users invite (docs/control-center.md, "Add
 * a person from the CC"). CC code: only POST /api/fleet/invite loads it,
 * after its CC check.
 *
 * For each invite ask the web process makes an RSA key pair. The public key
 * goes to the box with the ask; the box locks the invite code to it. The
 * private key stays here, in this process's memory only, under the call's
 * id, until the answer is opened once or INVITE_KEY_KEEP_MS passes. So the
 * CC's rows (the call queue, its answer) and its logs only ever hold the
 * code locked: after the answer is opened, or the key is gone, no copy the
 * CC can read is left anywhere.
 */
import { constants, generateKeyPairSync, privateDecrypt, type KeyObject } from 'node:crypto';
import { CONTROL_TOOL_KEEP_MS } from '@mantle/db/control-center';
import { INVITE_CODE_ALPHABET, MEMBER_INVITE_CODE_LENGTH, inviteLinkPath } from '@mantle/content';

/** A key is kept as long as the CC keeps an answer (the call queue's own
 *  keep), then dropped: its answer can never be opened after that. */
export const INVITE_KEY_KEEP_MS = CONTROL_TOOL_KEEP_MS;
/** The most keys held at once (each box holds at most ten calls). */
export const INVITE_KEYS_MAX = 500;

/** An invite code as the box makes one (member-invites.ts). Anything else
 *  is not used. */
const isCode = (code: string) =>
  code.length === MEMBER_INVITE_CODE_LENGTH &&
  [...code].every((ch) => INVITE_CODE_ALPHABET.includes(ch));

type Held = { key: KeyObject; boxId: string; boxUrl: string; email: string; until: number };
const held = new Map<string, Held>();
let clock = () => Date.now();

function prune(): void {
  const now = clock();
  for (const [id, h] of held) if (h.until <= now) held.delete(id);
}

/** A new key pair: the private key, and the public key as the box takes it
 *  (base64 of SPKI, DER). Null when INVITE_KEYS_MAX keys are held. */
export function newInviteKey(): { key: KeyObject; publicKey: string } | null {
  prune();
  if (held.size >= INVITE_KEYS_MAX) return null;
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    key: privateKey,
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

/** Holds `key` for the call `callId` (an invite for `email` on the box
 *  `boxId` at `boxUrl`). */
export function holdInviteKey(callId: string, h: Omit<Held, 'until'>): void {
  held.set(callId.toLowerCase(), { ...h, until: clock() + INVITE_KEY_KEEP_MS });
}

/** Whether a key is held for `callId`: only those calls are this route's. */
export function holdsInviteKey(callId: string): boolean {
  prune();
  return held.has(callId.toLowerCase());
}

/** What an opened answer gives the person: the link once, or why not. */
export type OpenedInvite = {
  callId: string;
  boxId: string;
  email: string;
  ok: boolean;
  reason?: string;
  link?: string;
  expiresAt?: string;
};

/**
 * Opens the answer of the call `callId` with its key, and drops the key
 * (once: a second open has no key). The link is the box's own invite page
 * with the code in the fragment, as the box's Users screen makes it.
 */
export function openInviteAnswer(
  callId: string,
  answer: { ok?: boolean; reason?: string | null; output?: unknown },
): OpenedInvite | null {
  const id = callId.toLowerCase();
  const h = held.get(id);
  if (!h) return null;
  held.delete(id);
  const base = { callId: id, boxId: h.boxId, email: h.email };
  if (!answer.ok) return { ...base, ok: false, reason: answer.reason ?? 'refused' };
  const out = (answer.output ?? {}) as { sealed?: unknown; expiresAt?: unknown };
  let code = '';
  try {
    code = privateDecrypt(
      { key: h.key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(String(out.sealed ?? ''), 'base64'),
    ).toString('utf8');
  } catch {
    return { ...base, ok: false, reason: 'bad-reply' };
  }
  if (!isCode(code) || typeof out.expiresAt !== 'string') {
    return { ...base, ok: false, reason: 'bad-reply' };
  }
  return {
    ...base,
    ok: true,
    link: `${new URL(h.boxUrl).origin}${inviteLinkPath(code)}`,
    expiresAt: out.expiresAt,
  };
}

/** The answer of a call whose answer is gone or never came: its key is
 *  dropped, so nothing can open it later. */
export function dropInviteKey(callId: string): void {
  held.delete(callId.toLowerCase());
}

/** Tests only. */
export function forgetInviteKeys(now?: () => number): void {
  held.clear();
  clock = now ?? (() => Date.now());
}
