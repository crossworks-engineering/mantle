import { describe, expect, it } from 'vitest';
import {
  assertSourceWithinLimits,
  AppSourceLimitError,
  MAX_APP_FILES,
  MAX_APP_FILE_BYTES,
  MAX_APP_PATH_LEN,
} from './apps';

function source(files: Record<string, string>) {
  return { entry: 'App.tsx', files };
}

describe('assertSourceWithinLimits', () => {
  it('accepts a normal source tree', () => {
    expect(() =>
      assertSourceWithinLimits(
        source({ 'App.tsx': 'export default () => null;', 'lib/x.ts': 'export const x = 1;' }),
      ),
    ).not.toThrow();
  });

  it('rejects more than MAX_APP_FILES files', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i <= MAX_APP_FILES; i++) files[`f${i}.ts`] = '';
    expect(() => assertSourceWithinLimits(source(files))).toThrow(AppSourceLimitError);
    expect(Object.keys(files).length).toBeGreaterThan(MAX_APP_FILES);
  });

  it('accepts exactly MAX_APP_FILES files', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < MAX_APP_FILES; i++) files[`f${i}.ts`] = '';
    expect(() => assertSourceWithinLimits(source(files))).not.toThrow();
  });

  it('rejects a file larger than MAX_APP_FILE_BYTES', () => {
    const big = 'x'.repeat(MAX_APP_FILE_BYTES + 1);
    expect(() => assertSourceWithinLimits(source({ 'App.tsx': big }))).toThrow(/too large/i);
  });

  it('measures size in UTF-8 bytes, not characters', () => {
    // '€' is 3 bytes — just over half the cap in chars is over the cap in bytes.
    const chars = Math.floor(MAX_APP_FILE_BYTES / 3) + 1;
    expect(() => assertSourceWithinLimits(source({ 'App.tsx': '€'.repeat(chars) }))).toThrow(
      /too large/i,
    );
  });

  it('rejects an over-long file path', () => {
    const longPath = 'a'.repeat(MAX_APP_PATH_LEN + 1) + '.ts';
    expect(() => assertSourceWithinLimits(source({ [longPath]: '' }))).toThrow(/path too long/i);
  });
});
