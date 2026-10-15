/**
 * THE headers of every Anthropic API request (chat, streaming chat, vision,
 * the model list, the brain's model explorer). One place, so what a key
 * needs on the wire is decided once:
 *
 *  - `x-api-key`: the key.
 *  - `anthropic-version`: fixed; without it the API answers 400.
 *  - `anthropic-workspace-id`: only when the credential carries one. A key
 *    not scoped to an Anthropic workspace must name the workspace on every
 *    call, else Anthropic answers 400 (classified 'workspace' in @mantle/std
 *    provider-error.ts). The id is set on the key row in Settings and comes
 *    with the credential the key lookup returns (ProviderCredential,
 *    @mantle/api-keys openKeyRow), so a call sends the id of the very row its
 *    key was opened from.
 *
 * A file that sends `anthropic-version` itself bypasses this, and the
 * gateway test (anthropic-headers.test.ts) fails on it.
 */
import { ANTHROPIC_API_VERSION } from '../catalogs/anthropic';
import { ProviderHttpError, classifyProviderError } from '@mantle/std';
import type { ProviderCredential } from './types';

export const ANTHROPIC_WORKSPACE_HEADER = 'anthropic-workspace-id';

export function anthropicHeaders(
  credential: ProviderCredential,
  extra?: Record<string, string>,
): Record<string, string> {
  const workspaceId = credential.anthropicWorkspaceId;
  return {
    'x-api-key': credential.apiKey,
    'anthropic-version': ANTHROPIC_API_VERSION,
    ...(workspaceId ? { [ANTHROPIC_WORKSPACE_HEADER]: workspaceId } : {}),
    ...extra,
  };
}

/**
 * The text a failed model-list call reports (the key test reads it). A key
 * that names no workspace says the fixed sentence of its class, so the owner
 * learns what to set; anything else keeps the adapter's own wording.
 */
export function anthropicListError(status: number, body: string, fallback: string): string {
  const cls = classifyProviderError(new ProviderHttpError({ provider: 'anthropic', status, body }));
  return cls?.code === 'workspace' ? cls.reason : fallback;
}
