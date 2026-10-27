import { describe, expect, it } from 'vitest';
import { formatTimestamp, transcriptWordCount } from './video-transcript';

describe('formatTimestamp', () => {
  it('formats minutes and hours', () => {
    expect(formatTimestamp(0)).toBe('0:00');
    expect(formatTimestamp(754.2)).toBe('12:34');
    expect(formatTimestamp(3921)).toBe('1:05:21');
  });
});

describe('transcriptWordCount', () => {
  it('counts body words, not headings', () => {
    expect(transcriptWordCount('## [0:00]\n\none two three')).toBe(3);
  });
});
