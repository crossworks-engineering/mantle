import { beforeEach, describe, expect, it, vi } from 'vitest';

// writeLearnedEntries with its edges stubbed: the Journal read (what the agent
// already knows) and the Journal write.
const h = vi.hoisted(() => ({
  known: [] as Array<{ data: Record<string, unknown> }>,
  created: [] as Array<Record<string, unknown>>,
}));

vi.mock('@mantle/db', async () => {
  const actual = await vi.importActual<typeof import('@mantle/db')>('@mantle/db');
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => h.known,
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

import { writeLearnedEntries } from './persona-notes-journal';

beforeEach(() => {
  h.known = [{ data: { kind: 'preference', body: 'The user prefers British English spelling.' } }];
  h.created = [];
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
