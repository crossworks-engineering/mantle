import { describe, expect, it } from 'vitest';

import { EMBED_TEXT_PER_FILE, EMBED_TEXT_TOTAL, foldEmbeddedText } from './pages';

describe('foldEmbeddedText', () => {
  it('returns empty for no items / all-empty text', () => {
    expect(foldEmbeddedText([])).toBe('');
    expect(
      foldEmbeddedText([
        { title: 'a.png', text: '' },
        { title: 'b.png', text: '   ' },
      ]),
    ).toBe('');
    expect(
      foldEmbeddedText([
        { title: 'a.png', text: null },
        { title: 'b.png', text: undefined },
      ]),
    ).toBe('');
  });

  it('labels each file and preserves order', () => {
    const out = foldEmbeddedText([
      { title: 'diagram.png', text: 'gantry rebuild plan' },
      { title: 'quote.pdf', text: 'R12 000 total' },
    ]);
    expect(out).toBe(
      '[Embedded file: diagram.png]\ngantry rebuild plan\n\n[Embedded file: quote.pdf]\nR12 000 total',
    );
    expect(out.indexOf('diagram.png')).toBeLessThan(out.indexOf('quote.pdf'));
  });

  it('skips empty entries but keeps the rest in order', () => {
    const out = foldEmbeddedText([
      { title: 'a.png', text: '  ' },
      { title: 'b.png', text: 'real content' },
    ]);
    expect(out).toBe('[Embedded file: b.png]\nreal content');
  });

  it('caps a single file at perFile', () => {
    const out = foldEmbeddedText([{ title: 'big.png', text: 'x'.repeat(50) }], 10, 1000);
    expect(out).toBe('[Embedded file: big.png]\n' + 'x'.repeat(10));
  });

  it('caps the total budget across files and stops once exhausted', () => {
    const out = foldEmbeddedText(
      [
        { title: 'a.png', text: 'a'.repeat(100) },
        { title: 'b.png', text: 'b'.repeat(100) },
        { title: 'c.png', text: 'c'.repeat(100) },
      ],
      80, // perFile
      100, // total
    );
    // a.png takes 80 (perFile), b.png takes the remaining 20, c.png is dropped.
    expect(out).toContain('[Embedded file: a.png]\n' + 'a'.repeat(80));
    expect(out).toContain('[Embedded file: b.png]\n' + 'b'.repeat(20));
    expect(out).not.toContain('c.png');
  });

  it('exposes sane default bounds', () => {
    expect(EMBED_TEXT_PER_FILE).toBe(4000);
    expect(EMBED_TEXT_TOTAL).toBe(16000);
  });
});
