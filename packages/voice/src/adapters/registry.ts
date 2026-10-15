import type { ChatDispatcher } from './types';
import { registeredChatAdapter } from '@mantle/voice-client/adapters/registry';
import { withChatRetry } from './retry';

export * from '@mantle/voice-client/adapters/registry';

/**
 * The chat adapter for a provider, ready to call. OpenRouter's SDK already
 * retries transient errors internally; wrapping it would compound attempt
 * counts. The native-fetch adapters (anthropic / google / xai / huggingface /
 * deepseek / ...) have no retry of their own, so they are wrapped here once
 * for uniform 429/5xx/network/timeout backoff (./retry.ts).
 */
export function getChatAdapter(providerId: string): ChatDispatcher | null {
  const adapter = registeredChatAdapter(providerId);
  if (!adapter) return null;
  if (adapter.providerId === 'openrouter') return adapter;
  return withChatRetry(adapter);
}
