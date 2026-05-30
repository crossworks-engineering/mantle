/**
 * Tests for the Anthropic, Google, and ElevenLabs adapters.
 *
 * The HTTP-calling code needs real keys and is exercised in
 * integration. Here we lock down the structural contract that
 * production depends on:
 *
 *   1. All three adapters self-register on import.
 *   2. Static catalogs contain the headline models we'd defend in
 *      review.
 *   3. ElevenLabs output-format mapping is correct (Telegram-native
 *      MIME comes back as audio/ogg).
 *   4. `isProviderWired` reflects the new registrations.
 */

import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_CHAT_MODELS,
  ELEVENLABS_PREMADE_VOICES,
  ELEVENLABS_TTS_MODELS,
  GOOGLE_CHAT_MODELS,
  anthropicChatAdapter,
  elevenLabsTtsAdapter,
  getChatAdapter,
  getTtsAdapter,
  googleChatAdapter,
  isProviderWired,
  mimeForElevenLabsFormat,
} from './index';

describe('Anthropic chat adapter', () => {
  it('self-registers on import', () => {
    const a = getChatAdapter('anthropic');
    expect(a).not.toBeNull();
    expect(a?.adapterName).toBe('anthropic-chat');
    // getChatAdapter returns a retry-wrapped dispatcher for direct providers
    // (not the raw export ref), so assert resolution by identity, not ===.
    expect(a?.providerId).toBe(anthropicChatAdapter.providerId);
  });

  it('is reported wired for chat by isProviderWired', () => {
    expect(isProviderWired('anthropic', 'chat')).toBe(true);
  });

  it("catalog contains current generation models (4.6/4.7)", () => {
    const ids = ANTHROPIC_CHAT_MODELS.map((m) => m.id);
    expect(ids).toContain('claude-opus-4-7');
    expect(ids).toContain('claude-sonnet-4-6');
    expect(ids).toContain('claude-haiku-4-5');
  });

  it('every Claude model declares vision capability', () => {
    // Per the docs ("all current Claude models support text and image
    // input"), every catalog entry must include vision so the UI
    // shows the right capability badge.
    for (const m of ANTHROPIC_CHAT_MODELS) {
      expect(m.capabilities, `${m.id} should include vision`).toContain('vision');
    }
  });

  it('exposes static catalog through the hook', () => {
    expect(anthropicChatAdapter.staticCatalog?.()).toBe(ANTHROPIC_CHAT_MODELS);
  });
});

describe('Google (Gemini) chat adapter', () => {
  it('self-registers on import', () => {
    const a = getChatAdapter('google');
    expect(a).not.toBeNull();
    expect(a?.adapterName).toBe('google-chat');
    expect(a?.providerId).toBe(googleChatAdapter.providerId);
  });

  it('is reported wired for chat by isProviderWired', () => {
    expect(isProviderWired('google', 'chat')).toBe(true);
  });

  it('catalog includes both 3.x and 2.5 model families', () => {
    const ids = GOOGLE_CHAT_MODELS.map((m) => m.id);
    expect(ids.some((id) => id.startsWith('gemini-3'))).toBe(true);
    expect(ids.some((id) => id.startsWith('gemini-2.5'))).toBe(true);
  });

  it('every Gemini model declares vision capability', () => {
    // Gemini is multimodal across the board; vision is the
    // baseline. Catch any entry that forgot to set it.
    for (const m of GOOGLE_CHAT_MODELS) {
      expect(m.capabilities, `${m.id} should include vision`).toContain('vision');
    }
  });
});

describe('ElevenLabs TTS adapter', () => {
  it('self-registers on import', () => {
    const a = getTtsAdapter('elevenlabs');
    expect(a).not.toBeNull();
    expect(a?.adapterName).toBe('elevenlabs-tts');
    expect(a).toBe(elevenLabsTtsAdapter);
  });

  it('is reported wired for tts by isProviderWired', () => {
    expect(isProviderWired('elevenlabs', 'tts')).toBe(true);
  });

  it('catalog includes the headline models', () => {
    const ids = ELEVENLABS_TTS_MODELS.map((m) => m.id);
    expect(ids).toContain('eleven_v3');
    expect(ids).toContain('eleven_multilingual_v2');
    expect(ids).toContain('eleven_turbo_v2_5');
    expect(ids).toContain('eleven_flash_v2_5');
  });

  it('exposes voicesForModel (lets the UI fetch live + cloned voices)', () => {
    // We don't actually call it (it would hit the network), but the
    // capability flag must be set so the UI knows to use the live
    // path instead of falling back to the OpenAI static catalog.
    expect(typeof elevenLabsTtsAdapter.voicesForModel).toBe('function');
  });

  it('exposes discoverModels', () => {
    expect(typeof elevenLabsTtsAdapter.discoverModels).toBe('function');
  });

  it('ships at least a fallback list of premade voices', () => {
    // The static fallback kicks in when /v1/voices isn't reachable.
    // It must include at least a handful so the dropdown isn't empty.
    expect(ELEVENLABS_PREMADE_VOICES.length).toBeGreaterThan(3);
  });
});

describe('mimeForElevenLabsFormat', () => {
  it('maps opus to audio/ogg (Telegram-native)', () => {
    // The single most important mapping — if this is wrong, Telegram
    // refuses sendVoice on the ElevenLabs output.
    expect(mimeForElevenLabsFormat('opus_48000_64')).toBe('audio/ogg');
    expect(mimeForElevenLabsFormat('opus_48000_128')).toBe('audio/ogg');
  });

  it('maps mp3 / wav / pcm to their conventional MIMEs', () => {
    expect(mimeForElevenLabsFormat('mp3_44100_128')).toBe('audio/mpeg');
    expect(mimeForElevenLabsFormat('wav_44100')).toBe('audio/wav');
    expect(mimeForElevenLabsFormat('pcm_16000')).toBe('audio/pcm');
  });

  it('falls back to octet-stream for unknown formats', () => {
    expect(mimeForElevenLabsFormat('mystery_format')).toBe('application/octet-stream');
  });
});
