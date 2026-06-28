import { describe, expect, it } from 'vitest';
import { categoryLabel, moodDisplay, normalizeEntryDate } from './journal-options';

describe('normalizeEntryDate', () => {
  it('passes through a full ISO timestamp (canonicalised)', () => {
    const out = normalizeEntryDate('2025-12-25T08:30:00.000Z');
    expect(out).toBe('2025-12-25T08:30:00.000Z');
  });

  it('accepts a bare date and yields a valid ISO string', () => {
    const out = normalizeEntryDate('2025-12-25');
    expect(out).not.toBeNull();
    expect(out).toMatch(/^2025-12-25T/);
    // round-trips through Date without throwing
    expect(Number.isNaN(Date.parse(out!))).toBe(false);
  });

  it('rejects free-text that is not a date — the cast-poison guard', () => {
    expect(normalizeEntryDate('next Tuesday')).toBeNull();
    expect(normalizeEntryDate('tomorrow')).toBeNull();
    expect(normalizeEntryDate('soon-ish')).toBeNull();
    expect(normalizeEntryDate('2026-13-99')).toBeNull(); // out-of-range → invalid
  });

  it('treats empty / whitespace / non-string as "no date"', () => {
    expect(normalizeEntryDate('')).toBeNull();
    expect(normalizeEntryDate('   ')).toBeNull();
    expect(normalizeEntryDate(null)).toBeNull();
    expect(normalizeEntryDate(undefined)).toBeNull();
    // @ts-expect-error — guard against a non-string slipping through at runtime
    expect(normalizeEntryDate(123)).toBeNull();
  });
});

describe('moodDisplay', () => {
  it('maps a known mood key to emoji + label', () => {
    expect(moodDisplay('grateful')).toEqual({ emoji: '🙏', label: 'Grateful' });
  });
  it('tolerates an unknown/free-text mood (no emoji, raw label)', () => {
    expect(moodDisplay('zonked')).toEqual({ emoji: '', label: 'zonked' });
  });
  it('returns null for no mood', () => {
    expect(moodDisplay(null)).toBeNull();
  });
});

describe('categoryLabel', () => {
  it('maps a known category key to its label', () => {
    expect(categoryLabel('faith')).toBe('Faith');
  });
  it('title-cases an unknown/free-text category', () => {
    expect(categoryLabel('hobbies')).toBe('Hobbies');
  });
  it('returns null for no category', () => {
    expect(categoryLabel(null)).toBeNull();
  });
});
