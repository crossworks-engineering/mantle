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

/** The AAD a row's `held_enc` (a change waiting for approval) is sealed
 *  with: the row and the hold its pending call names, so a hold opens only
 *  for the call that asked for it. */
export function heldAad(id: string, holdId: string): string {
  return `${id}:held:${holdId}`;
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

/** The characters a key print may show (docs/control-center.md, "Key
 *  status on the fleet"); a key whose shown part holds any other gives no
 *  print at all. */
const PRINT_CHARS = /^[A-Za-z0-9_-]*$/;

/**
 * A key's print, for a person to match it with the provider's own
 * dashboard: its first 12 and last 4 characters with the middle left out
 * (`sk-or-v1-abc…wxyz`), or null. Never more than a quarter of the key: a
 * key under 64 characters shows less of its head (floor(length / 4) less
 * the 4 of its tail), one under 24 its last 4 only, one under 16 nothing.
 * A shown part with a character outside [A-Za-z0-9_-] gives null, so the
 * print always fits the Control Center's pattern. Computed in memory from
 * the opened key; the key itself goes no further.
 */
export function keyPrint(plaintext: string): string | null {
  const n = plaintext.length;
  if (n < 16) return null;
  const head = n < 24 ? 0 : Math.min(12, Math.floor(n / 4) - 4);
  const shownHead = plaintext.slice(0, head);
  const shownTail = plaintext.slice(-4);
  if (!PRINT_CHARS.test(shownHead) || !PRINT_CHARS.test(shownTail)) return null;
  return `${shownHead}…${shownTail}`;
}

/** The workspace id as stored: trimmed, null for none. Throws InputError
 *  (a 400 with this text) for one that could never be a header value. */
export function checkedWorkspaceId(raw: string | null | undefined): string | null {
  const checked = normalizeAnthropicWorkspaceId(raw);
  if (!checked.ok) throw new InputError(checked.error);
  return checked.value;
}
