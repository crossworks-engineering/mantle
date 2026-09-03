/**
 * Behavioural tests for task_create, task_update and task_comment_add. None
 * had one.
 *
 * Two properties are worth pinning beyond the guard-then-store shape.
 *
 * The `todos` coercion is STRICT on purpose: a checklist item with no `text`
 * fails the whole call instead of being dropped, because `todos` replaces the
 * WHOLE list: a lenient parse would let one mis-named field wipe a
 * checklist and still report success. And on update, `''` and `[]` are
 * deliberate CLEARS (dueAt → null, tags → []) that the shared `strOpt`
 * helpers would have swallowed as "unchanged"; the test pins that the two
 * spellings reach the store differently.
 *
 * task_comment_add attributes from the RUNTIME context, never from model
 * arguments: an agent's slug resolves to its row (FK + display name), and a
 * context with no agent gets the neutral 'Assistant' with no lookup.
 *
 * The stores are stubbed; the tools' coercion, guards and attribution are real.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return {
    ...actual,
    createTask: vi.fn(),
    updateTask: vi.fn(),
    addNodeComment: vi.fn(),
    resolveAgentAuthor: vi.fn(),
    nodeUrl: (id: string) => `https://brain.test/n/${id}`,
  };
});

import { createTask, updateTask, addNodeComment, resolveAgentAuthor } from '@mantle/content';
import { TASK_TOOLS } from './builtins-tasks';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const ctx: ToolHandlerContext = { ownerId: 'o1' };
const agentCtx: ToolHandlerContext = {
  ownerId: 'o1',
  agent: { slug: 'responder', depth: 1, delegateTo: [] },
};
const ID = '11111111-2222-4333-8444-555555555555';

const create = TASK_TOOLS.find((t) => t.slug === 'task_create')!;
const update = TASK_TOOLS.find((t) => t.slug === 'task_update')!;
const comment = TASK_TOOLS.find((t) => t.slug === 'task_comment_add')!;

type Result = Awaited<ReturnType<BuiltinToolDef['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): Record<string, unknown> {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output as Record<string, unknown>;
}

const taskRow = {
  id: ID,
  title: 'Renew passport',
  status: 'open',
  priority: 'normal',
  dueAt: null,
};
const commentRow = {
  id: 'c1',
  nodeId: ID,
  authorKind: 'agent',
  authorName: 'Saskia',
  loginId: null,
  contactId: null,
  agentId: 'a1',
  body: 'Booked the slot',
  createdAt: new Date('2026-09-01T00:00:00Z'),
  editedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createTask).mockResolvedValue(taskRow as never);
  vi.mocked(updateTask).mockResolvedValue(taskRow as never);
  vi.mocked(addNodeComment).mockResolvedValue(commentRow as never);
  vi.mocked(resolveAgentAuthor).mockResolvedValue({ agentId: 'a1', name: 'Saskia' });
});

describe('task_create', () => {
  it('refuses a blank title WITHOUT calling the store', async () => {
    expect(errorOf(await create.handler({ title: '  ' }, ctx))).toMatch(/title/);
    expect(createTask).not.toHaveBeenCalled();
  });

  it('refuses a checklist item with no text, naming the fix, and writes nothing', async () => {
    const err = errorOf(
      await create.handler({ title: 'Plan', todos: [{ text: 'ok' }, { title: 'wrong key' }] }, ctx),
    );
    expect(err).toMatch(/todos\[1\]/);
    expect(err).toMatch(/text/);
    // A lenient parse would have stored ['ok'] and reported success.
    expect(createTask).not.toHaveBeenCalled();
  });

  it('creates under the owner with the coerced checklist and a null dueAt when omitted', async () => {
    const res = await create.handler(
      {
        title: ' Renew passport ',
        priority: 'high',
        tags: ['admin'],
        todos: [
          { text: 'Photos', done: true },
          { text: 'Form', done: 'yes' },
        ],
      },
      ctx,
    );

    expect(createTask).toHaveBeenCalledWith('o1', {
      title: 'Renew passport',
      body: undefined,
      status: undefined,
      priority: 'high',
      dueAt: null,
      tags: ['admin'],
      // `done` is only true for a literal true: 'yes' is not a tick.
      todos: [
        { id: undefined, text: 'Photos', done: true },
        { id: undefined, text: 'Form', done: false },
      ],
    });
    expect(outputOf(res)).toMatchObject({ id: ID, title: 'Renew passport' });
  });
});

describe('task_update', () => {
  it('refuses a blank id WITHOUT calling the store', async () => {
    expect(errorOf(await update.handler({ id: '', status: 'done' }, ctx))).toMatch(/id/i);
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('reports a miss as a failure that names task_list', async () => {
    vi.mocked(updateTask).mockResolvedValue(null);
    const err = errorOf(await update.handler({ id: ID, status: 'done' }, ctx));
    expect(err).toMatch(/not found/i);
    expect(err).toMatch(/task_list/);
  });

  it("treats '' and [] as CLEARS but omission as unchanged", async () => {
    await update.handler({ id: ID, dueAt: '', tags: [], body: '' }, ctx);
    expect(updateTask).toHaveBeenCalledWith(
      'o1',
      ID,
      expect.objectContaining({ dueAt: null, tags: [], body: '' }),
    );

    vi.mocked(updateTask).mockClear();
    await update.handler({ id: ID, status: 'done' }, ctx);
    expect(updateTask).toHaveBeenCalledWith(
      'o1',
      ID,
      expect.objectContaining({
        status: 'done',
        dueAt: undefined,
        tags: undefined,
        body: undefined,
      }),
    );
  });

  it('archived:true stamps a server-side archivedAt; archived:false clears it', async () => {
    await update.handler({ id: ID, archived: true }, ctx);
    const patch = vi.mocked(updateTask).mock.calls[0]![2] as { archivedAt?: unknown };
    expect(typeof patch.archivedAt).toBe('string');
    expect(Number.isNaN(Date.parse(patch.archivedAt as string))).toBe(false);

    vi.mocked(updateTask).mockClear();
    await update.handler({ id: ID, archived: false }, ctx);
    expect(updateTask).toHaveBeenCalledWith(
      'o1',
      ID,
      expect.objectContaining({ archivedAt: null }),
    );
  });
});

describe('task_comment_add', () => {
  it('requires id and a non-blank body, resolving nothing without them', async () => {
    expect(errorOf(await comment.handler({ id: '', body: 'x' }, agentCtx))).toMatch(/id/i);
    expect(errorOf(await comment.handler({ id: ID, body: '   ' }, agentCtx))).toMatch(/body/);
    expect(resolveAgentAuthor).not.toHaveBeenCalled();
    expect(addNodeComment).not.toHaveBeenCalled();
  });

  it('attributes to the calling agent resolved under the owner, ignoring model args', async () => {
    const res = await comment.handler(
      { id: ID, body: '  Booked the slot  ', author: 'owner', name: 'Jason' },
      agentCtx,
    );

    expect(resolveAgentAuthor).toHaveBeenCalledWith('o1', 'responder');
    expect(addNodeComment).toHaveBeenCalledWith(
      'o1',
      ID,
      { kind: 'agent', agentId: 'a1', name: 'Saskia' },
      'Booked the slot',
    );
    expect(outputOf(res)).toMatchObject({ id: 'c1', authorKind: 'agent', body: 'Booked the slot' });
  });

  it('falls back to the neutral Assistant name with no lookup when there is no agent', async () => {
    await comment.handler({ id: ID, body: 'note' }, ctx);
    expect(resolveAgentAuthor).not.toHaveBeenCalled();
    expect(addNodeComment).toHaveBeenCalledWith(
      'o1',
      ID,
      { kind: 'agent', agentId: undefined, name: 'Assistant' },
      'note',
    );
  });

  it('reports a task the owner does not hold as not found', async () => {
    vi.mocked(addNodeComment).mockResolvedValue(null);
    const err = errorOf(await comment.handler({ id: ID, body: 'x' }, ctx));
    expect(err).toMatch(/not found/i);
    expect(err).toMatch(/task_list/);
  });
});
