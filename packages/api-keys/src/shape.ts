import type { VaultKind } from '@mantle/db';
import { InputError } from '@mantle/std';
import { normalizeAnthropicWorkspaceId } from '@mantle/voice-client';

/**
 * The AAD a row's `key_enc` is sealed with: the row id for a token (as
 * before 0346), `<id>:<kind>` for any other kind. So no token read path,
 * of this image or an older one, opens a password, an SSH key or a login,
 * and a kind flipped in SQL with no re-seal stays closed. The vault, the
 * key test and the master key rotation all seal and open through this.
 */
export function valueAad(id: string, kind: VaultKind): string {
  return kind === 'token' ? id : `${id}:${kind}`;
}

/** The AAD a row's `fields_enc` is sealed with. */
export function fieldsAad(id: string): string {
  return `${id}:fields`;
}

/** Compute the display mask, shown to the owner and to agents: the first
 *  4 and last 4 characters only of a value of 32 or more (a provider key,
 *  where eight leave most of it unseen), the last 4 of one of 16 to 31,
 *  dots only below that. Exported so a write can stash it alongside the
 *  ciphertext. */
export function maskPlaintext(plaintext: string): string {
  if (plaintext.length < 16) return '••••';
  if (plaintext.length < 32) return `…${plaintext.slice(-4)}`;
  return `${plaintext.slice(0, 4)}…${plaintext.slice(-4)}`;
}

/** The workspace id as stored: trimmed, null for none. Throws InputError
 *  (a 400 with this text) for one that could never be a header value. */
export function checkedWorkspaceId(raw: string | null | undefined): string | null {
  const checked = normalizeAnthropicWorkspaceId(raw);
  if (!checked.ok) throw new InputError(checked.error);
  return checked.value;
}
