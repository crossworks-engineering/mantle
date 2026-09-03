/**
 * Behavioural tests for the owner's approval controls and the worker-group
 * upsert: pending_approve, pending_reject, worker_group_ensure.
 *
 * `pending.test.ts` covers the settle layer underneath (approvePendingCall /
 * rejectPendingCall: routing, ownership hand-off, recovery). What it does
 * NOT cover is the tool handler that sits in front of it, and that handler
 * owns two things worth pinning:
 *
 *  - The decision payload. A bare approval must reach the settle layer as
 *    `undefined`, not `{}`; an `answers: []` must be dropped rather than
 *    forwarded as a meaningless structured answer. Getting this wrong turns
 *    every plain yes into a form submission.
 *  - The claim result. The settle layer returns null for a row that is
 *    missing OR already decided (a CAS that matched nothing); the handler
 *    must report that as a refusal, never as a success with an empty row.
 *
 * `worker_group_ensure` validates members against the owner's ENABLED
 * workers before writing, and picks insert vs update by (owner, slug). Its
 * tests pin the owner scoping of that validation and exactly which columns
 * each branch writes.
 *
 * The settle layer is stubbed at ./pending; the db chains at select /
 * update / insert.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const selectQueue: unknown[][] = [];
const whereArgs: unknown[] = [];
let writeReturn: unknown[] = [];

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  const select = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn(function (this: unknown, arg: unknown) {
      whereArgs.push(arg);
      return this;
    }),
    then: (res: (v: unknown) => void, rej?: (e: unknown) => void) =>
      Promise.resolve(selectQueue.shift() ?? []).then(res, rej),
  };
  const update = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn(function (this: unknown, arg: unknown) {
      whereArgs.push(arg);
      return this;
    }),
    returning: vi.fn(async () => writeReturn),
  };
  const insert = {
    values: vi.fn().mockReturnThis(),
    returning: vi.fn(async () => writeReturn),
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
vi.mock('./pending', () => ({
  approvePendingCall: vi.fn(),
  rejectPendingCall: vi.fn(),
  getPendingCall: vi.fn(),
  listPendingCalls: vi.fn(),
}));

import * as dbmod from '@mantle/db';
import { approvePendingCall, rejectPendingCall } from './pending';
import { PENDING_TOOLS, WORKER_GROUP_TOOLS } from './builtins-pending';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

type Chain = { set: ReturnType<typeof vi.fn>; values: ReturnType<typeof vi.fn> };
const update = (dbmod as unknown as { __update: Chain }).__update;
const insert = (dbmod as unknown as { __insert: Chain }).__insert;

const approve = PENDING_TOOLS.find((t) => t.slug === 'pending_approve')!;
const reject = PENDING_TOOLS.find((t) => t.slug === 'pending_reject')!;
const ensure = WORKER_GROUP_TOOLS.find((t) => t.slug === 'worker_group_ensure')!;

const ctx: ToolHandlerContext = { ownerId: 'o1' };
const ROW_ID = '11111111-2222-4333-8444-555555555555';

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
  writeReturn = [];
  vi.mocked(approvePendingCall).mockResolvedValue({ id: ROW_ID, status: 'approved' } as never);
  vi.mocked(rejectPendingCall).mockResolvedValue({ id: ROW_ID, status: 'rejected' } as never);
});

describe('owner-only surface', () => {
  it('is MCP-only: an agent that could approve its own gated call would defeat the gate', () => {
    for (const t of [approve, reject, ensure]) {
      expect(t.mcpOnly, `${t.slug} must be mcpOnly`).toBe(true);
    }
  });
});

describe('pending_approve', () => {
  it('requires an id and settles nothing without one', async () => {
    expect(errorOf(await approve.handler({}, ctx))).toMatch(/id required/);
    expect(errorOf(await approve.handler({ id: 7 }, ctx))).toMatch(/id required/);
    expect(approvePendingCall).not.toHaveBeenCalled();
  });

  it('passes a bare approval through as NO decision, under the caller', async () => {
    const res = await approve.handler({ id: ROW_ID }, ctx);
    // `undefined`, not `{}`: the settle layer treats a payload as a form
    // submission, and a plain yes must stay a plain yes.
    expect(approvePendingCall).toHaveBeenCalledWith('o1', ROW_ID, undefined);
    expect(outputOf(res)).toMatchObject({ id: ROW_ID, status: 'approved' });
  });

  it('forwards a free-text answer', async () => {
    await approve.handler({ id: ROW_ID, answer: 'after 22:00' }, ctx);
    expect(approvePendingCall).toHaveBeenCalledWith('o1', ROW_ID, { answer: 'after 22:00' });
  });

  it('forwards structured answers and drops an empty list', async () => {
    const answers = [{ question: 'env', selected: ['prod'] }];
    await approve.handler({ id: ROW_ID, answers }, ctx);
    expect(approvePendingCall).toHaveBeenLastCalledWith('o1', ROW_ID, { answers });

    await approve.handler({ id: ROW_ID, answers: [] }, ctx);
    expect(approvePendingCall).toHaveBeenLastCalledWith('o1', ROW_ID, undefined);
  });

  it('reports a missing or already-decided row as a refusal', async () => {
    vi.mocked(approvePendingCall).mockResolvedValue(null);
    const res = await approve.handler({ id: ROW_ID }, ctx);
    // The settle layer's null is a CAS that matched no pending row. Reporting
    // it as success would let a double-click look like a second approval.
    expect(errorOf(res)).toMatch(/not found or already decided/);
  });
});

describe('pending_reject', () => {
  it('requires an id and settles nothing without one', async () => {
    expect(errorOf(await reject.handler({}, ctx))).toMatch(/id required/);
    expect(rejectPendingCall).not.toHaveBeenCalled();
  });

  it('rejects under the caller and returns the flipped row', async () => {
    const res = await reject.handler({ id: ROW_ID }, ctx);
    expect(rejectPendingCall).toHaveBeenCalledWith('o1', ROW_ID);
    expect(outputOf(res)).toMatchObject({ status: 'rejected' });
  });

  it('reports a missing or already-decided row as a refusal', async () => {
    vi.mocked(rejectPendingCall).mockResolvedValue(null);
    expect(errorOf(await reject.handler({ id: ROW_ID }, ctx))).toMatch(
      /not found or already decided/,
    );
  });
});

describe('worker_group_ensure', () => {
  const WORKERS = [{ slug: 'researcher' }, { slug: 'writer' }];

  it('requires a slug and at least one member, touching nothing without them', async () => {
    expect(errorOf(await ensure.handler({ members: ['researcher'] }, ctx))).toMatch(
      /slug required/,
    );
    expect(errorOf(await ensure.handler({ slug: 'panel', members: [] }, ctx))).toMatch(
      /members required/,
    );
    expect(dbmod.db.select).not.toHaveBeenCalled();
  });

  it("validates members against the CALLER's enabled workers and writes nothing on a miss", async () => {
    selectQueue.push(WORKERS);
    const res = await ensure.handler({ slug: 'panel', members: ['researcher', 'ghost'] }, ctx);
    expect(errorOf(res)).toMatch(/unknown worker\(s\): ghost/);
    expect(errorOf(res)).toMatch(/researcher, writer/);
    // owner, role = worker, enabled = true: a disabled or foreign worker is
    // not a valid panel member.
    expect(paramsOf(whereArgs[0])).toEqual(['o1', 'worker', true]);
    expect(dbmod.db.insert).not.toHaveBeenCalled();
    expect(dbmod.db.update).not.toHaveBeenCalled();
  });

  it('inserts a new group under the owner, defaulting the name to the slug', async () => {
    selectQueue.push(WORKERS, []);
    writeReturn = [{ id: 'g1', slug: 'panel' }];
    const res = await ensure.handler({ slug: 'panel', members: ['researcher', 'writer'] }, ctx);
    expect(insert.values).toHaveBeenCalledWith({
      ownerId: 'o1',
      slug: 'panel',
      name: 'panel',
      memberSlugs: ['researcher', 'writer'],
      updatedAt: expect.any(Date),
    });
    // `enabled` is left to the column default when not given.
    expect(insert.values.mock.calls[0]![0]).not.toHaveProperty('enabled');
    expect(dbmod.db.update).not.toHaveBeenCalled();
    expect(outputOf(res)).toMatchObject({ id: 'g1' });
  });

  it('updates an existing (owner, slug) in place instead of inserting a twin', async () => {
    selectQueue.push(WORKERS, [{ id: 'g1' }]);
    writeReturn = [{ id: 'g1' }];
    await ensure.handler(
      { slug: 'panel', name: 'Review panel', members: ['writer'], enabled: false },
      ctx,
    );
    expect(update.set).toHaveBeenCalledWith({
      name: 'Review panel',
      memberSlugs: ['writer'],
      enabled: false,
      updatedAt: expect.any(Date),
    });
    expect(paramsOf(whereArgs[2])).toEqual(['g1']);
    expect(dbmod.db.insert).not.toHaveBeenCalled();
  });
});
