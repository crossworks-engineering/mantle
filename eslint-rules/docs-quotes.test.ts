import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  checkDocQuotes,
  headingsOf,
  matchHeading,
  namesHeading,
  normHeading,
  quotesIn,
  stepRefsIn,
} from './docs-quotes.mjs';

/**
 * The doc heading quote rule (scripts/docs-check.mjs, rule 3): a
 * `docs/<file>.md, "Heading"` quote names a heading that exists; a
 * docs/actors.md quote falls back to the history file and is counted, and
 * so is every docs/_archive/ quote and every unquoted step pointer to the
 * history: the gaming paths below each keep the count.
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
    expect(quotesIn('docs/a.md (see "this")')).toEqual([]);
  });

  it('reads the ("H") form, curly quotes, and the colon form as soft', () => {
    const text = [
      ' * docs/actors.md ("The actor',
      ' * kinds") and docs/b.md, ("Two")',
      '// docs/c.md, “Curly”; docs/d.md: "some words"',
    ].join('\n');
    expect(quotesIn(text).map((q) => [q.doc, q.quote, q.line, q.soft ?? false])).toEqual([
      ['docs/actors.md', 'The actor kinds', 1, false],
      ['docs/b.md', 'Two', 2, false],
      ['docs/c.md', 'Curly', 3, false],
      ['docs/d.md', 'some words', 3, true],
    ]);
  });

  it('reads an unquoted step pointer to the history, and nothing else', () => {
    const text = [
      ' * (docs/actors.md, A4 step 3b part 4) and (docs/actors.md, A6b).',
      ' * docs/actors.md, fixed by A6; docs/actors.md (F1) too',
      ' * the pre-check removal (docs/actors.md,',
      ' * R0 handover) and docs/_archive/actors-history.md, S3.',
      ' * Not: docs/actors.md, section 8; docs/actors.md, the actor kinds;',
      ' * docs/actors.md, "A6b handover"; docs/actors.md lists A4.',
    ].join('\n');
    expect(stepRefsIn(text).map((s) => [s.doc, s.step, s.line])).toEqual([
      ['docs/actors.md', 'A4', 1],
      ['docs/actors.md', 'A6b', 1],
      ['docs/actors.md', 'fixed by A6', 2],
      ['docs/actors.md', 'F1', 2],
      ['docs/actors.md', 'R0', 3],
      ['docs/_archive/actors-history.md', 'S3', 4],
    ]);
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
    // A word ends at a space or a mark, never inside a hyphenated word.
    expect(namesHeading(hs, 'Pre')).toBe(false);
    expect(namesHeading(hs, 'Pre-check deletions')).toBe(false);
    expect(normHeading('`3.` Passage windows: the lever')).toBe('passage windows: the lever');
  });

  it('fails a prefix of two or more headings, not a whole heading', () => {
    const hs = ['a6b handover', 'a6b fix round 1', 'a6b', 'gates', 'gates'];
    expect(matchHeading(hs, 'A6b')).toBe('exact');
    expect(matchHeading(hs, 'Gates')).toBe('exact');
    expect(matchHeading(['a6b handover', 'a6b fix round 1'], 'A6b')).toBe('ambiguous');
    expect(namesHeading(['a6b handover', 'a6b fix round 1'], 'A6b')).toBe(false);
    expect(matchHeading(['a6b handover', 'a6b handover'], 'A6b')).toBe('prefix');
    expect(matchHeading(hs, 'A7')).toBe(null);
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

    it('fails a quote that names two or more headings by a prefix', () => {
      put('docs/two.md', '# Two\n\n## Part 3 (tools)\n\n## Part 3 handover\n');
      put('d.ts', '// docs/two.md, "Part 3" and docs/two.md, "Part 3 handover"');
      const r = checkDocQuotes(root, ['d.ts'], []);
      expect(r.problems).toEqual([
        'd.ts:1: docs/two.md, "Part 3": names two or more headings by a prefix (quote one whole)',
      ]);
    });

    // Each way a history ref could be rewritten to leave the count keeps it:
    // the archive by name, the ("H") form, curly quotes, the colon form, and
    // the unquoted step pointer (its own count, actorsStepRefs).
    it('keeps the history count through every rewrite of the quote', () => {
      const ways = {
        'g1.ts': '// docs/_archive/actors-history.md, "Pre-check deletion"',
        'g2.ts': '// docs/actors.md ("Pre-check deletion")',
        'g3.ts': '// docs/actors.md, “Pre-check deletion”',
        'g4.ts': '// docs/actors.md: "Pre-check deletion"',
      };
      for (const [f, text] of Object.entries(ways)) {
        put(f, text);
        const r = checkDocQuotes(root, [f], []);
        expect([f, r.actorsHistoryRefs, r.problems]).toEqual([f, 1, []]);
      }
      put('g5.ts', '// docs/actors.md, A4 step 3b, and docs/_archive/actors-history.md, A6b');
      const r = checkDocQuotes(root, ['g5.ts'], []);
      expect([r.actorsHistoryRefs, r.actorsStepRefs, r.problems]).toEqual([0, 2, []]);
      // A colon quote of words, no heading, is no problem and no quote.
      put('g6.ts', '// docs/other.md: "not a heading at all"');
      expect(checkDocQuotes(root, ['g6.ts'], [])).toMatchObject({ quotes: 0, problems: [] });
      // An archive quote of no heading is a problem like any.
      put('g7.ts', '// docs/_archive/actors-history.md, "Never was"');
      expect(checkDocQuotes(root, ['g7.ts'], []).problems).toEqual([
        'g7.ts:1: docs/_archive/actors-history.md, "Never was": names no heading',
      ]);
    });

    it('fails a listed dangling quote that no longer dangles', () => {
      const r = checkDocQuotes(root, ['a.ts'], ['c.ts: docs/actors.md, "Never was"']);
      expect(r.problems).toEqual([
        'DANGLING lists c.ts: docs/actors.md, "Never was", which no longer dangles: remove the entry',
      ]);
    });
  });
});
