/**
 * The image check's seal (check-seal.ts): it covers every field a reader
 * acts on (the reason shown, the circuit, the crop ids too), and it
 * survives a master key rotation: sealed under the staged
 * MANTLE_MASTER_KEY_NEXT while one is staged, accepted under it or the
 * current key, so promoting the rotation keeps the rows sealed during it.
 * Test keys only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loginActor, runAsActor, systemActor } from '@mantle/db';
import { sealHolds, sealOf, type SealedFields } from './check-seal';
import { callerOf } from '../builtins-circuits';

const OLD = 'seal-test-old-key';
const NEW = 'seal-test-new-key';

const row: SealedFields = {
  tableId: 't-1',
  key: 'end:A@20.0,0.0',
  circuit: 'C-1',
  question: 'Does the pipe end connect to "V-201"?',
  answer: 'yes',
  reason: 'into its nozzle',
  model: 'test/vision-model',
  revision: 'rev1',
  checkedAt: '2026-10-25T12:00:00.000Z',
  crops: 'overview c0 c1',
};

beforeEach(() => {
  vi.stubEnv('MANTLE_MASTER_KEY', OLD);
  vi.stubEnv('MANTLE_MASTER_KEY_NEXT', undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the Checks row seal', () => {
  it('covers the reason, the circuit and the crops', () => {
    const seal = sealOf(row);
    expect(sealHolds(row, seal)).toBe(true);
    for (const change of [
      { reason: 'a typed reason' },
      { circuit: 'C-2' },
      { crops: 'overview c9' },
      { answer: 'no' },
    ])
      expect(sealHolds({ ...row, ...change }, seal)).toBe(false);
  });

  it('holds under the current or the staged key, and survives the promotion', () => {
    const before = sealOf(row);
    // Rotation staged: old rows still hold, new rows go under the new key.
    vi.stubEnv('MANTLE_MASTER_KEY_NEXT', NEW);
    expect(sealHolds(row, before)).toBe(true);
    const during = sealOf(row);
    expect(during).not.toBe(before);
    expect(sealHolds(row, during)).toBe(true);
    // Promoted: the new key is current, the old one dropped.
    vi.stubEnv('MANTLE_MASTER_KEY', NEW);
    vi.stubEnv('MANTLE_MASTER_KEY_NEXT', undefined);
    expect(sealHolds(row, during)).toBe(true);
    // A row sealed only under the dropped key no longer applies.
    expect(sealHolds(row, before)).toBe(false);
  });

  it('no master key: nothing is sealed, nothing holds', () => {
    vi.stubEnv('MANTLE_MASTER_KEY', undefined);
    expect(sealOf(row)).toBe('');
    expect(sealHolds(row, 'a'.repeat(64))).toBe(false);
  });
});

describe('the By column (LOW-b)', () => {
  const LOGIN = '0b5a4f7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b';

  it('records the kind of caller and a keyed hash of its id, never the id', () => {
    const by = runAsActor(loginActor(LOGIN), () => callerOf());
    expect(by).toMatch(/^login:[0-9a-f]{24}$/);
    expect(by).not.toContain(LOGIN);
    // The same caller is the same By; another is not.
    expect(runAsActor(loginActor(LOGIN), () => callerOf())).toBe(by);
    expect(runAsActor(loginActor(LOGIN.replace('0b', '1b')), () => callerOf())).not.toBe(by);
    expect(runAsActor(systemActor('script:test'), () => callerOf())).toMatch(
      /^system:[0-9a-f]{24}$/,
    );
    // Without a master key: the kind alone.
    vi.stubEnv('MANTLE_MASTER_KEY', undefined);
    expect(runAsActor(loginActor(LOGIN), () => callerOf())).toBe('login');
  });

  it('is sealed with a new row; a row filed before it seals as it did', () => {
    const by = 'login:0123456789abcdef01234567';
    const seal = sealOf({ ...row, by });
    expect(sealHolds({ ...row, by }, seal)).toBe(true);
    for (const other of ['', 'login:ffffffffffffffffffffffff', 'owner'])
      expect(sealHolds({ ...row, by: other }, seal)).toBe(false);
    // An old row: no By, its seal unchanged.
    const old = sealOf(row);
    expect(sealHolds({ ...row, by: '' }, old)).toBe(true);
    expect(sealHolds({ ...row, by }, old)).toBe(false);
    // A By never reads as an alternative.
    expect(sealHolds({ ...row, alt: by }, seal)).toBe(false);
  });
});
