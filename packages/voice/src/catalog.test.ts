/**
 * Tests for the static TTS/STT catalogue.
 *
 * Why these tests exist: the catalogue is hand-maintained (OpenAI has
 * no `/v1/audio/voices` endpoint) and feeds the agent-settings UI. If
 * a model→voices mapping is wrong, the dropdown shows voices that
 * the API will refuse at runtime. These tests lock down the
 * documented model/voice combinations as of May 2026 so a typo or
 * accidental drop is caught at PR time, not at the next voice
 * message.
 *
 * The DISCOVERY layer (live `/v1/models` filtering) is integration-
 * shaped — it needs a real OpenAI key — so it's not tested here.
 */

import { describe, expect, it } from 'vitest';
import {
  ALL_OPENAI_VOICES,
  OPENAI_STT_MODELS,
  OPENAI_TTS_MODELS,
  VOICE_DESCRIPTIONS,
  getSttModel,
  getTtsModel,
  isOpenAiVoice,
  voicesForModel,
} from './catalog';

describe('OPENAI_TTS_MODELS', () => {
  it('contains all currently-published TTS models', () => {
    const ids = OPENAI_TTS_MODELS.map((m) => m.id);
    // Lock down the exact set so a model rename or drop is loud.
    expect(new Set(ids)).toEqual(
      new Set(['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd']),
    );
  });

  it('lists gpt-4o-mini-tts first (recommended)', () => {
    // The UI relies on catalog order — gpt-4o-mini-tts is the
    // recommended default, so it must lead the dropdown.
    expect(OPENAI_TTS_MODELS[0]?.id).toBe('gpt-4o-mini-tts');
  });

  it('marks gpt-4o-mini-tts as the only model supporting instructions', () => {
    // `instructions` is the "speak warmly" style-steering parameter.
    // It's silently ignored by tts-1 / tts-1-hd; the UI greys out the
    // input when those models are selected, so this flag must be
    // accurate.
    const flags = Object.fromEntries(
      OPENAI_TTS_MODELS.map((m) => [m.id, m.supportsInstructions]),
    );
    expect(flags['gpt-4o-mini-tts']).toBe(true);
    expect(flags['tts-1']).toBe(false);
    expect(flags['tts-1-hd']).toBe(false);
  });

  it('gpt-4o-mini-tts ships the full 13 voices', () => {
    const m = getTtsModel('gpt-4o-mini-tts');
    expect(m).not.toBeNull();
    expect(m!.voices.length).toBe(13);
    // The signature additions over tts-1 must be present.
    expect(m!.voices).toContain('ballad');
    expect(m!.voices).toContain('verse');
    expect(m!.voices).toContain('marin');
    expect(m!.voices).toContain('cedar');
  });

  it('tts-1 and tts-1-hd ship the same 9 voices (no instructions support)', () => {
    const a = getTtsModel('tts-1');
    const b = getTtsModel('tts-1-hd');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.voices.length).toBe(9);
    expect(b!.voices.length).toBe(9);
    expect(new Set(a!.voices)).toEqual(new Set(b!.voices));
    // The expansion-only voices must NOT be in the older models.
    for (const exp of ['ballad', 'verse', 'marin', 'cedar']) {
      expect(a!.voices).not.toContain(exp);
      expect(b!.voices).not.toContain(exp);
    }
  });
});

describe('OPENAI_STT_MODELS', () => {
  it('contains whisper-1 + the gpt-4o transcription variants', () => {
    const ids = OPENAI_STT_MODELS.map((m) => m.id);
    expect(new Set(ids)).toEqual(
      new Set(['whisper-1', 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe']),
    );
  });

  it('lists whisper-1 first (stable, cheapest)', () => {
    // We default to whisper-1 for new STT workers because it's the
    // longest-stable variant. Catalog order drives that default.
    expect(OPENAI_STT_MODELS[0]?.id).toBe('whisper-1');
  });
});

describe('voicesForModel', () => {
  it('returns the model-specific voice list with descriptions', () => {
    const voices = voicesForModel('gpt-4o-mini-tts');
    expect(voices.length).toBe(13);
    const nova = voices.find((v) => v.id === 'nova');
    expect(nova?.description).toContain('Saskia');
  });

  it('returns 9 voices for tts-1', () => {
    expect(voicesForModel('tts-1').length).toBe(9);
  });

  it('returns an empty array for an unknown model (caller decides fallback)', () => {
    // If the operator types a custom model id (e.g. a fine-tuned one),
    // we don't have a voice list. Return [] and let the caller decide
    // whether to fall back to the full catalogue or refuse.
    expect(voicesForModel('made-up-model')).toEqual([]);
  });
});

describe('isOpenAiVoice', () => {
  it('accepts every voice in ALL_OPENAI_VOICES', () => {
    for (const v of ALL_OPENAI_VOICES) {
      expect(isOpenAiVoice(v)).toBe(true);
    }
  });

  it('rejects typos and unknown names', () => {
    expect(isOpenAiVoice('novah')).toBe(false);
    expect(isOpenAiVoice('Nova')).toBe(false);
    expect(isOpenAiVoice('')).toBe(false);
  });
});

describe('VOICE_DESCRIPTIONS', () => {
  it('has a description for every voice in ALL_OPENAI_VOICES (no gaps)', () => {
    // The UI dropdown reads from this; a missing entry would render
    // as "voice — undefined" and look broken.
    for (const v of ALL_OPENAI_VOICES) {
      expect(VOICE_DESCRIPTIONS[v]).toBeTruthy();
      expect(VOICE_DESCRIPTIONS[v]?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe('getSttModel / getTtsModel', () => {
  it('returns null for unknown ids (no nil-throwing)', () => {
    expect(getTtsModel('tts-99')).toBeNull();
    expect(getSttModel('whisper-99')).toBeNull();
  });
});
