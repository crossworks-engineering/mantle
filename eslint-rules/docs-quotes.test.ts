import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkDocQuotes, headingsOf, namesHeading, normHeading, quotesIn } from './docs-quotes.mjs';

/**
 * The doc heading quote rule (scripts/docs-check.mjs, rule 3): a
 * `docs/<file>.md, "Heading"` quote names a heading that exists; a
 * docs/actors.md quote falls back to the history file and is counted.
 */
describe('doc heading quotes', () => {
  it('reads a quote on one line, wrapped over comment lines, and escaped', () => {
    const text = [
      '// see docs/a.md, "One heading".',
      ' * (docs/actors.md, "The login',
      ' * write gateway"). And docs/b.md "Spaced" too.',
      '"note": "x (docs/c.md, \\"Escaped (it)\\")"',
      '-- the comma at the end: docs/d.md,',
      '-- "Next line"',
    ].join('\n');
    expect(quotesIn(text).map((q) => [q.doc, q.quote, q.line])).toEqual([
      ['docs/a.md', 'One heading', 1],
      ['docs/actors.md', 'The login write gateway', 2],
      ['docs/b.md', 'Spaced', 3],
      ['docs/c.md', 'Escaped (it)', 4],
      ['docs/d.md', 'Next line', 5],
    ]);
  });

  it('is no quote when the path closes a string', () => {
    expect(quotesIn('"see docs/update-prod.md" and "more"')).toEqual([]);
  });

  it('reads headings and bold leads, not code fences', () => {
    const md = [
      '# Title',
      '## 4b. Contact shares: one item (0214)',
      '```',
      '## not a heading',
      '```',
      '- **Confirm first.** A write that places items',
      '**Where a new item lands:**',
      'plain text **bold inside** a line',
    ].join('\n');
    expect(headingsOf(md)).toEqual([
      'title',
      'contact shares: one item (0214)',
      'confirm first',
      'where a new item lands',
    ]);
  });

  it('names a heading by its text or a whole-word prefix', () => {
    const hs = ['pre-check deletion (a4 step 4)', 'a6b handover', 'scale curve on a corpus'];
    expect(namesHeading(hs, 'Pre-check deletion')).toBe(true);
    expect(namesHeading(hs, 'A6b handover')).toBe(true);
    expect(namesHeading(hs, 'Scale curve')).toBe(true);
    expect(namesHeading(hs, 'A6')).toBe(false);
    expect(namesHeading(hs, 'Pre-check')).toBe(true);
    expect(namesHeading(hs, 'Pre-check deletions')).toBe(false);
    expect(normHeading('`3.` Passage windows: the lever')).toBe('passage windows: the lever');
  });

  describe('a repo', () => {
    const root = mkdtempSync(join(tmpdir(), 'docs-quotes-'));
    const put = (path: string, text: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    afterAll(() => rmSync(root, { recursive: true, force: true }));
    put('docs/actors.md', '# Actors\n\n## 6. Who may do what\n');
    put('docs/_archive/actors-history.md', '# Old\n\n## Pre-check deletion (A4)\n');
    put('docs/other.md', '# Other\n\n## Real\n');
    const files = ['a.ts', 'b.sql', 'c.ts'];
    put('a.ts', '// docs/actors.md, "Who may do what" and docs/actors.md, "Pre-check deletion"');
    put('b.sql', '-- docs/other.md, "Real"; docs/other.md, "Gone"; docs/none.md, "X"');
    put('c.ts', '// docs/actors.md, "Never was"');

    it('resolves the spec first, the history second, and counts the history refs', () => {
      const r = checkDocQuotes(root, files, ['c.ts: docs/actors.md, "Never was"']);
      expect(r.quotes).toBe(6);
      expect(r.actorsHistoryRefs).toBe(1);
      expect(r.historyRefs).toEqual(['a.ts:1: docs/actors.md, "Pre-check deletion"']);
      expect(r.docQuotesDangling).toBe(1);
      expect(r.problems).toEqual([
        'b.sql:1: docs/other.md, "Gone": names no heading',
        'b.sql:1: docs/none.md, "X": the doc does not exist',
      ]);
      expect(r.actorsMdLines).toBe(3);
    });

    it('fails a listed dangling quote that no longer dangles', () => {
      const r = checkDocQuotes(root, ['a.ts'], ['c.ts: docs/actors.md, "Never was"']);
      expect(r.problems).toEqual([
        'DANGLING lists c.ts: docs/actors.md, "Never was", which no longer dangles: remove the entry',
      ]);
    });
  });
});
