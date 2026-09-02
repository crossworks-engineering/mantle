/**
 * Pool/model fit. Pins the 2026-09-02 bug: the shipped vision ("Read images")
 * pool carried Nano Banana Pro, an image GENERATOR. Generators accept image
 * input exactly like readers do, so nothing on the input side caught it —
 * the model billed image-generation tokens and returned a picture where the
 * vision worker wanted text.
 */
import { describe, expect, it } from 'vitest';
import { MODEL_POOLS, poolModelIssue } from './model-pools';
import { CURATED_MODEL_POOLS } from './model-pools-data';

const READER = { input: ['text', 'image'], output: ['text'] };
const GENERATOR = { input: ['image', 'text'], output: ['image', 'text'] };
const TEXT_ONLY = { input: ['text'], output: ['text'] };

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

  it('never checks the audio pools — their models are not in the chat catalog', () => {
    expect(poolModelIssue('tts', GENERATOR)).toBeNull();
    expect(poolModelIssue('stt', TEXT_ONLY)).toBeNull();
  });

  it('fails OPEN on an unloaded catalog and on an unknown pool', () => {
    expect(poolModelIssue('vision', null)).toBeNull();
    expect(poolModelIssue('vision', { input: [], output: [] })).toBeNull();
    expect(poolModelIssue('not-a-pool', GENERATOR)).toBeNull();
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
