/**
 * Tests for the canonical providers catalog.
 *
 * Why these tests exist: the `api_keys.service` column and
 * `ai_workers.provider` column are free text that the runtime
 * dispatch matches by exact string. Once a value is persisted, the
 * UI catalog and the runtime have to agree forever — renaming
 * 'openai' to 'open-ai' would orphan every saved key. These tests
 * lock the ids so a rename is loud at PR time.
 *
 * Tests also catch the easy mistakes: capability mismatches (an STT
 * provider without 'stt' in its capabilities), missing signup/docs
 * URLs (the UI uses them as links), the kind→capability map
 * accidentally drifting from the ai_workers.kind enum.
 */

import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_FOR_KIND,
  SUPPORTED_PROVIDERS,
  getProvider,
  isProviderId,
  providersForCapability,
} from './providers';

describe('SUPPORTED_PROVIDERS catalog', () => {
  it('lists openrouter first (default chat path)', () => {
    // Catalog order = dropdown order. OpenRouter is the entry-point
    // for new users; if it slips down the list, the UX gets worse.
    expect(SUPPORTED_PROVIDERS[0]?.id).toBe('openrouter');
  });

  it('lists openai second (required audio path)', () => {
    // OpenAI is the only provider currently catalogued for TTS/STT, so it
    // should be the second option new users see.
    expect(SUPPORTED_PROVIDERS[1]?.id).toBe('openai');
  });

  it('every provider has a non-empty label, description, signupUrl, docsUrl', () => {
    // Each of these is rendered in the UI. Missing values produce
    // a broken-looking row, so we lock them down.
    for (const p of SUPPORTED_PROVIDERS) {
      expect(p.label.length, `${p.id}.label`).toBeGreaterThan(0);
      expect(p.description.length, `${p.id}.description`).toBeGreaterThan(20);
      expect(p.signupUrl.startsWith('http'), `${p.id}.signupUrl`).toBe(true);
      expect(p.docsUrl.startsWith('http'), `${p.id}.docsUrl`).toBe(true);
    }
  });

  it('every provider declares at least one capability', () => {
    for (const p of SUPPORTED_PROVIDERS) {
      expect(p.capabilities.length, `${p.id} should have ≥1 capability`).toBeGreaterThan(0);
    }
  });

  it('ids are unique', () => {
    // A duplicate id would silently shadow the earlier entry, breaking
    // the canonical lookup. Lock it down.
    const ids = SUPPORTED_PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('the providers catalogued for audio (tts/stt) include openai', () => {
    // OpenAI is the only currently-catalogued audio provider. If a refactor
    // drops it from the catalogue, voice in/out goes dark.
    expect(providersForCapability('tts').some((p) => p.id === 'openai')).toBe(true);
    expect(providersForCapability('stt').some((p) => p.id === 'openai')).toBe(true);
  });

  it('openrouter is in chat but NOT in tts/stt (it does not proxy audio)', () => {
    // Documenting the actual constraint: OpenRouter aggregates chat
    // and embeddings but not the audio APIs. UI filter relies on
    // this — saving an OpenRouter key against a TTS worker would
    // produce silent failures.
    const or = getProvider('openrouter')!;
    expect(or.capabilities).toContain('chat');
    expect(or.capabilities).not.toContain('tts');
    expect(or.capabilities).not.toContain('stt');
  });
});

describe('providersForCapability', () => {
  it('returns providers in catalog order', () => {
    // The dropdown reads in this order. We want openrouter at the top
    // for chat, openai at the top for tts/stt.
    const chat = providersForCapability('chat');
    expect(chat[0]?.id).toBe('openrouter');
    const tts = providersForCapability('tts');
    expect(tts[0]?.id).toBe('openai');
    const stt = providersForCapability('stt');
    expect(stt[0]?.id).toBe('openai');
  });

  it('returns ONLY providers that declared the capability', () => {
    // Defensive: catch any future provider that has the capability
    // in its description but forgot to list it in `capabilities`.
    for (const p of providersForCapability('tts')) {
      expect(p.capabilities, `${p.id} listed as tts-capable`).toContain('tts');
    }
    for (const p of providersForCapability('image_gen')) {
      expect(p.capabilities, `${p.id} listed as image_gen-capable`).toContain('image_gen');
    }
  });
});

describe('getProvider / isProviderId', () => {
  it('looks up by id', () => {
    expect(getProvider('openai')?.label).toBe('OpenAI');
    expect(getProvider('openrouter')?.label).toBe('OpenRouter');
  });

  it('returns null for unknown ids (no nil-throwing)', () => {
    // The api_keys.service column accepts any string, so legacy rows
    // or hand-edited DBs can carry ids we don't know about. We must
    // not crash the page on those.
    expect(getProvider('made-up-provider')).toBeNull();
  });

  it('isProviderId narrows correctly', () => {
    expect(isProviderId('openai')).toBe(true);
    expect(isProviderId('openrouter')).toBe(true);
    expect(isProviderId('made-up-provider')).toBe(false);
    expect(isProviderId('')).toBe(false);
  });
});

describe('CAPABILITY_FOR_KIND map', () => {
  it('covers every ai_workers.kind value', () => {
    // The ai_workers.kind enum and this map must stay in sync —
    // otherwise the worker form for a new kind has no provider
    // dropdown filter and shows ALL providers.
    const kinds = [
      'reflector',
      'extractor',
      'summarizer',
      'tts',
      'stt',
      'vision',
      'image_gen',
    ];
    for (const k of kinds) {
      expect(CAPABILITY_FOR_KIND[k], `kind '${k}' has no capability mapping`).toBeTruthy();
    }
  });

  it('chat-shaped workers map to the chat capability', () => {
    // reflector, extractor, summarizer all make chat-completion calls.
    expect(CAPABILITY_FOR_KIND.reflector).toBe('chat');
    expect(CAPABILITY_FOR_KIND.extractor).toBe('chat');
    expect(CAPABILITY_FOR_KIND.summarizer).toBe('chat');
  });

  it('media-shaped workers map to their own capability', () => {
    expect(CAPABILITY_FOR_KIND.tts).toBe('tts');
    expect(CAPABILITY_FOR_KIND.stt).toBe('stt');
    expect(CAPABILITY_FOR_KIND.vision).toBe('vision');
    expect(CAPABILITY_FOR_KIND.image_gen).toBe('image_gen');
  });
});
