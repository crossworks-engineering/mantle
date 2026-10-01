import { describe, expect, it } from 'vitest';
import { missingDbTestEnv } from './test-env-guard';

const URLS = {
  MANTLE_TEST_DATABASE_URL: 'postgres://ci',
  RUNS_TEST_DATABASE_URL: 'postgres://ci',
};

describe('missingDbTestEnv: CI never skips the database tests', () => {
  it('names each variable a CI run is missing', () => {
    expect(missingDbTestEnv({ CI: 'true' })).toEqual([
      'MANTLE_TEST_DATABASE_URL',
      'RUNS_TEST_DATABASE_URL',
    ]);
    expect(missingDbTestEnv({ CI: 'true', MANTLE_TEST_DATABASE_URL: 'postgres://ci' })).toEqual([
      'RUNS_TEST_DATABASE_URL',
    ]);
    expect(missingDbTestEnv({ CI: '1', ...URLS, RUNS_TEST_DATABASE_URL: ' ' })).toEqual([
      'RUNS_TEST_DATABASE_URL',
    ]);
  });

  it('is satisfied on CI with both set', () => {
    expect(missingDbTestEnv({ CI: 'true', ...URLS })).toEqual([]);
  });

  it('asks nothing of a local run', () => {
    expect(missingDbTestEnv({})).toEqual([]);
    expect(missingDbTestEnv({ CI: 'false' })).toEqual([]);
    expect(missingDbTestEnv({ CI: '0' })).toEqual([]);
  });
});
