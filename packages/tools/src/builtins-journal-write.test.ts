/**
 * Behavioural tests for journal_create, journal_update and
 * journal_resolve_gap. None had one.
 *
 * The journal is two lanes in one node type, and the lane an entry lands in
 * is decided by PROVENANCE: who wrote it. The file's own header says the
 * author is stamped server-side from the tool-loop context and "the model
 * cannot spoof authorship". That is the property worth a test: an agent
 * that could write `author: 'user'` into its own call would be putting words
 * into the "# About the user" block every other agent carries.
 *
 * So the create and resolve arms assert the author reaching the store comes
 * from `ctx.agent`, and that a model-supplied `author` argument is ignored.
 *
 * The store is stubbed; the tools' guards, coercion and stamping are real.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return {
    ...actual,
    createJournal: vi.fn(),
    updateJournal: vi.fn(),
    resolveGapEntry: vi.fn(),
    nodeUrl: (id: string) => `https://brain.test/n/${id}`,
  };
});

import { createJournal, updateJournal, resolveGapEntry } from '@mantle/content';
import { JOURNAL_TOOLS } from './builtins-journal';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const userCtx: ToolHandlerContext = { ownerId: 'o1' };
const agentCtx: ToolHandlerContext = {
  ownerId: 'o1',
  agent: { slug: 'responder', depth: 1, delegateTo: [] },
};
const ID = '11111111-2222-4333-8444-555555555555';
const ANSWER_ID = '22222222-2222-4333-8444-555555555555';

const create = JOURNAL_TOOLS.find((t) => t.slug === 'journal_create')!;
const update = JOURNAL_TOOLS.find((t) => t.slug === 'journal_update')!;
const resolve = JOURNAL_TOOLS.find((t) => t.slug === 'journal_resolve_gap')!;

type Result = Awaited<ReturnType<BuiltinToolDef['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): Record<string, unknown> {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output as Record<string, unknown>;
}

function journalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    title: 'Ops lead',
    body: 'I lead the ops team',
    author: 'user',
    agentSlug: null,
    kind: 'identity',
    status: null,
    entryDate: null,
    tags: [],
    summary: null,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createJournal).mockResolvedValue(journalRow() as never);
  vi.mocked(updateJournal).mockResolvedValue(journalRow() as never);
});

describe('journal_create', () => {
  it('refuses a blank body WITHOUT calling the store', async () => {
    expect(errorOf(await create.handler({ body: '  ', kind: 'identity' }, userCtx))).toMatch(
      /body/,
    );
    expect(createJournal).not.toHaveBeenCalled();
  });

  it('stamps author=user when there is no agent context', async () => {
    const res = await create.handler({ body: 'I lead the ops team', kind: 'identity' }, userCtx);

    expect(createJournal).toHaveBeenCalledWith(
      'o1',
      expect.objectContaining({
        body: 'I lead the ops team',
        kind: 'identity',
        author: 'user',
        agentSlug: undefined,
      }),
    );
    expect(outputOf(res)).toMatchObject({ id: ID, kind: 'identity' });
  });

  it('stamps author=agent + slug from ctx and IGNORES a model-supplied author', async () => {
    await create.handler(
      // The spoof attempt: an agent claiming the user lane by argument.
      { body: 'Prefers short answers', kind: 'lesson', author: 'user', agent_slug: 'other' },
      agentCtx,
    );

    expect(createJournal).toHaveBeenCalledWith(
      'o1',
      expect.objectContaining({ author: 'agent', agentSlug: 'responder' }),
    );
  });

  it('surfaces a store rejection (e.g. an unknown kind) as the tool error', async () => {
    vi.mocked(createJournal).mockRejectedValue(new Error("unknown kind 'rant'"));
    expect(errorOf(await create.handler({ body: 'x', kind: 'rant' }, userCtx))).toMatch(
      /unknown kind/,
    );
  });
});

describe('journal_update', () => {
  it('refuses a blank id WITHOUT calling the store', async () => {
    expect(errorOf(await update.handler({ id: '', body: 'x' }, userCtx))).toMatch(/id/i);
    expect(updateJournal).not.toHaveBeenCalled();
  });

  it('reports a miss as a failure that names journal_list', async () => {
    vi.mocked(updateJournal).mockResolvedValue(null);
    const err = errorOf(await update.handler({ id: ID, body: 'x' }, userCtx));
    expect(err).toMatch(/not found/i);
    expect(err).toMatch(/journal_list/);
  });

  it('patches only the named fields, leaving the rest undefined', async () => {
    const res = await update.handler({ id: ID, kind: 'preference', tags: ['tone', 3] }, userCtx);

    expect(updateJournal).toHaveBeenCalledWith(
      'o1',
      ID,
      expect.objectContaining({
        kind: 'preference',
        tags: ['tone'],
        body: undefined,
        title: undefined,
        entryDate: undefined,
      }),
    );
    expect(outputOf(res)).toMatchObject({ id: ID });
  });
});

describe('journal_resolve_gap', () => {
  it('requires both id and answer, and touches nothing without them', async () => {
    expect(errorOf(await resolve.handler({ id: '', answer: 'x' }, userCtx))).toMatch(/id/i);
    expect(errorOf(await resolve.handler({ id: ID, answer: '  ' }, userCtx))).toMatch(/answer/);
    expect(resolveGapEntry).not.toHaveBeenCalled();
  });

  it('reports a non-gap (or missing) entry with the exact listing that finds open ones', async () => {
    vi.mocked(resolveGapEntry).mockResolvedValue(null);
    const err = errorOf(await resolve.handler({ id: ID, answer: 'Fridays' }, userCtx));
    expect(err).toMatch(/not a gap entry/);
    expect(err).toMatch(/kind='gap'/);
    expect(err).toMatch(/status='open'/);
  });

  it('resolves under the owner with runtime provenance and returns both entries', async () => {
    vi.mocked(resolveGapEntry).mockResolvedValue({
      gap: journalRow({ kind: 'gap', status: 'resolved', author: 'agent' }),
      answer: journalRow({ id: ANSWER_ID, kind: 'context', body: 'Fridays' }),
    } as never);

    const res = await resolve.handler(
      { id: ID, answer: '  Fridays  ', answer_kind: 'context', author: 'user' },
      agentCtx,
    );

    expect(resolveGapEntry).toHaveBeenCalledWith('o1', ID, {
      answer: 'Fridays',
      answerKind: 'context',
      author: 'agent',
      agentSlug: 'responder',
    });
    const out = outputOf(res);
    expect(out.resolved).toMatchObject({ id: ID, status: 'resolved' });
    expect(out.answer).toMatchObject({ id: ANSWER_ID, kind: 'context' });
  });
});
