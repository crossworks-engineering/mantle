import { describe, it, expect } from 'vitest';
import { slugify } from './slugify';

// ── Legacy implementations, verbatim from the pre-centralisation call sites ──
// The centralised `slugify(input, opts)` must reproduce each of these byte-for-
// byte for every representative input, because their outputs are (or seed)
// stored identity slugs. If one of these ever needs to change, that is a
// migration, not a refactor — this file is the tripwire.

// agents-client.tsx / (docs seeds this without the cap)
const legacyNoUnderscore64 = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);

// docs/new-collection-dialog.tsx (no cap, has a redundant .trim())
const legacyDocs = (s: string) =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

// skills / heartbeats / tool-groups / tools
const legacyAllowUnderscore64 = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);

// dev-tools/save-tool-dialog.tsx (underscore separator)
const legacySaveTool = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);

// api/export/[id]/route.ts (cap 80, 'export' fallback)
const legacyExport = (title: string) => {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'export';
};

// lib/ai-workers.ts (cap 60)
const legacyAiWorker = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '')
    .slice(0, 60);

const INPUTS = [
  '',
  '   ',
  'Hello World',
  'Hello   World',
  '  leading and trailing  ',
  'already-a-slug',
  'snake_case_name',
  'mixed_-_separators',
  'UPPER.case/Punct!uation?',
  'Q1/Q2 2026 report',
  'dots.and-dashes_and spaces',
  '---leading-dashes---',
  '___leading_underscores___',
  'web_search',
  'a'.repeat(200),
  'x_'.repeat(50),
  'café résumé',
  '你好 world',
  '!!!',
  '- _ - _',
  'tab\tand\nnewline',
  '123 numbers 456',
];

describe('slugify — byte-identical to every legacy call-site behaviour', () => {
  it('matches the no-underscore / cap-64 profile (agents)', () => {
    for (const s of INPUTS) {
      expect(slugify(s, { maxLength: 64 })).toBe(legacyNoUnderscore64(s));
    }
  });

  it('matches the docs profile (no cap, canonical default)', () => {
    for (const s of INPUTS) {
      expect(slugify(s)).toBe(legacyDocs(s));
    }
  });

  it('matches the allow-underscore / cap-64 profile (skills, heartbeats, tool-groups, tools)', () => {
    for (const s of INPUTS) {
      expect(slugify(s, { allowUnderscore: true, maxLength: 64 })).toBe(legacyAllowUnderscore64(s));
    }
  });

  it('matches the underscore-separator profile (save-tool)', () => {
    for (const s of INPUTS) {
      expect(slugify(s, { allowUnderscore: true, separator: '_', maxLength: 64 })).toBe(
        legacySaveTool(s),
      );
    }
  });

  it('matches the export profile (cap 80, "export" fallback)', () => {
    for (const s of INPUTS) {
      expect(slugify(s, { maxLength: 80, fallback: 'export' })).toBe(legacyExport(s));
    }
  });

  it('matches the ai-worker profile (cap 60)', () => {
    for (const s of INPUTS) {
      expect(slugify(s, { maxLength: 60 })).toBe(legacyAiWorker(s));
    }
  });
});

describe('slugify — canonical behaviour and edge cases', () => {
  it('lower-cases and hyphenates runs of illegal characters', () => {
    expect(slugify('Hello   World!!')).toBe('hello-world');
  });

  it('trims leading/trailing separators', () => {
    expect(slugify('--Hello--')).toBe('hello');
  });

  it('drops underscores by default but keeps them with allowUnderscore', () => {
    expect(slugify('a_b')).toBe('a-b');
    expect(slugify('a_b', { allowUnderscore: true })).toBe('a_b');
  });

  it('collapses to the empty string (or fallback) for all-unicode / all-punctuation input', () => {
    expect(slugify('你好')).toBe('');
    expect(slugify('!!!')).toBe('');
    expect(slugify('!!!', { fallback: 'export' })).toBe('export');
  });

  it('applies the length cap after trimming (a cut can leave a trailing separator)', () => {
    // 'ab cd' -> 'ab-cd'; cap at 3 -> 'ab-' (mirrors the originals' slice-last order).
    expect(slugify('ab cd', { maxLength: 3 })).toBe('ab-');
  });

  it('has no cap by default', () => {
    const long = 'x'.repeat(500);
    expect(slugify(long)).toHaveLength(500);
  });

  it('uses the given separator for both joining and end-trimming', () => {
    expect(slugify('a b c', { allowUnderscore: true, separator: '_' })).toBe('a_b_c');
    expect(slugify('__a b__', { allowUnderscore: true, separator: '_' })).toBe('a_b');
  });
});
