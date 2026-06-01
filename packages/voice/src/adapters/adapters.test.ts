/**
 * Tests for the adapter registry. The actual HTTP-calling work in
 * each adapter (synthesize/transcribe) needs a real API key to test
 * end-to-end and is exercised via integration; here we lock down
 * the registry contract that production code depends on:
 *
 *   1. Built-in adapters self-register when @mantle/voice is imported.
 *   2. `getTtsAdapter('openai')` returns a non-null dispatcher with
 *      the right providerId + adapterName.
 *   3. `isProviderWired` reflects what's actually in the registry.
 *   4. Looking up an unknown provider returns null (no nil-throw).
 *   5. A registered adapter can be re-registered (used by tests + by
 *      runtime hot-swaps if we ever build them).
 */

import { describe, expect, it } from 'vitest';
import { SUPPORTED_PROVIDERS, getProvider } from '../providers';
import {
  getSttAdapter,
  getTtsAdapter,
  isProviderWired,
  listSttAdapters,
  listTtsAdapters,
  openAiSttAdapter,
  openAiTtsAdapter,
  registerTtsAdapter,
  wiredCapabilitiesFor,
  type TtsDispatcher,
} from './index';

describe('built-in adapter self-registration', () => {
  it('registers openai-tts on import', () => {
    const a = getTtsAdapter('openai');
    expect(a).not.toBeNull();
    expect(a?.providerId).toBe('openai');
    expect(a?.adapterName).toBe('openai-tts');
    // The adapter object is the same singleton exported from the
    // module — both routes (registry lookup, direct import) hand
    // back the same reference, so monkey-patching for tests is
    // consistent.
    expect(a).toBe(openAiTtsAdapter);
  });

  it('registers openai-stt on import', () => {
    const a = getSttAdapter('openai');
    expect(a).not.toBeNull();
    expect(a?.providerId).toBe('openai');
    expect(a?.adapterName).toBe('openai-stt');
    expect(a).toBe(openAiSttAdapter);
  });

  it('lists at least one adapter per built-in capability', () => {
    expect(listTtsAdapters().length).toBeGreaterThan(0);
    expect(listSttAdapters().length).toBeGreaterThan(0);
  });
});

describe('isProviderWired', () => {
  it('returns true for openai+tts (built-in)', () => {
    expect(isProviderWired('openai', 'tts')).toBe(true);
  });

  it('returns true for openai+stt (built-in)', () => {
    expect(isProviderWired('openai', 'stt')).toBe(true);
  });

  it('returns true for the wired STT providers', () => {
    // After the May 2026 STT expansion the catalog and registry both
    // declare these. If we ever unwire one, this assertion breaks
    // loudly and we update it (or the underlying bug).
    expect(isProviderWired('openai', 'stt')).toBe(true);
    expect(isProviderWired('xai', 'stt')).toBe(true);
    expect(isProviderWired('elevenlabs', 'stt')).toBe(true);
    expect(isProviderWired('deepgram', 'stt')).toBe(true);
    expect(isProviderWired('assemblyai', 'stt')).toBe(true);
    expect(isProviderWired('google', 'stt')).toBe(true);
  });

  it('returns false for catalogued-but-unwired (provider, capability) pairs', () => {
    // Hugging Face declares 'stt' in capabilities but we haven't
    // shipped a HF STT adapter yet — UI shows the "not yet wired"
    // hint. If/when we wire it, this assertion breaks loudly.
    expect(isProviderWired('huggingface', 'stt')).toBe(false);
  });

  it('returns false for completely unknown providers', () => {
    // Defensive — a free-text value in api_keys.service mustn't crash
    // the page.
    expect(isProviderWired('made-up-provider', 'tts')).toBe(false);
  });

  it('returns false for declared-but-not-registered capability (the Mistral/Cohere chat case)', () => {
    // Both providers' catalog entries claim 'chat' capability, but
    // neither has a chat adapter registered today (only embedding
    // is wired). This is exactly the partial-wired pattern the
    // api-keys form's wiredCapabilitiesFor helper exists to surface.
    expect(isProviderWired('mistral', 'chat')).toBe(false);
    expect(isProviderWired('mistral', 'embedding')).toBe(true);
    expect(isProviderWired('cohere', 'chat')).toBe(false);
    expect(isProviderWired('cohere', 'embedding')).toBe(true);
  });

  it('treats openrouter + openai as chat-wired by convention', () => {
    // Post-Phase-3, every chat provider routes through the adapter
    // registry. openrouter has a real openrouter-chat adapter.
    // OpenAI is NOT chat-wired: there's no direct openai-chat adapter —
    // OpenAI chat is reached via the openrouter provider with an
    // `openai/*` model. Surfacing it as wired only produced an empty
    // model dropdown, so isProviderWired reports it honestly as not wired.
    expect(isProviderWired('openrouter', 'chat')).toBe(true);
    expect(isProviderWired('openai', 'chat')).toBe(false);
    // Deepgram is STT-only — its catalog doesn't declare chat at all.
    expect(isProviderWired('deepgram', 'chat')).toBe(false);
  });
});

