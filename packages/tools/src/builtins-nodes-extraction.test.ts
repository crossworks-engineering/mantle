/**
 * Behavioural tests for process_extraction, the tool that re-fires the
 * `node_ingested` signal so the extractor revisits nodes with no summary or
 * embedding. builtins-nodes-write.test.ts covers content_supersede; nothing
 * exercised this handler.
 *
 * Each signal is a worker run with real LLM spend behind it, so what matters
 * is WHICH nodes get signalled and for WHOM:
 *
 *  - The sweep is owner-scoped. Its where clause carries the caller's owner
 *    id; drop it and one owner's sweep re-extracts the whole corpus on every
 *    brain. The clause is a real drizzle SQL tree, walked for its params.
 *  - The single-node path has no eligibility check by design (the operator
 *    chose the node), so its ownership gate is the declared `node_exists`
 *    precondition the runtime checks BEFORE the handler. That gate is pinned
 *    through the real checker: a node that does not resolve under this
 *    owner is refused and nothing fires.
 *  - Nothing fires when nothing is eligible, and the sweep honours the type
 *    filter and the limit (default 100), because the limit is the only cap
 *    on how much work one call can enqueue.
 *
 * The db select chain and `notifyNodeIngested` are stubbed at @mantle/db.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

let selectRows: unknown[] = [];
const whereArgs: unknown[] = [];
const limitArgs: unknown[] = [];

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn(function (this: unknown, arg: unknown) {
      whereArgs.push(arg);
      return this;
    }),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn(async (n: unknown) => {
      limitArgs.push(n);
      return selectRows;
    }),
  };
  return {
    ...actual,
    db: { ...actual.db, select: vi.fn(() => chain) },
    notifyNodeIngested: vi.fn(),
  };
});
vi.mock('@mantle/search', () => ({ resolveSupersededTargets: vi.fn() }));
vi.mock('@mantle/content', () => ({
  corpusCapacity: vi.fn(),
  nodeUrl: (id: string) => `https://brain.test/n/${id}`,
  supersedeNode: vi.fn(),
  unsupersedeNode: vi.fn(),
}));

import * as dbmod from '@mantle/db';
import { notifyNodeIngested } from '@mantle/db';
import { INGEST_TOOLS } from './builtins-nodes';
import { checkToolPreconditions } from './preconditions';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const extraction = INGEST_TOOLS.find((t) => t.slug === 'process_extraction')!;
const ctx: ToolHandlerContext = { ownerId: 'o1' };
const NODE = '11111111-2222-4333-8444-555555555555';

type Result = Awaited<ReturnType<BuiltinToolDef['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): Record<string, unknown> {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output as Record<string, unknown>;
}

/** Bound parameter values of a drizzle SQL tree, in order. A raw JS array
 *  interpolated into a `sql` template is expanded element-wise by drizzle
 *  (each string becomes its own bind), so arrays are walked too and their
 *  members flattened into the list. */
function paramsOf(node: unknown, out: unknown[] = []): unknown[] {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const c of node) typeof c === 'object' ? paramsOf(c, out) : out.push(c);
    return out;
  }
  const o = node as { queryChunks?: unknown[]; value?: unknown; encoder?: unknown };
  if (Array.isArray(o.queryChunks)) for (const c of o.queryChunks) paramsOf(c, out);
  else if ('value' in o && 'encoder' in o) out.push(...[o.value].flat());
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  selectRows = [];
  whereArgs.length = 0;
  limitArgs.length = 0;
  vi.mocked(notifyNodeIngested).mockResolvedValue(undefined);
});

describe('process_extraction single node', () => {
  it('declares the node_exists gate on node_id, and the checker refuses a node this owner does not hold', async () => {
    expect(extraction.preconditions).toEqual([
      { kind: 'node_exists', param: 'node_id', lookup: 'search_nodes / tree_list' },
    ]);
    // The runtime runs this before the handler; a lookup that finds nothing
    // under the caller's owner id is the foreign-or-missing case.
    const lookup = vi.fn(async () => null);
    const refused = await checkToolPreconditions(
      extraction.preconditions!,
      { node_id: NODE },
      'o1',
      lookup,
    );
    expect(refused).not.toBeNull();
    expect(errorOf(refused!)).toMatch(new RegExp(`node ${NODE} not found`));
    expect(lookup).toHaveBeenCalledWith('o1', NODE);
    expect(notifyNodeIngested).not.toHaveBeenCalled();
  });

  it('fires exactly one signal for the chosen node and runs no sweep', async () => {
    const setOutput = vi.fn();
    const res = await extraction.handler(
      { node_id: NODE },
      { ...ctx, step: { setOutput, setMeta: vi.fn(), addTokens: vi.fn(), addCost: vi.fn() } },
    );
    expect(outputOf(res)).toEqual({ fired: 1, node_id: NODE });
    expect(notifyNodeIngested).toHaveBeenCalledTimes(1);
    expect(notifyNodeIngested).toHaveBeenCalledWith(NODE);
    expect(dbmod.db.select).not.toHaveBeenCalled();
    expect(setOutput).toHaveBeenCalledWith({ fired: 1, node_id: NODE });
  });
});

describe('process_extraction sweep', () => {
  it('is scoped to the caller owner and fires one signal per eligible row', async () => {
    selectRows = [{ id: 'a' }, { id: 'b' }];
    expect(outputOf(await extraction.handler({}, ctx))).toEqual({ fired: 2 });
    expect(paramsOf(whereArgs[0])).toContain('o1');
    expect(vi.mocked(notifyNodeIngested).mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
  });

  it('fires nothing when nothing is eligible', async () => {
    expect(outputOf(await extraction.handler({}, ctx))).toEqual({ fired: 0 });
    expect(dbmod.db.select).toHaveBeenCalledTimes(1);
    expect(notifyNodeIngested).not.toHaveBeenCalled();
  });

  it('caps the sweep at 100 by default and at the given limit otherwise', async () => {
    await extraction.handler({}, ctx);
    await extraction.handler({ limit: 7 }, ctx);
    expect(limitArgs).toEqual([100, 7]);
  });

  it('binds the type filter into the where clause only when one is given', async () => {
    // Pins that the filter VALUES reach the clause as binds under the owner
    // id, not the rendered shape: the shape is currently `any(($2, $3)::text[])`,
    // a row cast Postgres rejects (reported, not fixed here), and the fix
    // (`inArray`, or one array param) keeps these binds either way.
    await extraction.handler({ types: ['file', 'note'] }, ctx);
    await extraction.handler({ types: [] }, ctx);
    const [filtered, unfiltered] = whereArgs.map((w) => paramsOf(w));
    expect(filtered).toEqual(['o1', 'file', 'note']);
    expect(unfiltered).toEqual(['o1']);
  });
});
