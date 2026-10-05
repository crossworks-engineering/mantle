import { describe, expect, it } from 'vitest';
import { archiveSummaryInput, fallbackThreadTitle, parseArchiveSummary } from './chat-archive';

describe('parseArchiveSummary', () => {
  it('reads strict JSON, with or without a code fence', () => {
    expect(parseArchiveSummary('{"title":"Trip Plan","summary":"We planned it."}')).toEqual({
      title: 'Trip Plan',
      summary: 'We planned it.',
    });
    expect(
      parseArchiveSummary('```json\n{"title": "Trip Plan", "summary": "We planned it."}\n```'),
    ).toEqual({ title: 'Trip Plan', summary: 'We planned it.' });
  });
  it('keeps a prose reply as the summary with no title', () => {
    expect(parseArchiveSummary('We planned the trip.')).toEqual({
      title: null,
      summary: 'We planned the trip.',
    });
    expect(parseArchiveSummary('  ')).toEqual({ title: null, summary: null });
  });
});

describe('fallbackThreadTitle', () => {
  it('uses the first user line, cut to 60 chars, else the date', () => {
    expect(fallbackThreadTitle('  Plan the   garden ', new Date('2026-10-05T08:00:00Z'))).toBe(
      'Plan the garden',
    );
    const long = 'x'.repeat(80);
    expect(fallbackThreadTitle(long, new Date())).toHaveLength(60);
    expect(fallbackThreadTitle(null, new Date('2026-10-05T08:00:00Z'))).toBe('Chat of 2026-10-05');
  });
});

describe('archiveSummaryInput', () => {
  const at = new Date('2026-10-05T08:00:00Z');
  it('lists digests first, then the tail turns with long turns cut', () => {
    const out = archiveSummaryInput(
      [{ topic: 'Beds', summary: 'Tomatoes north.', period_start: '2026-10-01T00:00:00Z' }],
      [
        { direction: 'inbound', text: 'and beans?', createdAt: at },
        { direction: 'outbound', text: 'y'.repeat(2000), createdAt: at },
      ],
    )!;
    expect(out.indexOf('Earlier parts')).toBeLessThan(out.indexOf('Last turns'));
    expect(out).toContain('- [2026-10-01] Beds: Tomatoes north.');
    expect(out).toContain('#1 [2026-10-05T08:00:00.000Z] user: and beans?');
    expect(out).toContain('[cut]');
  });
  it('is null when there is nothing to summarise', () => {
    expect(
      archiveSummaryInput([{ summary: '' }], [{ direction: 'inbound', text: ' ', createdAt: at }]),
    ).toBeNull();
  });
});
