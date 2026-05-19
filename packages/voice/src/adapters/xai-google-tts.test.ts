/**
 * Tests for the xAI Grok TTS + Google Gemini TTS adapters.
 *
 * Both providers ship inline audio tags; the catalogs lock down the
 * documented tag sets and the adapter contract. HTTP calls need real
 * keys and are exercised via integration.
 */

import { describe, expect, it } from 'vitest';
import {
  GOOGLE_AUDIO_TAGS,
  GOOGLE_TTS_MODELS,
  GOOGLE_TTS_VOICES,
  XAI_AUDIO_TAGS,
  XAI_TTS_MODEL_ID,
  XAI_TTS_VOICES,
  audioTagsForGoogleTtsModel,
  audioTagsForXaiTtsModel,
  getTtsAdapter,
  googleTtsAdapter,
  isProviderWired,
  xaiTtsAdapter,
} from './index';

describe('xAI TTS adapter', () => {
  it('self-registers on import', () => {
    const a = getTtsAdapter('xai');
    expect(a).not.toBeNull();
    expect(a?.adapterName).toBe('xai-tts');
    expect(a).toBe(xaiTtsAdapter);
  });

  it('is reported wired for tts by isProviderWired', () => {
    expect(isProviderWired('xai', 'tts')).toBe(true);
  });

  it('has the documented 5 voices (eve, ara, rex, sal, leo)', () => {
    const ids = XAI_TTS_VOICES.map((v) => v.id);
    expect(new Set(ids)).toEqual(new Set(['eve', 'ara', 'rex', 'sal', 'leo']));
  });

  it('eve is the default voice (first in the catalog)', () => {
    // Adapter falls back to the first voice when none specified;
    // the launch blog calls out eve as the default.
    expect(XAI_TTS_VOICES[0]?.id).toBe('eve');
  });

  it("exposes the documented inline tags ([laugh], [giggle], [sigh] ...)", () => {
    const tagSet = new Set(XAI_AUDIO_TAGS.map((t) => t.tag));
    // The headline ones the user actually asked about when proposing
    // this feature must be present.
    expect(tagSet.has('[laugh]')).toBe(true);
    expect(tagSet.has('[chuckle]')).toBe(true);
    expect(tagSet.has('[giggle]')).toBe(true);
    expect(tagSet.has('[sigh]')).toBe(true);
    // Pacing.
    expect(tagSet.has('[pause]')).toBe(true);
    expect(tagSet.has('[long-pause]')).toBe(true);
    // Breath.
    expect(tagSet.has('[breath]')).toBe(true);
    expect(tagSet.has('[inhale]')).toBe(true);
    expect(tagSet.has('[exhale]')).toBe(true);
  });

  it('audioTagsForXaiTtsModel returns tags for the published model id', () => {
    expect(audioTagsForXaiTtsModel(XAI_TTS_MODEL_ID).length).toBe(XAI_AUDIO_TAGS.length);
    expect(audioTagsForXaiTtsModel('grok-voice').length).toBe(XAI_AUDIO_TAGS.length);
  });

  it('audioTagsForXaiTtsModel returns empty for unknown models', () => {
    expect(audioTagsForXaiTtsModel('grok-imaginary-model-9000')).toEqual([]);
  });

  it('adapter exposes supportedAudioTags hook returning the catalog', () => {
    expect(xaiTtsAdapter.supportedAudioTags?.(XAI_TTS_MODEL_ID).length).toBe(
      XAI_AUDIO_TAGS.length,
    );
    expect(xaiTtsAdapter.supportedAudioTags?.('not-a-real-model')).toEqual([]);
  });
});

describe('Google (Gemini) TTS adapter', () => {
  it('self-registers on import', () => {
    const a = getTtsAdapter('google');
    expect(a).not.toBeNull();
    expect(a?.adapterName).toBe('google-tts');
    expect(a).toBe(googleTtsAdapter);
  });

  it('is reported wired for tts by isProviderWired', () => {
    expect(isProviderWired('google', 'tts')).toBe(true);
  });

  it('catalogs both Flash and Pro TTS variants', () => {
    expect(GOOGLE_TTS_MODELS).toContain('gemini-2.5-flash-preview-tts');
    expect(GOOGLE_TTS_MODELS).toContain('gemini-2.5-pro-preview-tts');
  });

  it('ships all 30 Gemini voices', () => {
    // Lock the count low — guarantees we shipped a reasonable set.
    // Gemini publishes 30 prebuilt voices as of May 2026.
    expect(GOOGLE_TTS_VOICES.length).toBe(30);
  });

  it('includes the recommended voices (Kore default, plus Puck/Zephyr/etc.)', () => {
    const ids = new Set(GOOGLE_TTS_VOICES.map((v) => v.id));
    expect(ids.has('Kore')).toBe(true);
    expect(ids.has('Puck')).toBe(true);
    expect(ids.has('Zephyr')).toBe(true);
    expect(ids.has('Charon')).toBe(true);
    expect(ids.has('Fenrir')).toBe(true);
  });

  it("exposes inline tags including [whispers] and [laughs] (documented examples)", () => {
    const tagSet = new Set(GOOGLE_AUDIO_TAGS.map((t) => t.tag));
    // The two tags explicitly named in Gemini's docs.
    expect(tagSet.has('[whispers]')).toBe(true);
    expect(tagSet.has('[laughs]')).toBe(true);
    // The natural extension set we ship for parity with ElevenLabs.
    expect(tagSet.has('[sighs]')).toBe(true);
    expect(tagSet.has('[gasps]')).toBe(true);
    expect(tagSet.has('[pauses]')).toBe(true);
  });

  it('audioTagsForGoogleTtsModel returns tags for both 2.5 TTS variants', () => {
    expect(audioTagsForGoogleTtsModel('gemini-2.5-flash-preview-tts').length).toBe(
      GOOGLE_AUDIO_TAGS.length,
    );
    expect(audioTagsForGoogleTtsModel('gemini-2.5-pro-preview-tts').length).toBe(
      GOOGLE_AUDIO_TAGS.length,
    );
  });

  it('audioTagsForGoogleTtsModel returns empty for non-TTS Gemini models', () => {
    // The chat Gemini models share the same /v1beta/models endpoint
    // but don't accept audio responseModalities. They must NOT match.
    expect(audioTagsForGoogleTtsModel('gemini-3.1-pro-preview')).toEqual([]);
    expect(audioTagsForGoogleTtsModel('gemini-2.5-flash')).toEqual([]);
  });

  it('adapter exposes supportedAudioTags hook returning the catalog', () => {
    expect(
      googleTtsAdapter.supportedAudioTags?.('gemini-2.5-flash-preview-tts').length,
    ).toBe(GOOGLE_AUDIO_TAGS.length);
    expect(googleTtsAdapter.supportedAudioTags?.('made-up-model')).toEqual([]);
  });
});
