/**
 * Behavioural tests for model_pool_set, the one curation WRITE that adds
 * to a pool. `builtins-misc-delete.test.ts` covers model_pool_remove.
 *
 * Three properties carry the tool's safety:
 *
 *  - Surface. It is owner-side: a team or forum caller is refused before the
 *    catalog or the table is touched, so a failed attempt cannot leak a
 *    curated shortlist change either.
 *  - Fit. The live catalog is consulted and a model that positively cannot do
 *    the pool's job is refused (the "Read images" trap: an image GENERATOR
 *    accepts pictures too). But the check is fail-OPEN: an unreachable
 *    catalog or an unknown slug must not block curation, because a routing
 *    outage at the provider is not a reason to lose the owner's shortlist.
 *  - Upsert by (owner, pool, name). An existing entry is updated in place
 *    with only the fields supplied, so a partial call cannot blank a price
 *    or a rating; a new one appends after the highest sibling position.
 *
 * The catalog is loaded through `fetch` and cached at module level for a few
 * minutes, so the outage test runs FIRST and the later tests share one
 * loaded catalog. The db chains are stubbed at select / update / insert.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const selectQueue: unknown[][] = [];
const whereArgs: unknown[] = [];

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  const select = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn(function (this: unknown, arg: unknown) {
      whereArgs.push(arg);
      return this;
    }),
    limit: vi.fn().mockReturnThis(),
    then: (res: (v: unknown) => void, rej?: (e: unknown) => void) =>
      Promise.resolve(selectQueue.shift() ?? []).then(res, rej),
  };
  const update = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn(function (this: unknown, arg: unknown) {
      whereArgs.push(arg);
      return this;
    }),
    returning: vi.fn(async () => [{ id: 'cm-existing' }]),
  };
  const insert = {
    values: vi.fn().mockReturnThis(),
    returning: vi.fn(async () => [{ id: 'cm-new' }]),
  };
  return {
    ...actual,
    db: {
      ...actual.db,
      select: vi.fn(() => select),
      update: vi.fn(() => update),
      insert: vi.fn(() => insert),
    },
    __update: update,
    __insert: insert,
  };
});

import * as dbmod from '@mantle/db';
import { CURATION_TOOLS } from './builtins-curation';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

type Chain = { set: ReturnType<typeof vi.fn>; values: ReturnType<typeof vi.fn> };
const update = (dbmod as unknown as { __update: Chain }).__update;
const insert = (dbmod as unknown as { __insert: Chain }).__insert;

const poolSet = CURATION_TOOLS.find((t) => t.slug === 'model_pool_set')!;
const ctx: ToolHandlerContext = { ownerId: 'o1' };

const ROUTES = [{ provider: 'openrouter', model: 'anthropic/claude-sonnet-5' }];
const GENERATOR = [{ provider: 'openrouter', model: 'openai/gpt-image-1' }];

/** What OpenRouter's /models returns for the two slugs the tests use: a
 *  text-out model that reads images, and an image GENERATOR. */
const CATALOG = {
  data: [
    {
      id: 'anthropic/claude-sonnet-5',
      name: 'Claude Sonnet 5',
      pricing: { prompt: '0.000003', completion: '0.000015' },
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
    },
    {
      id: 'openai/gpt-image-1',
      name: 'GPT Image 1',
      pricing: { prompt: '0.00001', completion: '0.00004' },
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['image'] },
    },
  ],
};

type Result = Awaited<ReturnType<BuiltinToolDef['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): Record<string, unknown> {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output as Record<string, unknown>;
}

/** Bound parameter values of a drizzle SQL tree, in order. */
function paramsOf(node: unknown, out: unknown[] = []): unknown[] {
  if (!node || typeof node !== 'object') return out;
  const o = node as { queryChunks?: unknown[]; value?: unknown; encoder?: unknown };
  if (Array.isArray(o.queryChunks)) for (const c of o.queryChunks) paramsOf(c, out);
  else if ('value' in o && 'encoder' in o) out.push(o.value);
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue.length = 0;
  whereArgs.length = 0;
  global.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => CATALOG,
    text: async () => '',
  })) as unknown as typeof fetch;
});