describe('registerTtsAdapter', () => {
  it('can register a custom adapter at runtime (used for tests + future hot-swaps)', () => {
    const fake: TtsDispatcher = {
      providerId: 'huggingface' as const,
      adapterName: 'hf-test',
      async synthesize() {
        return {
          bytes: Buffer.from('fake'),
          mimeType: 'audio/mpeg',
          voice: 'nova',
          model: 'fake',
        };
      },
    };
    registerTtsAdapter(fake);
    expect(getTtsAdapter('huggingface')).toBe(fake);
    expect(isProviderWired('huggingface', 'tts')).toBe(true);
  });
});

describe('adapter unknown lookup', () => {
  it('returns null (not undefined, not throw) for unknown providers', () => {
    expect(getTtsAdapter('not-a-provider')).toBeNull();
    expect(getSttAdapter('not-a-provider')).toBeNull();
  });
});

describe('wiredCapabilitiesFor', () => {
  it('splits Mistral capabilities into wired=[embedding], unwired=[chat]', () => {
    const mistral = getProvider('mistral')!;
    const { wired, unwired } = wiredCapabilitiesFor(mistral);
    expect(wired).toEqual(['embedding']);
    expect(unwired).toEqual(['chat']);
  });

  it('splits Cohere the same way (chat declared but not wired)', () => {
    const cohere = getProvider('cohere')!;
    const { wired, unwired } = wiredCapabilitiesFor(cohere);
    expect(wired).toEqual(['embedding']);
    expect(unwired).toEqual(['chat']);
  });

  it('returns all capabilities as wired for a fully-implemented provider', () => {
    // Deepgram declares only stt and has the adapter — nothing unwired.
    const deepgram = getProvider('deepgram')!;
    const { wired, unwired } = wiredCapabilitiesFor(deepgram);
    expect(wired).toEqual(['stt']);
    expect(unwired).toEqual([]);
  });

  it('preserves the catalog declaration order, splitting out unwired chat', () => {
    // OpenAI's catalog lists ['chat', 'embedding', 'tts', 'stt', 'vision', 'image_gen'].
    // Everything but chat is wired (chat has no direct adapter → via OpenRouter),
    // and the wired list preserves the catalog's declaration order so the UI
    // renders a stable list across renders.
    const openai = getProvider('openai')!;
    const { wired, unwired } = wiredCapabilitiesFor(openai);
    expect(wired).toEqual(['embedding', 'tts', 'stt', 'vision', 'image_gen']);
    expect(unwired).toEqual(['chat']);
  });

  it('every provider in SUPPORTED_PROVIDERS has at least one wired capability', () => {
    // Sanity check on the catalog: a fully-unwired provider would show
    // as "— not yet wired" in the api-keys form, which is a placeholder
    // state we shouldn't ship to production. If this test ever fails,
    // either ship the adapter or pull the provider from the catalog.
    for (const p of SUPPORTED_PROVIDERS) {
      const { wired } = wiredCapabilitiesFor(p);
      expect(
        wired.length,
        `provider '${p.id}' is catalogued but has no registered adapter`,
      ).toBeGreaterThan(0);
    }
  });
});
