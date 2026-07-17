import { describe, expect, it } from 'vitest';
import { SHAREABLE_TYPES, isShareable, isShareableFolderPath } from './shares';

describe('isShareable', () => {
  it('accepts every workspace content type (sharing parity)', () => {
    for (const t of ['page', 'note', 'task', 'event', 'file', 'app', 'table', 'branch']) {
      expect(isShareable(t)).toBe(true);
    }
  });

  it('keeps the sensitive types out', () => {
    for (const t of ['secret', 'email', 'email_thread', 'contact', 'journal']) {
      expect(isShareable(t)).toBe(false);
    }
  });

  it('SHAREABLE_TYPES and isShareable agree (one gate, no drift)', () => {
    for (const t of SHAREABLE_TYPES) expect(isShareable(t)).toBe(true);
  });
});

describe('isShareableFolderPath', () => {
  it('accepts folders strictly under the files root', () => {
    expect(isShareableFolderPath('files.work')).toBe(true);
    expect(isShareableFolderPath('files.work.lister-printer')).toBe(true);
  });

  it('rejects the files root itself — sharing everything must never be one accidental toggle', () => {
    expect(isShareableFolderPath('files')).toBe(false);
  });

  it('rejects branches outside the files tree and junk', () => {
    expect(isShareableFolderPath('pages.work')).toBe(false);
    expect(isShareableFolderPath('filesystem.work')).toBe(false); // prefix ≠ label boundary
    expect(isShareableFolderPath('')).toBe(false);
    expect(isShareableFolderPath(null)).toBe(false);
    expect(isShareableFolderPath(undefined)).toBe(false);
  });
});
