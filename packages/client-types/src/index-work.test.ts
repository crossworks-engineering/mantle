/**
 * What a write re-indexes (arch plan A10 #7), from the kind registry's
 * `indexed` field, against the matrix recorded on main
 * (server/web/server/a10-content-changed.main.json) with the changes named
 * cell by cell (a10-content-changed.changes.json).
 *
 * The db test there runs each write path through its real service; this
 * pins the registry to the same cells, so a field's work cannot change
 * without a named cell. Creates, moves and deletes are not field changes
 * (the INSERT trigger announces a create; a move or a delete re-indexes
 * nothing), and the `-same` cells test the services' value compare, not the
 * registry: those are the db test's alone.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ITEM_KINDS, ITEM_KIND_NAMES, indexWorkFor, kindSpecOf } from './kinds';

const DIR = join(__dirname, '../../../server/web/server');
const main = JSON.parse(readFileSync(join(DIR, 'a10-content-changed.main.json'), 'utf8')) as Record<
  string,
  string
>;
const changes = JSON.parse(readFileSync(join(DIR, 'a10-content-changed.changes.json'), 'utf8')) as {
  cells: Record<string, { now: string }>;
};

/** The registry field a cell's write path changes, by path. */
const FIELD_OF_PATH: Record<string, Record<string, string>> = {
  '*': { rename: 'title', tags: 'tags' },
  draw: { commit: 'scene' },
  page: { commit: 'doc', 'edit:doc-reindex-false': 'doc' },
  secret: { 'edit:note': 'sealed' },
  contact: { 'edit:cell': 'cell' },
  file: { indexing: 'indexing' },
};

function fieldOf(kind: string, path: string): string | null {
  const own = FIELD_OF_PATH[kind]?.[path] ?? FIELD_OF_PATH['*']?.[path];
  if (own) return own;
  const m = /^edit:([a-z_]+)$/.exec(path);
  return m ? m[1]! : null;
}

describe('the kind registry says what a write re-indexes (A10 #7)', () => {
  const now: Record<string, string> = { ...main };
  for (const [k, v] of Object.entries(changes.cells)) now[k] = v.now;
  const cells = Object.entries(now).filter(([key]) => {
    const [kind, path] = key.split('|') as [string, string];
    return !path.endsWith('-same') && fieldOf(kind, path) !== null;
  });

  it('covers the field cells of the recorded matrix', () => {
    expect(cells.length).toBeGreaterThan(30);
  });

  it.each(cells)('%s', (key, want) => {
    const [kind, path] = key.split('|') as [string, string];
    const field = fieldOf(kind, path)!;
    expect(Object.keys(kindSpecOf(kind)!.indexed), `${kind} names ${field}`).toContain(field);
    expect(indexWorkFor(kind, [field]) ?? 'none').toBe(want);
  });

  it('a write takes the most work any changed field asks for, once', () => {
    expect(indexWorkFor('note', ['title', 'content'])).toBe('extract');
    expect(indexWorkFor('note', ['title', 'tags'])).toBe('embed');
    expect(indexWorkFor('note', ['tags'])).toBeNull();
    expect(indexWorkFor('note', [])).toBeNull();
    expect(indexWorkFor('table', ['cells'])).toBe('embed');
    expect(indexWorkFor('table', ['cells', 'schema'])).toBe('extract');
  });

  it('a field or a kind the registry does not name asks for nothing', () => {
    expect(indexWorkFor('note', ['nonsense'])).toBeNull();
    expect(indexWorkFor('not_a_kind', ['title'])).toBeNull();
    expect(indexWorkFor('note', ['toString'])).toBeNull();
  });

  it('only a kind the extractor reads, or an app, re-indexes on a write', () => {
    // An app is not extracted by default (a worker's target_types may add
    // it), and its publish re-indexes as it did on main.
    for (const t of ITEM_KIND_NAMES) {
      const works = Object.values(ITEM_KINDS[t].indexed as Record<string, unknown>).filter(Boolean);
      if (works.length && !ITEM_KINDS[t].extract) expect(t).toBe('app');
    }
  });

  it('never asks a model pass of a title alone where main did not', () => {
    // The kinds whose rename already re-extracted on main (the title is in
    // the body the summary reads); every other title only re-embeds.
    const extractTitle = ITEM_KIND_NAMES.filter(
      (t) => (ITEM_KINDS[t].indexed as Record<string, unknown>).title === 'extract',
    );
    expect(extractTitle).toEqual(['secret', 'task', 'event']);
  });
});