describe('model_pool_set', () => {
  it('refuses on the team and forum surfaces before touching anything', async () => {
    for (const kind of ['team', 'forum'] as const) {
      const res = await poolSet.handler({ pool: 'agents', name: 'Claude', routes: ROUTES }, {
        ...ctx,
        surface: { kind, contactId: 'c1', topicId: 't1' },
      } as ToolHandlerContext);
      expect(errorOf(res)).toMatch(/owner-side tool/);
    }
    expect(global.fetch).not.toHaveBeenCalled();
    expect(dbmod.db.select).not.toHaveBeenCalled();
  });

  it('rejects an unknown pool, a blank name and empty routes without a lookup', async () => {
    expect(
      errorOf(await poolSet.handler({ pool: 'nope', name: 'X', routes: ROUTES }, ctx)),
    ).toMatch(/unknown pool 'nope' — valid pools: agents/);
    expect(
      errorOf(await poolSet.handler({ pool: 'agents', name: ' ', routes: ROUTES }, ctx)),
    ).toMatch(/name is required/);
    expect(
      errorOf(
        await poolSet.handler(
          { pool: 'agents', name: 'X', routes: [{ provider: 'openrouter' }, 'junk'] },
          ctx,
        ),
      ),
    ).toMatch(/routes must contain at least one/);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(dbmod.db.select).not.toHaveBeenCalled();
  });

  it('fails OPEN when the catalog is unreachable: an outage must not block curation', async () => {
    // Runs before any successful load so nothing is cached yet.
    global.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    selectQueue.push([], []);
    const res = await poolSet.handler({ pool: 'vision', name: 'Sonnet', routes: ROUTES }, ctx);
    expect(outputOf(res)).toMatchObject({ inserted: true });
    expect(insert.values).toHaveBeenCalledTimes(1);
  });

  it('refuses an image GENERATOR in a text-out pool, before the table is touched', async () => {
    const res = await poolSet.handler(
      { pool: 'vision', name: 'GPT Image', routes: GENERATOR },
      ctx,
    );
    expect(errorOf(res)).toMatch(/GPT Image does not belong in 'vision'/);
    expect(errorOf(res)).toMatch(/OUTPUTS images/);
    expect(dbmod.db.select).not.toHaveBeenCalled();
    expect(insert.values).not.toHaveBeenCalled();
  });

  it('lets a text-out model that accepts images into the vision pool', async () => {
    selectQueue.push([], []);
    const res = await poolSet.handler({ pool: 'vision', name: 'Sonnet', routes: ROUTES }, ctx);
    expect(outputOf(res)).toMatchObject({ inserted: true, pool: 'vision', name: 'Sonnet' });
  });

  it('inserts a new entry under the owner, after the highest sibling, with a priced snapshot', async () => {
    selectQueue.push([], [{ position: 0 }, { position: 3 }]);
    const res = await poolSet.handler(
      {
        pool: 'agents',
        name: ' Sonnet ',
        vendor: 'Anthropic',
        routes: [{ provider: ' OpenRouter ', model: ' anthropic/claude-sonnet-5 ' }],
        input_per_m: 3,
        output_per_m: 15,
        rating: 5,
        note: 'flagship',
      },
      ctx,
    );
    // Matched by (owner, pool, name) so a second curation pass updates
    // rather than duplicating.
    expect(paramsOf(whereArgs[0])).toEqual(['o1', 'agents', 'Sonnet']);
    expect(insert.values).toHaveBeenCalledWith({
      ownerId: 'o1',
      pool: 'agents',
      position: 4,
      name: 'Sonnet',
      vendor: 'Anthropic',
      routes: [{ provider: 'openrouter', model: 'anthropic/claude-sonnet-5' }],
      pricing: {
        inputPerM: 3,
        outputPerM: 15,
        currency: 'USD',
        capturedAt: expect.any(String),
        source: 'openrouter',
      },
      rating: 5,
      note: 'flagship',
    });
    expect(dbmod.db.update).not.toHaveBeenCalled();
    expect(outputOf(res)).toEqual({
      ok: true,
      inserted: true,
      id: 'cm-new',
      pool: 'agents',
      name: 'Sonnet',
    });
  });

  it('stores NO pricing snapshot when neither price is given (voice rows bill per minute)', async () => {
    selectQueue.push([], []);
    await poolSet.handler({ pool: 'agents', name: 'Sonnet', routes: ROUTES, position: 0 }, ctx);
    const values = insert.values.mock.calls[0]![0] as Record<string, unknown>;
    expect(values.pricing).toBeNull();
    expect(values.position).toBe(0);
  });

  it('updates an existing entry in place with ONLY the fields supplied', async () => {
    selectQueue.push([{ id: 'cm-existing' }]);
    const res = await poolSet.handler(
      { pool: 'agents', name: 'Sonnet', routes: ROUTES, rating: 4 },
      ctx,
    );
    const set = update.set.mock.calls[0]![0] as Record<string, unknown>;
    expect(set).toMatchObject({ routes: ROUTES, rating: 4, updatedAt: expect.any(Date) });
    // A partial call must not blank what the owner already recorded.
    expect(set).not.toHaveProperty('vendor');
    expect(set).not.toHaveProperty('pricing');
    expect(set).not.toHaveProperty('note');
    expect(set).not.toHaveProperty('position');
    expect(paramsOf(whereArgs[1])).toEqual(['cm-existing']);
    expect(dbmod.db.insert).not.toHaveBeenCalled();
    expect(outputOf(res)).toEqual({
      ok: true,
      updated: true,
      id: 'cm-existing',
      pool: 'agents',
      name: 'Sonnet',
    });
  });
});
