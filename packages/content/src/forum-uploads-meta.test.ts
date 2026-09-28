import { describe, expect, it } from 'vitest';
import { formatAttachmentSize } from './forum-uploads-meta';

describe('formatAttachmentSize', () => {
  it('renders each magnitude', () => {
    expect(formatAttachmentSize(312)).toBe('312 B');
    expect(formatAttachmentSize(2150)).toBe('2.1 KB');
    expect(formatAttachmentSize(2_202_009)).toBe('2.1 MB');
    expect(formatAttachmentSize(24 * 1024 * 1024)).toBe('24 MB');
  });

  it('guards nonsense input', () => {
    expect(formatAttachmentSize(-5)).toBe('0 B');
    expect(formatAttachmentSize(Number.NaN)).toBe('0 B');
  });
});
