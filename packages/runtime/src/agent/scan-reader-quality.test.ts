/**
 * The Scan reader's read-badly check (scanReadQualityOf): made-up answers of
 * a made-up spec table page, no model.
 */
import { describe, expect, it } from 'vitest';
import { SCAN_READ_ANCHORS_MIN, scanReadQualityOf, type OcrWord } from './scan-reader-quality';

/** A made-up page: a head and rows of a piping spec table. */
const ROWS = Array.from(
  { length: 40 },
  (_, i) => `FLANGE WN | 2-${i + 4} | SCH 80 | ASTM A105 | RF | ${100 + i}-${10 + (i % 90)}`,
);
const PAGE = ['SP-00-00 MADE-UP SPEC BOOK PAGE 7', ...ROWS].join('\n');

/** Tesseract's confident words of the page: `n` of them, each read at 95. */
const anchors = (n: number, words = ['FLANGE', 'ASTM', 'A105', 'SCH']): OcrWord[] =>
  Array.from({ length: n }, (_, i) => ({ text: words[i % words.length]!, conf: 95 }));

describe('scanReadQualityOf', () => {
  it('a full, clean read stands', () => {
    const q = scanReadQualityOf(PAGE, { finishReason: 'stop', ocrWords: anchors(40) });
    expect(q).toMatchObject({ ok: true, reasons: [], anchors: 40, agreement: 1 });
  });

  it('an empty answer is no_text, a few words are short', () => {
    expect(scanReadQualityOf('').reasons).toEqual(['no_text']);
    expect(scanReadQualityOf('PAGE 7').reasons).toEqual(['short']);
  });

  it('an answer cut at the token cap is a bad read, whatever it holds', () => {
    const q = scanReadQualityOf(PAGE, { finishReason: 'length' });
    expect(q.ok).toBe(false);
    expect(q.reasons).toEqual(['cut']);
  });

  it('one long line written again and again is a loop', () => {
    const loop = [PAGE, ...Array(6).fill(ROWS[0])].join('\n');
    expect(scanReadQualityOf(loop).reasons).toEqual(['loop']);
  });

  it('short lines repeated (a column of cells) are no loop', () => {
    const column = ['PAGE 7 OF THE BOOK HEAD', ...Array(30).fill('PIPE'), ...ROWS].join('\n');
    expect(scanReadQualityOf(column).reasons).toEqual([]);
  });

  it('the same line five times in a row is no loop; six is', () => {
    expect(scanReadQualityOf([PAGE, ...Array(4).fill(ROWS[0])].join('\n')).ok).toBe(true);
    expect(scanReadQualityOf([PAGE, ...Array(5).fill(ROWS[0])].join('\n')).reasons).toEqual([
      'loop',
    ]);
  });

  it('many [?] marks are the model saying it cannot read the page', () => {
    const marked = ROWS.map((r) => r.replace('ASTM A105', '[?] [?]')).join('\n');
    const q = scanReadQualityOf(marked);
    expect(q.reasons).toEqual(['illegible']);
    expect(q.illegibleShare).toBeGreaterThan(0.05);
    // A few marks on a long page stand.
    const few = [PAGE, 'NOTE [?] SEE SHEET 2'].join('\n');
    expect(scanReadQualityOf(few).ok).toBe(true);
  });

  it('a read that leaves out what Tesseract read plainly disagrees', () => {
    const half = ROWS.slice(0, 5).join('\n');
    const q = scanReadQualityOf(half, {
      ocrWords: anchors(60, ['FLANGE', 'ASTM', 'A105', 'SPEC', 'BOOK', 'MADE-UP']),
    });
    expect(q.reasons).toContain('disagrees');
    expect(q.agreement).toBeLessThan(0.8);
  });

  it('a made-up answer disagrees with the confident words', () => {
    const madeUp = Array.from({ length: 40 }, (_, i) => `GATE VALVE ${i} CL150 API 600 BE`).join(
      '\n',
    );
    expect(scanReadQualityOf(madeUp, { ocrWords: anchors(40) }).reasons).toEqual(['disagrees']);
  });

  it('with too few confident words the agreement is not checked', () => {
    const q = scanReadQualityOf(PAGE.replace(/FLANGE/g, 'FLANGF'), {
      ocrWords: anchors(SCAN_READ_ANCHORS_MIN - 1, ['ZZZZ']),
    });
    expect(q).toMatchObject({ ok: true, agreement: null });
  });

  it('only confident words of 3 characters or more with a letter or digit are anchors', () => {
    const words: OcrWord[] = [
      ...anchors(30),
      { text: 'RF', conf: 99 },
      { text: '---', conf: 99 },
      { text: 'ASTM', conf: 60 },
      { text: 'ASTM', conf: null },
    ];
    expect(scanReadQualityOf(PAGE, { ocrWords: words }).anchors).toBe(30);
  });

  it('a word Tesseract read across a ruled line counts as its parts', () => {
    const words: OcrWord[] = [...anchors(29), { text: 'ASTM|A105', conf: 96 }];
    const q = scanReadQualityOf(PAGE, { ocrWords: words });
    expect(q).toMatchObject({ anchors: 31, agreement: 1, ok: true });
  });

  it('cells split by " | " and by spaces compare the same', () => {
    const spaced = PAGE.replace(/ \| /g, '   ');
    expect(scanReadQualityOf(spaced, { ocrWords: anchors(40) }).agreement).toBe(1);
  });

  it('a read with far fewer lines than the free reads found left rows out', () => {
    const half = ROWS.slice(0, 20).join('\n');
    expect(scanReadQualityOf(half, { expectedLines: 41 }).reasons).toEqual(['too_few_lines']);
    // 80% of the lines stand: a head line or two read as one is no drop.
    expect(scanReadQualityOf(ROWS.slice(0, 33).join('\n'), { expectedLines: 41 }).ok).toBe(true);
  });

  it('with under 10 lines found, or none, the line check is not made', () => {
    const two = ROWS.slice(0, 2).join('\n');
    expect(scanReadQualityOf(two, { expectedLines: 9 }).ok).toBe(true);
    expect(scanReadQualityOf(two, { expectedLines: null }).ok).toBe(true);
  });

  it('a long answer no free read can vouch for is unverified (a made-up page)', () => {
    // A page too bad to read: Tesseract read no confident word and the ink
    // bands found 14 lines, but the answer is a whole table of 41.
    expect(scanReadQualityOf(PAGE, { ocrWords: [], expectedLines: 14 }).reasons).toEqual([
      'unverified',
    ]);
    // The free reads found no line at all: still unverified.
    expect(scanReadQualityOf(PAGE, { expectedLines: 0 }).reasons).toEqual(['unverified']);
  });

  it('a read whose lines the free reads counted stands with no confident word', () => {
    // A poor copy: Tesseract read no confident word, the ink bands found the
    // 41 lines, and so does the answer.
    expect(scanReadQualityOf(PAGE, { ocrWords: [], expectedLines: 41 }).ok).toBe(true);
    // Confident words that agree vouch for it whatever the line count.
    expect(scanReadQualityOf(PAGE, { ocrWords: anchors(40), expectedLines: 14 }).ok).toBe(true);
    // A short answer is not judged by this rule.
    expect(scanReadQualityOf(ROWS.slice(0, 10).join('\n'), { expectedLines: 0 }).ok).toBe(true);
  });
});
