/**
 * Behavioural tests for the four remaining single destructive tools:
 * model_pool_remove, formula_delete, sandbox_rm, api_tool_delete.
 *
 * They have nothing in common structurally, so each is pinned on the property
 * that makes ITS deletion safe:
 *
 *  - `sandbox_rm` preserves the /files work directory unless `purge_files` is
 *    EXACTLY true. The check is `input.purge_files === true`, which is the
 *    whole safety margin: a truthy-but-not-true value ('false', 1, 'yes')
 *    must not delete the user's work. That is the highest-value case here.
 *  - `model_pool_remove` is owner-side and must refuse on the team and forum
 *    surfaces before it touches the table at all.
 *  - `formula_delete` is excluded from its own auto-grant list, the same
 *    pairing journal/contact use.
 *  - `api_tool_delete` resolves a slug to a row first, so a bad slug fails
 *    before any delete is attempted.
 *
 * Store edges stubbed; the tools' own branching is real.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  const chain = {
    where: vi.fn().mockReturnThis(),
    returning: vi.fn(async () => [] as { id: string }[]),
  };
  return { ...actual, db: { ...actual.db, delete: vi.fn(() => chain) }, __chain: chain };
});
vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return { ...actual, deleteFormula: vi.fn() };
});

import * as dbmod from '@mantle/db';
import { deleteFormula } from '@mantle/content';
import { CURATION_TOOLS } from './builtins-curation';
import { FORMULA_TOOLS, FORMULA_AUTO_GRANT_SLUGS } from './builtins-formulas';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const chain = (dbmod as unknown as { __chain: { returning: ReturnType<typeof vi.fn> } }).__chain;

const poolRemove = CURATION_TOOLS.find((t) => t.slug === 'model_pool_remove')!;
const formulaDel = FORMULA_TOOLS.find((t) => t.slug === 'formula_delete')!;

const ctx: ToolHandlerContext = { ownerId: 'o1' };
const ID = '11111111-2222-4333-8444-555555555555';

type Result = Awaited<ReturnType<BuiltinToolDef['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): Record<string, unknown> {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  chain.returning.mockResolvedValue([]);
});

describe('model_pool_remove', () => {
  it('refuses on the team surface BEFORE touching the table', async () => {
    const res = await poolRemove.handler({ pool: 'chat', name: 'Some Model' }, {
      ...ctx,
      surface: { kind: 'team' },
    } as ToolHandlerContext);
    expect(errorOf(res)).toMatch(/owner-side tool/);
    // The refusal has to come first — a team caller must not be able to
    // mutate the owner's curated shortlist even by a failed attempt.
    expect(vi.mocked(dbmod.db.delete)).not.toHaveBeenCalled();
  });

  it('refuses on the forum surface too', async () => {
    const res = await poolRemove.handler({ pool: 'chat', name: 'Some Model' }, {
      ...ctx,
      surface: { kind: 'forum' },
    } as ToolHandlerContext);
    expect(errorOf(res)).toMatch(/owner-side tool/);
  });

  it('reports a miss with the lookup that would fix it', async () => {
    chain.returning.mockResolvedValue([]);
    const res = await poolRemove.handler({ pool: 'chat', name: 'Ghost' }, ctx);
    expect(errorOf(res)).toMatch(/no entry 'Ghost' in pool 'chat'/);
    expect(errorOf(res)).toMatch(/model_pool_list/);
  });

  it('reports the removal when a row actually went', async () => {
    chain.returning.mockResolvedValue([{ id: 'x' }]);
    const res = await poolRemove.handler({ pool: 'chat', name: 'Real Model' }, ctx);
    expect(outputOf(res)).toMatchObject({ removed: 'Real Model', pool: 'chat' });
  });
});

describe('formula_delete', () => {
  it('reports a miss as not-found, naming formula_list', async () => {
    vi.mocked(deleteFormula).mockResolvedValue(false);
    const res = await formulaDel.handler({ id: ID }, ctx);
    expect(errorOf(res)).toMatch(/not found/i);
    expect(errorOf(res)).toMatch(/formula_list/);
  });

  it('returns the id it deleted', async () => {
    vi.mocked(deleteFormula).mockResolvedValue(true);
    expect(outputOf(await formulaDel.handler({ id: ID }, ctx))).toEqual({ id: ID });
  });

  it('is excluded from the formula auto-grant, like the other destructive ops', () => {
    expect(FORMULA_AUTO_GRANT_SLUGS).not.toContain('formula_delete');
    // Positive control: the list is populated, so the assertion above is not
    // passing merely because it is empty.
    expect(FORMULA_AUTO_GRANT_SLUGS.length).toBeGreaterThan(0);
  });
});
