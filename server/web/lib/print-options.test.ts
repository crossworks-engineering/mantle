/**
 * The print options of a PDF export: validated from the query with safe
 * defaults, the header and footer lines as text only (escaped into the one
 * template), the room a line needs, and the inch and paper maths both
 * engines get.
 */
import { describe, expect, it } from 'vitest';
import {
  chromeDocument,
  chromeFragment,
  DEFAULT_PRINT_OPTIONS,
  mmToInches,
  paperInches,
  parsePrintOptions,
  printChrome,
} from './print-options';

const q = (s: string) => parsePrintOptions(new URLSearchParams(s));

describe('parsePrintOptions', () => {
  it('an empty query is the A4 print every export was', () => {
    expect(q('')).toEqual({ ok: true, options: DEFAULT_PRINT_OPTIONS });
    expect(q('format=pdf&paper=&header=')).toEqual({ ok: true, options: DEFAULT_PRINT_OPTIONS });
  });

  it('takes each option, one margin for all sides or each side', () => {
    expect(q('paper=a3&landscape=true&margin=20')).toMatchObject({
      ok: true,
      options: {
        paper: 'a3',
        landscape: true,
        margins: { top: 20, right: 20, bottom: 20, left: 20 },
      },
    });
    expect(q('margin=20&margin_left=5&landscape=0')).toMatchObject({
      ok: true,
      options: { landscape: false, margins: { top: 20, right: 20, bottom: 20, left: 5 } },
    });
  });

  it('refuses what it does not take, by name', () => {
    expect(q('paper=tabloid')).toEqual({
      ok: false,
      error: expect.stringMatching(/^print option paper: /),
    });
    expect(q('margin=99')).toEqual({
      ok: false,
      error: expect.stringMatching(/^print option margin: /),
    });
    expect(q('margin=-1').ok).toBe(false);
    expect(q('landscape=yes').ok).toBe(false);
    expect(q(`header=${'x'.repeat(201)}`).ok).toBe(false);
  });

  it('a header or footer line gets its room', () => {
    expect(q('margin=0&header=Title&footer=Bottom')).toMatchObject({
      options: {
        margins: { top: 14, right: 0, bottom: 14, left: 0 },
        header: 'Title',
        footer: 'Bottom',
      },
    });
    expect(q('margin=5&page_numbers=1')).toMatchObject({
      options: { margins: { top: 5, bottom: 14 }, pageNumbers: true, footer: null },
    });
    expect(q('margin_top=30&header=T')).toMatchObject({ options: { margins: { top: 30 } } });
  });
});

describe('the header and footer lines', () => {
  it('are text, escaped, with the page numbers on the right', () => {
    const f = chromeFragment('<b>Q3</b> & co', true)!;
    expect(f).toContain('&lt;b&gt;Q3&lt;/b&gt; &amp; co');
    expect(f).toContain('class="pageNumber"');
    expect(f).toContain('class="totalPages"');
    expect(f).not.toContain('<b>');
    expect(chromeFragment(null, false)).toBeNull();
    expect(chromeFragment(null, true)).toContain('Page <span class="pageNumber">');
    expect(chromeDocument(null)).toBeNull();
    expect(chromeDocument('<div>x</div>')).toMatch(
      /^<!doctype html>.*<div>x<\/div><\/body><\/html>$/,
    );
  });

  it('the header line goes up, the footer line and the numbers go down', () => {
    const c = printChrome({
      ...DEFAULT_PRINT_OPTIONS,
      header: 'H',
      footer: 'F',
      pageNumbers: true,
    });
    expect(c.header).toContain('<span>H</span>');
    expect(c.header).not.toContain('pageNumber');
    expect(c.footer).toContain('<span>F</span>');
    expect(c.footer).toContain('pageNumber');
    expect(printChrome(DEFAULT_PRINT_OPTIONS)).toEqual({ header: null, footer: null });
  });
});

describe('the paper', () => {
  it('in inches, swapped for landscape; millimetres to inches', () => {
    expect(paperInches(DEFAULT_PRINT_OPTIONS)).toEqual({ width: 8.27, height: 11.69 });
    expect(paperInches({ ...DEFAULT_PRINT_OPTIONS, paper: 'letter', landscape: true })).toEqual({
      width: 11,
      height: 8.5,
    });
    expect(mmToInches(25.4)).toBe(1);
    expect(mmToInches(18)).toBe(0.709);
  });
});
