import { describe, it, expect } from 'vitest';

// Importing the package barrel runs adapters/index.ts, which registers every
// built-in adapter into the live Maps. We then assert the STATIC WIRED_PROVIDERS
// table (read by isProviderWired — and therefore the only thing the adapter-free
// browser bundle can see) exactly matches what actually registered. Add an
// adapter without updating WIRED_PROVIDERS and this fails.
import '../index';
import {
  WIRED_PROVIDERS,
  registeredProviderIds,
  isProviderWired,
  type WiredCapability,
} from './registry';

const CAPS: WiredCapability[] = ['chat', 'tts', 'stt', 'vision', 'image_gen', 'embedding'];

describe('WIRED_PROVIDERS mirrors the live adapter registry', () => {
  for (const cap of CAPS) {
    it(`${cap}: static table === registered adapters`, () => {
      const live = [...registeredProviderIds(cap)].sort();
      const stat = [...WIRED_PROVIDERS[cap]].sort();
      expect(stat).toEqual(live);
    });
  }
});

describe('isProviderWired reads the static table (works without the live registry)', () => {
  it('reports real adapters wired', () => {
    expect(isProviderWired('elevenlabs', 'tts')).toBe(true);
    expect(isProviderWired('openai', 'tts')).toBe(true);
    expect(isProviderWired('openrouter', 'chat')).toBe(true);
    expect(isProviderWired('local', 'chat')).toBe(true);
  });

  it('reports OpenAI chat as NOT wired (no direct adapter — goes via OpenRouter)', () => {
    expect(isProviderWired('openai', 'chat')).toBe(false);
  });

  it('reports an unknown provider as not wired', () => {
    expect(isProviderWired('nope', 'tts')).toBe(false);
  });
});
