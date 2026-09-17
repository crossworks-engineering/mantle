import { describe, expect, it } from 'vitest';
import { KNOWN_KEY_SERVICES } from './services';

describe('KNOWN_KEY_SERVICES', () => {
  it('slugs are valid api_keys.service values and unique', () => {
    const seen = new Set<string>();
    for (const s of KNOWN_KEY_SERVICES) {
      expect(s.service).toMatch(/^[a-z0-9_-]+$/);
      expect(seen.has(s.service)).toBe(false);
      seen.add(s.service);
      expect(s.signupUrl).toMatch(/^https:\/\//);
      expect(s.label.length).toBeGreaterThan(0);
    }
  });

  it('never shadows an AI provider id (those belong to the provider dropdown)', async () => {
    const { SUPPORTED_PROVIDERS } = await import('@mantle/voice-client/providers');
    const providerIds = new Set(SUPPORTED_PROVIDERS.map((p: { id: string }) => p.id));
    for (const s of KNOWN_KEY_SERVICES) expect(providerIds.has(s.service)).toBe(false);
  });
});
