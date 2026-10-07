import { describe, expect, it } from 'vitest';
import {
  CORPUS_MAP_MAX_CHARS,
  corpusTitleKey,
  renderCorpusMapBlock,
  type CorpusMapEntry,
} from './messages';

const entry = (over: Partial<CorpusMapEntry>): CorpusMapEntry => ({
  nodeId: '00000000-0000-4000-8000-000000000000',
  type: 'page',
  title: 'Untitled',
  branch: 'pages',
  summary: null,
  ...over,
});

const id = (i: number) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`;
/** A word unique to `i` in letters only (digits do not count in a fold key). */
const word = (i: number) =>
  String.fromCharCode(97 + (Math.floor(i / 26) % 26)) + String.fromCharCode(97 + (i % 26));

describe('renderCorpusMapBlock', () => {
  it('returns null for an empty map (no block emitted)', () => {
    expect(renderCorpusMapBlock([])).toBeNull();
  });

  it('groups by branch, sorts branches and titles, and tags each entry with type#shortid', () => {
    const out = renderCorpusMapBlock([
      entry({ title: 'Zeta', branch: 'pages', nodeId: 'aaaaaaaa-0000-4000-8000-000000000000' }),
      entry({ title: 'Alpha', branch: 'pages', nodeId: 'bbbbbbbb-0000-4000-8000-000000000000' }),
      entry({ title: 'Grid', branch: 'files', type: 'file' }),
    ])!;
    expect(out.indexOf('files (1):')).toBeGreaterThan(-1);
    expect(out.indexOf('files (1):')).toBeLessThan(out.indexOf('pages (2):'));
    expect(out.indexOf('"Alpha"')).toBeLessThan(out.indexOf('"Zeta"'));
    expect(out).toContain('(page#aaaaaaaa)');
    expect(out).toContain('(file#00000000)');
  });

  it('says a complete map is complete, so the model may rely on absence', () => {
    const out = renderCorpusMapBlock([entry({ title: 'Doc' })])!;
    expect(out).toContain('Anything not listed here does not exist');
  });

  it('leaves page summaries out (the title and a search cover them)', () => {
    const out = renderCorpusMapBlock([entry({ title: 'Doc', summary: 'A long summary.' })])!;
    expect(out).not.toContain('A long summary');
  });

  it('keeps a table schema digest in brackets', () => {
    const out = renderCorpusMapBlock([
      entry({
        title: 'Cars',
        type: 'table',
        branch: 'tables',
        summary: 'Fleet register.',
        schema: 'Fleet(2r): Model, Make, Year, EV',
      }),
      entry({ title: 'Plain', schema: null }),
    ])!;
    expect(out).toContain('"Cars" (table#00000000) [Fleet(2r): Model, Make, Year, EV]');
    expect(out).not.toContain('Plain" (page#00000000) ['); // no empty brackets
  });

  it('is byte-stable regardless of input order when everything fits (prompt-cache friendliness)', () => {
    const a = entry({ title: 'A' });
    const b = entry({ title: 'B', branch: 'files', type: 'file' });
    expect(renderCorpusMapBlock([a, b])).toBe(renderCorpusMapBlock([b, a]));
  });

  it('folds three or more near-identical file titles into one line naming the newest', () => {
    const f = (title: string, i: number) =>
      entry({ title, type: 'file', branch: 'files', nodeId: id(i) });
    const out = renderCorpusMapBlock([
      f('screenshot-2026-08-25-at-10-56-37.png', 1),
      f('screenshot-2026-08-25-at-10-55-12.png', 2),
      f('screenshot-2026-08-24-at-09-01-00.png', 3),
      f('site-photo.jpg', 4),
    ])!;
    expect(out).toContain(
      '"screenshot-2026-08-25-at-10-56-37.png" (file#00000001) +2 more like it',
    );
    expect(out).not.toContain('file#00000002');
    expect(out).toContain('"site-photo.jpg"');
    // A fold hides ids, so the map no longer claims to be complete.
    expect(out).toContain('may still exist');
  });

  it('never folds dated or numbered titles that are not files', () => {
    // The memory benchmark's sessions, meeting notes, invoices: the number is
    // the meaning, so each keeps its own line.
    const out = renderCorpusMapBlock(
      [1, 2, 3, 4].map((n) =>
        entry({
          title: `Conversation ${n}, Monday ${n} May 2023`,
          type: 'note',
          branch: 'notes',
          nodeId: id(n),
        }),
      ),
    )!;
    for (const n of [1, 2, 3, 4])
      expect(out).toContain(`"Conversation ${n}, Monday ${n} May 2023"`);
    expect(out).not.toContain('more like it');
  });

  it('folds exact duplicate titles of any type', () => {
    const out = renderCorpusMapBlock(
      [1, 2, 3].map((n) => entry({ title: 'Untitled draft', nodeId: id(n) })),
    )!;
    expect(out).toContain('"Untitled draft" (page#00000001) +2 more like it');
  });

  it('does not fold a pair', () => {
    const out = renderCorpusMapBlock([
      entry({ title: 'AUDIT: client logins, part 1', nodeId: id(1) }),
      entry({ title: 'AUDIT: client logins, part 2', nodeId: id(2) }),
    ])!;
    expect(out).toContain('page#00000001');
    expect(out).toContain('page#00000002');
  });

  it('shares the budget across branches, so a late branch is never starved', () => {
    // Many long page titles, then one table and one task. The old renderer
    // filled the budget alphabetically and never reached `tables`/`tasks`.
    const pages = Array.from({ length: 200 }, (_, i) =>
      entry({ title: `Notes on ${word(i)} and a reasonably long tail`, nodeId: id(i) }),
    );
    const out = renderCorpusMapBlock([
      ...pages,
      entry({ title: 'Fleet', type: 'table', branch: 'tables', nodeId: id(900) }),
      entry({ title: 'Fix gate', type: 'task', branch: 'tasks', nodeId: id(901) }),
    ])!;
    expect(out).toContain('"Fleet" (table#00000900)');
    expect(out).toContain('"Fix gate" (task#00000901)');
    expect(out.length).toBeLessThan(CORPUS_MAP_MAX_CHARS + 400);
    expect(out).toContain('pages (200 items, newest shown):');
  });

  it('lists the newest items first when a branch is over budget', () => {
    const pages = Array.from({ length: 100 }, (_, i) =>
      entry({ title: `Subject ${word(i)} with a separate tail`, nodeId: id(i) }),
    );
    const out = renderCorpusMapBlock(pages, { maxChars: 1_000 })!;
    expect(out).toContain('page#00000000'); // newest (input order) kept
    expect(out).not.toContain('page#00000099'); // oldest dropped
  });

  it('prints the corpus-wide total when it exceeds the listed items', () => {
    const out = renderCorpusMapBlock([entry({ title: 'Doc' })], { totals: { pages: 412 } })!;
    expect(out).toContain('pages (412 items, newest shown):');
    expect(out).toContain('may still exist');
  });

  it('carries the upstream truncation flag even when the budget is not hit', () => {
    const out = renderCorpusMapBlock([entry({})], { truncated: true })!;
    expect(out).toContain('may still exist');
  });

  it('snips a title that is a whole prompt', () => {
    const out = renderCorpusMapBlock([
      entry({ title: 'y'.repeat(300), type: 'file', branch: 'files' }),
    ])!;
    expect(out).toContain('…');
    expect(out).not.toContain('y'.repeat(100));
  });
});

describe('corpusTitleKey', () => {
  it('ignores digits, case, punctuation and the file extension', () => {
    expect(corpusTitleKey('Screenshot-2026-08-25-at-10-56.png')).toBe(
      corpusTitleKey('screenshot 2026-08-25 at 10.55.PNG'),
    );
  });

  it('keeps titles apart that differ in words', () => {
    expect(corpusTitleKey('Spike 15: Claude cache')).not.toBe(
      corpusTitleKey('Spike 16: Rea prefix'),
    );
  });
});
