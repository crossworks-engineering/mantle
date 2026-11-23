/**
 * The pages each PDF Agent reads, by the lanes of the pages (./book-pages.ts
 * pageLanesOf; plan page c607711a, M4). Pure: made-up rows of a tab Pages.
 *
 * - With no used answer (no `decider` row) every Agent reads as before M4:
 *   the book's marked pages; a drawing file's pages from page 1 (null).
 * - A book: a drawing-lane page is not the office Agent's (no Scan reader),
 *   it is the drawing Agent's.
 * - A drawing file: an office-lane page with no text layer is the office
 *   Agent's, for the Scan reader; the drawing Agent reads every other page
 *   (an office page with a text layer too: its identifiers stay).
 * - On a live box a page under 0.75 is the office Agent's too (its picture
 *   is kept), a typed page too; never on a shadow box, whose older rows may
 *   say `rules: low confidence` too (the audit of M4).
 */
import { describe, expect, it } from 'vitest';
import { pageLanesOf, type LaneRow } from './book-pages';

const book = (page: number, method: string, why: string | null = null, more: LaneRow = {}) => ({
  Page: page,
  Method: method,
  Why: why,
  ...more,
});
const sheet = (page: number, cls: string, more: LaneRow = {}) => ({
  Page: page,
  Class: cls,
  ...more,
});
const used = (kind: string, conf = 0.9) => ({
  Kind: kind,
  'Kind from': 'decider',
  'Decider confidence': conf,
});

describe('pageLanesOf', () => {
  it('no used answer: as before M4', () => {
    expect(
      pageLanesOf([book(1, 'text'), book(2, 'vision', 'scan'), book(3, 'vision', 'figure')]),
    ).toEqual({ office: [2, 3], scan: [2], drawing: [] });
    expect(pageLanesOf([sheet(1, 'scan'), sheet(2, 'vector_text')])).toEqual({
      office: [],
      scan: [],
      drawing: null,
    });
  });

  it("a book: a drawing-lane page is the drawing Agent's, not the Scan reader's", () => {
    expect(
      pageLanesOf([
        book(1, 'vision', 'scan', used('document')),
        book(2, 'vision', 'scan', used('pid')),
        book(3, 'text', null, used('isometric')),
      ]),
    ).toEqual({ office: [1], scan: [1], drawing: [2, 3] });
  });

  it("a drawing file: an office page with no text layer is the office Agent's", () => {
    expect(
      pageLanesOf([
        sheet(1, 'scan', used('table')),
        sheet(2, 'raster_with_text', used('document')),
        sheet(3, 'scan_hidden_text', used('document')),
        sheet(4, 'scan', used('isometric')),
        sheet(5, 'scan'),
      ]),
    ).toEqual({ office: [1, 2], scan: [1, 2], drawing: [3, 4, 5] });
  });

  it('a page of a live read under 0.75 keeps its picture: the office Agent reads it, a typed page too', () => {
    const rows = [
      book(1, 'text', null, used('document', 0.7)),
      book(2, 'text', null, { 'Kind from': 'rules: low confidence', 'Decider confidence': 0.5 }),
      book(3, 'text', null, { 'Kind from': 'rules: shadow', 'Decider confidence': 0.5 }),
      book(4, 'text', null, used('document', 0.75)),
    ];
    expect(pageLanesOf(rows, true).office).toEqual([1, 2]);
    expect(pageLanesOf(rows, true).scan).toEqual([]);
    // Shadow (the default): no picture is kept.
    expect(pageLanesOf(rows).office).toEqual([]);
    // In a drawing file too, a drawing page with a low answer.
    expect(pageLanesOf([sheet(1, 'vector_text', used('pfd', 0.65))], true)).toEqual({
      office: [1],
      scan: [],
      drawing: null,
    });
  });
});
