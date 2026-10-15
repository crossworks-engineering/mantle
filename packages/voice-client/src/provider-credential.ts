/**
 * Helpers for {@link ProviderCredential}, the handle a key lookup returns and
 * every adapter call takes (adapters/types.ts). Browser-safe, no imports but
 * the type.
 */
import type { ProviderCredential } from './adapters/types';

/**
 * Only the credential's own fields of `from` (an options object, a route, a
 * loop's args that extend ProviderCredential), for handing to an adapter
 * call without the rest of the object. THE one copy: a field added to
 * ProviderCredential is added here, and every layer that passes a credential
 * on carries it.
 */
export function credentialOf(from: ProviderCredential): ProviderCredential {
  return {
    apiKey: from.apiKey,
    ...(from.anthropicWorkspaceId ? { anthropicWorkspaceId: from.anthropicWorkspaceId } : {}),
  };
}

/** Longest Anthropic workspace id accepted. */
export const ANTHROPIC_WORKSPACE_ID_MAX = 128;

/**
 * The shape an Anthropic workspace id is accepted in: ASCII letters, digits,
 * `_` and `-`, 1 to 128 of them. Anthropic publishes no format; its ids are
 * `wrkspc_` plus letters and digits. ASCII only, so the value is always a
 * legal header value (a non-ASCII or control character makes fetch throw a
 * TypeError before any request). The 0292 table check is the same pattern.
 */
export const ANTHROPIC_WORKSPACE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The trimmed workspace id, or an error sentence. Empty after trimming is
 * `null` (no workspace id: clear it).
 */
export function normalizeAnthropicWorkspaceId(
  raw: string | null | undefined,
): { ok: true; value: string | null } | { ok: false; error: string } {
  const value = (raw ?? '').trim();
  if (!value) return { ok: true, value: null };
  if (value.length > ANTHROPIC_WORKSPACE_ID_MAX) {
    return {
      ok: false,
      error: `The workspace id is longer than ${ANTHROPIC_WORKSPACE_ID_MAX} characters.`,
    };
  }
  if (!ANTHROPIC_WORKSPACE_ID_RE.test(value)) {
    return {
      ok: false,
      error: 'The workspace id can hold only letters A to Z, digits, _ and -.',
    };
  }
  return { ok: true, value };
}
