import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EXTRACTION_CONCURRENCY_DEFAULT,
  EXTRACTION_CONCURRENCY_MAX,
  resolveExtractionConcurrency,
} from './extraction-concurrency';

describe('resolveExtractionConcurrency', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('uses the saved value first', () => {
    vi.stubEnv('EXTRACT_CONCURRENCY', '3');
    expect(resolveExtractionConcurrency(10)).toBe(10);
  });

  it('falls back to the env, then the default', () => {
    vi.stubEnv('EXTRACT_CONCURRENCY', '5');
    expect(resolveExtractionConcurrency(null)).toBe(5);
    vi.stubEnv('EXTRACT_CONCURRENCY', '');
    expect(resolveExtractionConcurrency(null)).toBe(EXTRACTION_CONCURRENCY_DEFAULT);
  });

  it('clamps to the max and refuses zero', () => {
    expect(resolveExtractionConcurrency(99)).toBe(EXTRACTION_CONCURRENCY_MAX);
    expect(resolveExtractionConcurrency(0)).toBe(EXTRACTION_CONCURRENCY_DEFAULT);
  });
});
