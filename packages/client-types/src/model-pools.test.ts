/**
 * Pool/model fit. Pins the 2026-09-02 bug: the shipped vision ("Read images")
 * pool carried Nano Banana Pro, an image GENERATOR. Generators accept image
 * input exactly like readers do, so nothing on the input side caught it —
 * the model billed image-generation tokens and returned a picture where the
 * vision worker wanted text.
 */
import { describe, expect, it } from 'vitest';
import { MODEL_POOLS, poolModelIssue, kindFromModalities } from './model-pools';
import { CURATED_MODEL_POOLS } from './model-pools-data';

const READER = { input: ['text', 'image'], output: ['text'] };
const GENERATOR = { input: ['image', 'text'], output: ['image', 'text'] };
const TEXT_ONLY = { input: ['text'], output: ['text'] };
// The voice shapes, verbatim from OpenRouter's catalog once the fetch asks
// for `output_modalities=all`: dedicated engines on either side, plus the
// speech-capable chat model that legitimately serves BOTH voice pools.
const TTS_ENGINE = { input: ['text'], output: ['speech'] };
const STT_ENGINE = { input: ['audio'], output: ['transcription'] };
const AUDIO_CHAT = { input: ['text', 'audio'], output: ['text', 'audio'] };

describe('poolModelIssue', () => {
  it('keeps an image generator out of the vision pool', () => {
    expect(poolModelIssue('vision', GENERATOR)).toMatch(/OUTPUTS images/);
  });

  it('allows a real image reader in the vision pool', () => {
    expect(poolModelIssue('vision', READER)).toBeNull();
  });

  it('keeps a blind model out of the vision pool', () => {
    expect(poolModelIssue('vision', TEXT_ONLY)).toMatch(/does not accept image input/);
  });

  it('keeps an image generator out of every text-out pool', () => {
    for (const pool of MODEL_POOLS.filter((p) => p.modality.output === 'text')) {
      expect(poolModelIssue(pool.id, GENERATOR), pool.id).toMatch(/OUTPUTS images/);
    }
  });

  it('wants a generator in the image_gen pool, and nothing else', () => {
    expect(poolModelIssue('image_gen', GENERATOR)).toBeNull();
    expect(poolModelIssue('image_gen', READER)).toMatch(/does not output images/);
  });

  it('keeps every other non-text output out of a text-out pool', () => {
    expect(poolModelIssue('summarizer', TTS_ENGINE)).toMatch(/outputs speech, not text/);
    expect(poolModelIssue('agents', STT_ENGINE)).toMatch(/outputs transcription, not text/);
    expect(poolModelIssue('extractor', { input: ['text'], output: ['embeddings'] })).toMatch(
      /outputs embeddings, not text/,
    );
  });

  it('checks the voice pools now that the catalog lists their engines', () => {
    expect(poolModelIssue('tts', TTS_ENGINE)).toBeNull();
    expect(poolModelIssue('stt', STT_ENGINE)).toBeNull();
    // The classic swap, which used to sail through unchecked.
    expect(poolModelIssue('tts', STT_ENGINE)).toMatch(/produces no audio/);
    expect(poolModelIssue('stt', TTS_ENGINE)).toMatch(/does not turn audio into text/);
    expect(poolModelIssue('tts', TEXT_ONLY)).toMatch(/produces no audio/);
  });

  it('accepts a speech-capable chat model in both voice pools (gpt-audio)', () => {
    expect(poolModelIssue('tts', AUDIO_CHAT)).toBeNull();
    expect(poolModelIssue('stt', AUDIO_CHAT)).toBeNull();
  });

  it('still fails open for the direct-provider voice slugs OpenRouter never lists', () => {
    // ElevenLabs, Deepgram, Gemini voices: no catalog row, so no evidence.
    expect(poolModelIssue('tts', { input: [], output: [] })).toBeNull();
    expect(poolModelIssue('stt', null)).toBeNull();
  });

  it('fails OPEN on an unloaded catalog and on an unknown pool', () => {
    expect(poolModelIssue('vision', null)).toBeNull();
    expect(poolModelIssue('vision', { input: [], output: [] })).toBeNull();
    expect(poolModelIssue('not-a-pool', GENERATOR)).toBeNull();
  });
});

describe('kindFromModalities', () => {
  it('reads the bucket off the catalog instead of guessing from the slug', () => {
    expect(kindFromModalities(['transcription'])).toBe('stt');
    expect(kindFromModalities(['speech'])).toBe('tts');
    expect(kindFromModalities(['embeddings'])).toBe('embedding');
    expect(kindFromModalities(['rerank'])).toBe('rerank');
    expect(kindFromModalities(['video'])).toBe('video');
    expect(kindFromModalities(['image', 'text'])).toBe('image');
    expect(kindFromModalities(['text'])).toBe('chat');
    expect(kindFromModalities([])).toBe('chat');
  });

  it('separates a speech-capable chat model from a sound generator', () => {
    // openai/gpt-audio: text+audio->text+audio, still a chat model.
    expect(kindFromModalities(['text', 'audio'])).toBe('chat');
    // google/lyria-*: audio out only.
    expect(kindFromModalities(['audio'])).toBe('audio');
  });

  it('agrees with the pool contract it sits beside', () => {
    // A model this bucket calls 'tts' must be one the tts pool accepts, or
    // the /models filter and the curation guard would tell different stories.
    const tts = { input: ['text'], output: ['speech'] };
    expect(kindFromModalities(tts.output)).toBe('tts');
    expect(poolModelIssue('tts', tts)).toBeNull();
    const stt = { input: ['audio'], output: ['transcription'] };
    expect(kindFromModalities(stt.output)).toBe('stt');
    expect(poolModelIssue('stt', stt)).toBeNull();
  });
});

describe('the shipped curated template', () => {
  const slugs = (pool: string) =>
    new Set(
      CURATED_MODEL_POOLS.filter((e) => e.pool === pool).flatMap((e) =>
        e.routes.map((r) => r.model),
      ),
    );

  it('never lists the same model as both an image reader and an image generator', () => {
    const overlap = [...slugs('vision')].filter((s) => slugs('image_gen').has(s));
    expect(overlap).toEqual([]);
  });

  it('gives every pool contiguous positions from 0', () => {
    for (const pool of MODEL_POOLS) {
      const positions = CURATED_MODEL_POOLS.filter((e) => e.pool === pool.id)
        .map((e) => e.position)
        .sort((a, b) => a - b);
      if (positions.length === 0) continue;
      expect(positions, pool.id).toEqual(positions.map((_, i) => i));
    }
  });
});
