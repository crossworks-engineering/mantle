import { InputError } from '@mantle/std';
import { normalizeAnthropicWorkspaceId } from '@mantle/voice-client';

/** Compute the display mask: first-4 + last-4 of a value long enough that
 *  eight characters leave most of it unseen, else dots only (a short value
 *  shown first-4 + last-4 would be nearly all of it). Exported so a write
 *  can stash it alongside the ciphertext. */
export function maskPlaintext(plaintext: string): string {
  if (plaintext.length < 16) return '••••';
  return `${plaintext.slice(0, 4)}…${plaintext.slice(-4)}`;
}

/** The workspace id as stored: trimmed, null for none. Throws InputError
 *  (a 400 with this text) for one that could never be a header value. */
export function checkedWorkspaceId(raw: string | null | undefined): string | null {
  const checked = normalizeAnthropicWorkspaceId(raw);
  if (!checked.ok) throw new InputError(checked.error);
  return checked.value;
}
