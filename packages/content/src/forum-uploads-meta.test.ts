import { describe, expect, it } from 'vitest';
import {
  attachmentKindForMime,
  dedupeFilename,
  formatAttachmentSize,
  topicFolderSlug,
} from './forum-uploads-meta';

describe('attachmentKindForMime', () => {
  it('classifies the media families', () => {
    expect(attachmentKindForMime('image/png')).toBe('image');
    expect(attachmentKindForMime('image/svg+xml')).toBe('image');
    expect(attachmentKindForMime('audio/mpeg')).toBe('audio');
    expect(attachmentKindForMime('video/mp4')).toBe('video');
  });

  it('defaults everything else to document', () => {
    expect(attachmentKindForMime('application/pdf')).toBe('document');
    expect(attachmentKindForMime('text/plain; charset=utf-8')).toBe('document');
    expect(attachmentKindForMime('')).toBe('document');
    expect(attachmentKindForMime(null)).toBe('document');
    expect(attachmentKindForMime(undefined)).toBe('document');
  });

  it('ignores casing and mime parameters', () => {
    expect(attachmentKindForMime('IMAGE/PNG')).toBe('image');
    expect(attachmentKindForMime('audio/ogg; codecs=opus')).toBe('audio');
  });

  it('never infers voice (transport-only kind)', () => {
    expect(attachmentKindForMime('audio/ogg')).toBe('audio');
  });
});

describe('topicFolderSlug', () => {
  it('slugifies a plain title', () => {
    expect(topicFolderSlug('How do we PDF?')).toBe('how-do-we-pdf');
  });

  it('strips diacritics via NFKD', () => {
    expect(topicFolderSlug('Café menu réview')).toBe('cafe-menu-review');
  });

  it('collapses punctuation runs and trims edge dashes', () => {
    expect(topicFolderSlug('  ...vibration -- report!!  ')).toBe('vibration-report');
  });

  it('falls back to topic when nothing survives', () => {
    expect(topicFolderSlug('🎉🎉🎉')).toBe('topic');
    expect(topicFolderSlug('')).toBe('topic');
  });

  it('caps at 64 chars without a trailing dash', () => {
    const slug = topicFolderSlug(`${'a'.repeat(63)} tail words beyond the cap`);
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug.endsWith('-')).toBe(false);
  });
});

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
