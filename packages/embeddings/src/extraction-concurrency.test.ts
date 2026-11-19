import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BOOK_CONCURRENCY_DEFAULT,
  BOOK_CONCURRENCY_MAX,
  EXTRACTION_CONCURRENCY_DEFAULT,
  EXTRACTION_CONCURRENCY_MAX,
  EXTRACTION_TIME_BUDGET_DEFAULT,
  laneSettingSource,
  resolveBookConcurrency,
  resolveExtractionConcurrency,
  resolveExtractionTimeBudget,
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

describe('resolveBookConcurrency (books at once, 0391)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('uses the saved value first, then the env, then 1', () => {
    vi.stubEnv('EXTRACT_BOOK_CONCURRENCY', '3');
    expect(resolveBookConcurrency(2)).toBe(2);
    expect(resolveBookConcurrency(null)).toBe(3);
    vi.stubEnv('EXTRACT_BOOK_CONCURRENCY', '');
    expect(resolveBookConcurrency(null)).toBe(BOOK_CONCURRENCY_DEFAULT);
    expect(BOOK_CONCURRENCY_DEFAULT).toBe(1);
  });

  it('clamps to 4 and refuses zero', () => {
    expect(BOOK_CONCURRENCY_MAX).toBe(4);
    expect(resolveBookConcurrency(9)).toBe(4);
    expect(resolveBookConcurrency(0)).toBe(BOOK_CONCURRENCY_DEFAULT);
  });
});

describe('resolveExtractionTimeBudget', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('uses the saved minutes, then the env, then 60', () => {
    vi.stubEnv('MANTLE_EXTRACT_EXPIRE_MIN', '90');
    expect(resolveExtractionTimeBudget(30)).toBe(30);
    expect(resolveExtractionTimeBudget(null)).toBe(90);
    expect(resolveExtractionTimeBudget(0)).toBe(90);
    vi.stubEnv('MANTLE_EXTRACT_EXPIRE_MIN', '');
    expect(resolveExtractionTimeBudget(null)).toBe(EXTRACTION_TIME_BUDGET_DEFAULT);
    expect(EXTRACTION_TIME_BUDGET_DEFAULT).toBe(60);
  });
});

describe('laneSettingSource', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('saved, then env when the env value counts, then default', () => {
    vi.stubEnv('EXTRACT_BOOK_CONCURRENCY', '2');
    expect(laneSettingSource(3, 'EXTRACT_BOOK_CONCURRENCY')).toBe('saved');
    expect(laneSettingSource(null, 'EXTRACT_BOOK_CONCURRENCY')).toBe('env');
    // A value the table refuses (under 1) falls back: not the env's.
    vi.stubEnv('EXTRACT_BOOK_CONCURRENCY', '0');
    expect(laneSettingSource(null, 'EXTRACT_BOOK_CONCURRENCY')).toBe('default');
    vi.stubEnv('EXTRACT_BOOK_CONCURRENCY', 'junk');
    expect(laneSettingSource(null, 'EXTRACT_BOOK_CONCURRENCY')).toBe('default');
    vi.stubEnv('EXTRACT_BOOK_CONCURRENCY', '');
    expect(laneSettingSource(undefined, 'EXTRACT_BOOK_CONCURRENCY')).toBe('default');
  });

  it('agrees with the resolver for a saved value under 1', () => {
    vi.stubEnv('EXTRACT_CONCURRENCY', '5');
    expect(resolveExtractionConcurrency(0)).toBe(EXTRACTION_CONCURRENCY_DEFAULT);
    expect(laneSettingSource(0, 'EXTRACT_CONCURRENCY')).toBe('default');
    vi.stubEnv('MANTLE_EXTRACT_EXPIRE_MIN', '90');
    expect(resolveExtractionTimeBudget(0)).toBe(90);
    expect(laneSettingSource(0, 'MANTLE_EXTRACT_EXPIRE_MIN')).toBe('env');
  });

  it('holds books at once to the CHECK of 0391 (1 to 4): raise both together', () => {
    expect(BOOK_CONCURRENCY_MAX).toBe(4);
  });
});
