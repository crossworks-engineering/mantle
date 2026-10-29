import { describe, expect, it } from 'vitest';
import {
  normalizePersonDescription,
  PERSON_DESCRIPTION_MAX,
  personDescriptionLength,
  projectPersonDescription,
} from './person-description';

describe('a person description', () => {
  it('is one line: white space runs, newlines and tabs become one space', () => {
    expect(normalizePersonDescription('  Dev\n\tops  lead \r\n')).toBe('Dev ops lead');
    expect(normalizePersonDescription('a b c')).toBe('a b c');
  });

  it('drops control and format characters, so nothing hides or reorders text', () => {
    // U+0000 (which jsonb refuses), a bidi override, isolates and marks.
    expect(normalizePersonDescription('Finance\u0000 ‮regnam‬')).toBe('Finance regnam');
    expect(normalizePersonDescription('⁦a⁩‎b‏c؜d')).toBe('abcd');
    // Zero-width space, non-joiner, word joiner, byte order mark, soft hyphen.
    expect(normalizePersonDescription('a​b‌c⁠d﻿e­f')).toBe('abcdef');
    expect(normalizePersonDescription('\u0007\u001B\u007F\u0085')).toBe('');
    // A joiner outside an emoji is invisible text too.
    expect(normalizePersonDescription('ad‍min')).toBe('admin');
  });

  it('keeps an emoji whole, its joiners and its variation selector included', () => {
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
    const heart = '❤️‍\u{1F525}';
    expect(normalizePersonDescription(`${family} dad`)).toBe(`${family} dad`);
    expect(normalizePersonDescription(heart)).toBe(heart);
  });

  it('projects nothing visible as none, and caps by code point, never inside one', () => {
    expect(projectPersonDescription(' ​\n ')).toBeNull();
    expect(projectPersonDescription(42)).toBeNull();
    expect(projectPersonDescription(' Developer ')).toBe('Developer');
    const long = projectPersonDescription('\u{1F600}'.repeat(PERSON_DESCRIPTION_MAX + 1))!;
    expect(personDescriptionLength(long)).toBe(PERSON_DESCRIPTION_MAX);
    expect(long).toBe('\u{1F600}'.repeat(PERSON_DESCRIPTION_MAX));
    // A stored value from before the rule reads clean.
    expect(projectPersonDescription('Ops‮\nlead')).toBe('Ops lead');
  });

  it('counts code points: an emoji is one', () => {
    expect(personDescriptionLength('\u{1F600}ab')).toBe(3);
  });
});
