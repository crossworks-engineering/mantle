/**
 * Behavioural tests for update_persona: the tool that lets an agent edit
 * its OWN standing behaviour. It had no test.
 *
 * Self-scoping is the whole design: the tool writes to whichever agent is
 * running the turn, resolved from `ctx.agent.slug` + `ctx.ownerId`, so the
 * model can neither pick a target agent nor reach another owner's row. The
 * tests pin that the lookup is bound to BOTH values, and that a call with
 * no agent context is refused before any query.
 *
 * The other property is "no silent success". A `remove_refs` that matches
 * no active note must come back as an error, not as a write of the
 * unchanged array: otherwise "stop using bullet lists" is acknowledged and
 * nothing changes.
 *
 * The DB edge is a `db.select().from().where().limit()` read and a
 * `db.update().set().where()` write, both stubbed; the pure resolution in
 * `applyPersonaUpdate` runs for real so the retire/add outcome is the actual
 * one. Owner binding is read off the drizzle predicate's bound params.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Param, SQL } from 'drizzle-orm';

const agentRows: Array<{ id: string; personaNotes: unknown[] }> = [];
const selectChain = {
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  limit: vi.fn(async () => agentRows),
};
const updateWhere = vi.fn(async (_pred: unknown) => undefined);
const updateSet = vi.fn((_v: unknown) => ({ where: updateWhere }));

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  return {
    ...actual,
    db: {
      ...actual.db,
      select: vi.fn(() => selectChain),
      update: vi.fn(() => ({ set: updateSet })),
    },
  };
});

import { db } from '@mantle/db';
import { PERSONA_TOOLS } from './builtins-persona';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const noAgent: ToolHandlerContext = { ownerId: 'o1' };
const ctx: ToolHandlerContext = {
  ownerId: 'o1',
  agent: { slug: 'responder', depth: 1, delegateTo: [] },
};

const tool = PERSONA_TOOLS.find((t) => t.slug === 'update_persona')!;

type Result = Awaited<ReturnType<BuiltinToolDef['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): Record<string, unknown> {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output as Record<string, unknown>;
}

/** Every literal bound into a drizzle predicate, in order. */
function boundParams(node: unknown): unknown[] {
  if (node instanceof SQL) return node.queryChunks.flatMap(boundParams);
  if (node instanceof Param) return [node.value];
  return [];
}

const BULLETS = { id: 'n-bullets', kind: 'style', content: 'Uses bullet lists.', at: 't0' };
const FORMAL = { id: 'n-formal', kind: 'style', content: 'Formal tone.', at: 't0' };

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks clears CALLS, not implementations: re-establish defaults.
  agentRows.splice(0, agentRows.length, { id: 'a1', personaNotes: [BULLETS, FORMAL] });
  selectChain.from.mockReturnThis();
  selectChain.where.mockReturnThis();
  selectChain.limit.mockImplementation(async () => agentRows);
  updateSet.mockImplementation(() => ({ where: updateWhere }));
  updateWhere.mockResolvedValue(undefined);
});

describe('update_persona', () => {
  it('refuses outside an agent turn, before any query', async () => {
    const err = errorOf(await tool.handler({ add: { kind: 'style', content: 'x' } }, noAgent));
    expect(err).toMatch(/agent turn/);
    expect(db.select).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('refuses an empty update (bad kind, blank content, no refs) before any query', async () => {
    expect(errorOf(await tool.handler({ add: { kind: 'mood', content: 'x' } }, ctx))).toMatch(
      /Nothing to do/,
    );
    expect(errorOf(await tool.handler({ add: { kind: 'style', content: '  ' } }, ctx))).toMatch(
      /Nothing to do/,
    );
    expect(db.select).not.toHaveBeenCalled();
  });

  it('looks the agent up by owner AND slug, and refuses when it is not theirs', async () => {
    agentRows.splice(0, agentRows.length);

    const err = errorOf(await tool.handler({ remove_refs: ['n-bullets'] }, ctx));

    expect(err).toMatch(/responder.*not found/);
    expect(boundParams(selectChain.where.mock.calls[0]![0])).toEqual(['o1', 'responder']);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('refuses refs that match no active note rather than writing the array back', async () => {
    const err = errorOf(await tool.handler({ remove_refs: ['n-nope'] }, ctx));
    expect(err).toMatch(/No matching active persona notes/);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('adds the note, retires the superseded one, and writes to the resolved agent row', async () => {
    const res = await tool.handler(
      {
        add: { kind: 'style', content: 'Prefers prose, no bullet lists.' },
        supersede_refs: ['n-bullets'],
        reason: 'user asked',
      },
      ctx,
    );

    const set = updateSet.mock.calls[0]![0] as unknown as {
      personaNotes: Record<string, unknown>[];
    };
    const byId = Object.fromEntries(set.personaNotes.map((n) => [n.id, n]));
    // The superseded note is retired, not deleted, and points at its successor.
    expect(byId['n-bullets']).toMatchObject({ retiredReason: 'superseded' });
    expect(typeof byId['n-bullets']!.retiredAt).toBe('string');
    // An unrelated note is untouched.
    expect(byId['n-formal']).toEqual(FORMAL);
    const added = set.personaNotes.find((n) => n.content === 'Prefers prose, no bullet lists.')!;
    expect(added.kind).toBe('style');
    expect(byId['n-bullets']!.supersededBy).toBe(added.id);
    // The write targets the row the read resolved, by id.
    expect(boundParams(updateWhere.mock.calls[0]![0])).toEqual(['a1']);

    expect(outputOf(res)).toMatchObject({
      added: { kind: 'style', content: 'Prefers prose, no bullet lists.' },
      retired: [{ ref: 'n-bullets', reason: 'superseded' }],
      active_note_count: 2,
    });
  });

  it('supersede_refs without an add retires nothing (no replacement, no write)', async () => {
    const err = errorOf(await tool.handler({ supersede_refs: ['n-bullets'] }, ctx));
    expect(err).toMatch(/Nothing to do/);
    expect(db.update).not.toHaveBeenCalled();
  });
});
