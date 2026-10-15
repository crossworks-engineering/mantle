/**
 * What a provider key carries besides its value: today one field, the
 * Anthropic workspace id a key not scoped to a workspace must name on every
 * call (`anthropic-workspace-id`).
 *
 * Why a registry and not a parameter: a key reaches a provider adapter as a
 * plain string from some thirty callers (agents, workers, the model list,
 * the key test, scripts), and the header must ride on EVERY Anthropic call
 * without any of them knowing (one place, the gateway lens). So the one
 * place a key is opened (@mantle/api-keys) records what the key carries
 * here, and the one place an Anthropic request is built (the voice
 * adapter's `anthropicHeaders`) reads it back. A key opened with nothing to
 * carry clears its entry, so a cleared workspace id stops being sent the
 * next time the key is read.
 *
 * The map is keyed by the key value itself: the value is already in this
 * process's memory wherever the key is used, and a hash would need a node
 * builtin this browser-safe package cannot import. Never iterated, never
 * logged, and bounded ({@link MAX_ENTRIES}, oldest out first). It lives on
 * globalThis so a module loaded twice (two server bundle layers) shares one.
 */

export type ProviderKeyContext = {
  /** Anthropic: the workspace id sent as `anthropic-workspace-id`. */
  anthropicWorkspaceId?: string;
};

/** More keys than any brain holds; the bound only stops a leak. */
const MAX_ENTRIES = 512;

const SLOT = Symbol.for('mantle.providerKeyContext');

function registry(): Map<string, ProviderKeyContext> {
  const g = globalThis as { [SLOT]?: Map<string, ProviderKeyContext> };
  return (g[SLOT] ??= new Map());
}

/**
 * Record what `key` carries (null or an empty context clears it). Called by
 * the key store each time it opens a key, never by a caller of a provider.
 */
export function rememberProviderKeyContext(key: string, context: ProviderKeyContext | null): void {
  if (!key) return;
  const map = registry();
  map.delete(key);
  if (!context || !context.anthropicWorkspaceId) return;
  map.set(key, { anthropicWorkspaceId: context.anthropicWorkspaceId });
  while (map.size > MAX_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/** What `key` carries, or undefined when nothing was recorded for it. */
export function providerKeyContext(key: string | null | undefined): ProviderKeyContext | undefined {
  return key ? registry().get(key) : undefined;
}

/** Test seam: forget every recorded key. */
export function _clearProviderKeyContexts(): void {
  registry().clear();
}

/** Longest workspace id accepted. Anthropic publishes no format, so the
 *  check is loose: a sane length, no whitespace or control characters. */
export const ANTHROPIC_WORKSPACE_ID_MAX = 128;

/**
 * The trimmed workspace id, or an error sentence. Empty after trimming is
 * `null` (no workspace id: clear it). Loose on purpose: no format is
 * invented, only what could never be a header value is refused.
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
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(value)) {
    return { ok: false, error: 'The workspace id cannot contain spaces or control characters.' };
  }
  return { ok: true, value };
}
