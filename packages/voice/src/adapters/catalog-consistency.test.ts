/**
 * Drift guard: every adapter we register MUST be declared in the
 * providers catalog with the matching capability.
 *
 * Background — the bug this catches: when xai-tts and google-tts
 * shipped (1ea6c79), the adapters self-registered correctly and the
 * runtime path worked, but the providers catalog still listed only
 * `['chat', 'vision']` / `['chat', 'vision', 'embedding']` for those
 * providers. The UI worker form's provider dropdown filter reads
 * `providersForCapability(cap)`, which checks the catalog's
 * `capabilities` array — so neither xAI nor Google showed up when
 * the user opened "New TTS worker", even though everything else was
 * wired. Symptom: invisible feature; debugged by the user reporting
 * "I don't see xai in the TTS dropdown."
 *
 * The runtime module also `console.warn`s any drift it finds at
 * load time (see adapters/index.ts), which surfaces the same issue
 * in `pnpm dev` output. This test is the CI-time gate so a missed
 * catalog edit can't ship.
 */

import { describe, expect, it } from 'vitest';
import { findAdapterCatalogDrift } from './index';
import { SUPPORTED_PROVIDERS } from '../providers';

describe('adapter ↔ catalog drift guard', () => {
  it('every registered adapter has a matching capability in the catalog', () => {
    // findAdapterCatalogDrift returns a list of human-readable
    // problems. An empty list means catalog and registry agree.
    const drift = findAdapterCatalogDrift(SUPPORTED_PROVIDERS);
    if (drift.length > 0) {
      // Render every drift problem on its own line so a CI log
      // surfaces them all at once, not just the first.
      const formatted = drift.map((p) => `  - ${p}`).join('\n');
      throw new Error(
        `Adapter/catalog drift detected (${drift.length} problem${drift.length === 1 ? '' : 's'}):\n${formatted}`,
      );
    }
    // Explicit pass so the test reports green.
    expect(drift).toEqual([]);
  });

  it('detects synthetic drift correctly (sanity check)', () => {
    // The drift check uses an injected providers list — pass it a
    // catalog where openai is missing 'tts' (which it actually has in
    // the real catalog) and confirm the function flags the
    // openai-tts adapter as a problem. Catches regressions in the
    // drift-detection logic itself.
    const broken = SUPPORTED_PROVIDERS.map((p) =>
      p.id === 'openai' ? { ...p, capabilities: p.capabilities.filter((c) => c !== 'tts') } : p,
    );
    const drift = findAdapterCatalogDrift(broken);
    // openai-tts is registered AND openai is now missing 'tts' from
    // its capabilities → must be flagged.
    expect(drift.some((m) => m.includes('openai-tts'))).toBe(true);
    expect(drift.some((m) => m.includes("'tts'"))).toBe(true);
  });

  it('flags an adapter whose providerId is not in the catalog at all', () => {
    // The other failure mode: an adapter for an unknown provider.
    // Shouldn't happen but lock down the diagnostic.
    const truncated = SUPPORTED_PROVIDERS.filter((p) => p.id !== 'openai');
    const drift = findAdapterCatalogDrift(truncated);
    expect(drift.some((m) => m.includes("'openai'"))).toBe(true);
    expect(drift.some((m) => m.includes('not in SUPPORTED_PROVIDERS'))).toBe(true);
  });
});
