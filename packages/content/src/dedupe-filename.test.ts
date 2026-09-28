import { describe, expect, it } from 'vitest';
import { dedupeFilename } from './dedupe-filename';

describe('dedupeFilename', () => {
  it('passes a free name through', () => {
    expect(dedupeFilename('report.pdf', new Set())).toBe('report.pdf');
  });

  it('suffixes before the extension on collision', () => {
    expect(dedupeFilename('report.pdf', new Set(['report.pdf']))).toBe('report-2.pdf');
  });

  it('keeps counting past existing suffixes', () => {
    expect(dedupeFilename('report.pdf', new Set(['report.pdf', 'report-2.pdf']))).toBe(
      'report-3.pdf',
    );
  });

  it('handles extension-less names', () => {
    expect(dedupeFilename('notes', new Set(['notes']))).toBe('notes-2');
  });

  it('compares case-insensitively', () => {
    expect(dedupeFilename('report.pdf', new Set(['Report.PDF']))).toBe('report-2.pdf');
  });
});
