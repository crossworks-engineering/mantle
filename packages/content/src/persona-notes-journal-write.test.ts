import { beforeEach, describe, expect, it, vi } from 'vitest';

// writeLearnedEntries with its edges stubbed: the Journal read (what the agent
// already knows) and the Journal write.
const h = vi.hoisted(() => ({
  known: [] as Array<{ data: Record<string, unknown> }>,
  existing: [] as Array<{ ref: string }>,
  created: [] as Array<Record<string, unknown>>,
}));

vi.mock('@mantle/db', async () => {
  const actual = await vi.importActual<typeof import('@mantle/db')>('@mantle/db');
  // `where` ends the apply's query (already-converted refs); `limit` ends
  // the known-entries query.
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => h.known,
    then: (res: (v: unknown) => unknown) => res(h.existing),
  };
  return { ...actual, db: { select: () => chain } };
});
vi.mock('./journal', async () => {
  const actual = await vi.importActual<typeof import('./journal')>('./journal');
  return {
    ...actual,
    createJournal: vi.fn(async (_owner: string, e: Record<string, unknown>) => {
      h.created.push(e);
      return { id: `j${h.created.length}` };
    }),
  };
});

import { applyConversionPlan, type ConversionPlan } from './persona-notes-journal';
import { writeLearnedEntries } from './persona-notes-journal';

beforeEach(() => {
  h.known = [{ data: { kind: 'preference', body: 'The user prefers British English spelling.' } }];
  h.created = [];
  h.existing = [];
});

describe('applyConversionPlan', () => {
  const entry = (ref: string, extra: Record<string, unknown> = {}) => ({
    ref,
    content: `${ref} rule`,
    noteKind: 'style',
    kind: 'preference',
    scope: 'general' as const,
    topic: '',
    ...extra,
  });
  const plan = (entries: ReturnType<typeof entry>[]): ConversionPlan => ({
    version: 1,
    agentId: 'ag1',
    agentSlug: 'assistant',
    createdAt: '2026-09-23T00:00:00Z',
    model: 'm',
    entries,
  });

  it('creates each ref once, skips duplicates, retired notes and what already exists', async () => {
    h.existing = [{ ref: 'done' }];
    const r = await applyConversionPlan(
      'o1',
      plan([
        entry('a'),
        entry('a'), // two id-less notes with the same text share a ref
        entry('b', { duplicateOf: 'a' }),
        entry('gone'),
        entry('done'),
      ]),
      { skipRefs: new Set(['gone']) },
    );
    expect(r).toEqual({ created: 1, existing: 2, duplicates: 1, skipped: 1 });
    expect(h.created.map((e) => e.body)).toEqual(['a rule']);
    expect(h.created[0]).toMatchObject({ author: 'agent', agentSlug: 'assistant' });
  });

  it('a duplicate whose kept note was retired since the dry run takes its place', async () => {
    const r = await applyConversionPlan(
      'o1',
      plan([
        entry('kept', { kind: 'preference', scope: 'general' }),
        entry('copy1', { duplicateOf: 'kept', kind: 'expectation', scope: 'topic' }),
        entry('copy2', { duplicateOf: 'kept' }),
      ]),
      { skipRefs: new Set(['kept']) },
    );
    expect(h.created.map((e) => e.body)).toEqual(['copy1 rule']);
    // It takes the kept note's reviewed kind: a correction stays always on.
    expect(h.created[0]).toMatchObject({ kind: 'preference' });
    expect(r).toEqual({ created: 1, existing: 0, duplicates: 1, skipped: 1 });
  });

  it('a second apply of the same plan creates nothing', async () => {
    h.existing = [{ ref: 'a' }];
    const r = await applyConversionPlan('o1', plan([entry('a')]));
    expect(r.created).toBe(0);
    expect(r.existing).toBe(1);
  });
});

describe('writeLearnedEntries', () => {
  const correction = { kind: 'correction', content: 'The user prefers American English spelling.' };

  it('an explicit update_persona add is always written, even when it reads like a copy', async () => {
    const w = await writeLearnedEntries('o1', 'assistant', [correction], 'update_persona');
    expect(w).toEqual([{ kind: 'preference', content: correction.content }]);
    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({ author: 'agent', agentSlug: 'assistant' });
  });

  it('the reflector still skips a near-copy of what the agent knows', async () => {
    const w = await writeLearnedEntries(
      'o1',
      'assistant',
      [{ kind: 'style', content: 'The user prefers British English spelling.' }],
      'reflector',
    );
    expect(w).toEqual([]);
    expect(h.created).toHaveLength(0);
  });
});
