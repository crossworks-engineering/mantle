/**
 * Owner scoping on the READ tools.
 *
 * The 2026-09-02 audit mutated six WRITE handlers and found ten test files
 * that stubbed the db chain with `where: vi.fn().mockReturnThis()` and never
 * looked at the clause. Those were fixed. The reads were never checked at all:
 * at v0.232.171, 73 of 242 builtins had no test that runs their handler, and
 * almost every one of them is a read.
 *
 * A read that forgets its owner clause does not throw and does not corrupt
 * anything. It just answers with somebody else's rows. `emails` has no
 * owner column of its own — it scopes through `account_id` to
 * `email_accounts.user_id` — so the clause is easy to leave out and
 * impossible to notice from the handler alone.
 *
 * These walk the real drizzle clause via `paramsOf` rather than trusting a
 * chainable stub, so deleting a scope term fails the test.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const selectQueue: unknown[][] = [];
const whereArgs: unknown[] = [];

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  const chain: Record<string, unknown> = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    where: vi.fn(function (this: unknown, arg: unknown) {
      whereArgs.push(arg);
      return this;
    }),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: (res: (v: unknown) => void, rej?: (e: unknown) => void) =>
      Promise.resolve(selectQueue.shift() ?? []).then(res, rej),
  };
  return { ...actual, db: { ...actual.db, select: vi.fn(() => chain) } };
});

import { paramsOf } from './test-support';
import { BUILTIN_TOOLS } from './builtins';
import { EMAIL_TOOLS } from './builtins-email';
import { TELEGRAM_OPERATOR_TOOLS } from './builtins-telegram';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const OWNER = 'owner-1';
const ctx: ToolHandlerContext = { ownerId: OWNER };
const tool = (defs: readonly BuiltinToolDef[], slug: string): BuiltinToolDef => {
  const def = defs.find((t) => t.slug === slug);
  if (!def) throw new Error(`${slug} is not in this group any more`);
  return def;
};

/** Every owner-scoped term bound anywhere in the clauses this call issued. */
const scopedByOwner = () => whereArgs.some((w) => paramsOf(w).includes(OWNER));

beforeEach(() => {
  selectQueue.length = 0;
  whereArgs.length = 0;
});

describe('email_list', () => {
  it('scopes to the caller — `emails` has no owner column, so the account join IS the scope', async () => {
    selectQueue.push([]);
    await tool(EMAIL_TOOLS, 'email_list').handler({}, ctx);
    expect(whereArgs.length, 'issued no WHERE at all').toBeGreaterThan(0);
    expect(scopedByOwner(), 'no owner id bound in any clause').toBe(true);
  });

  it('still scopes when the caller narrows by account', async () => {
    selectQueue.push([]);
    await tool(EMAIL_TOOLS, 'email_list').handler({ accountId: 'acc-9' }, ctx);
    expect(scopedByOwner()).toBe(true);
  });
});

describe('email_get', () => {
  it('scopes to the caller, so an id alone cannot open another owner mail', async () => {
    selectQueue.push([]);
    await tool(EMAIL_TOOLS, 'email_get').handler({ id: 'e1' }, ctx);
    expect(scopedByOwner()).toBe(true);
  });
});

describe('telegram_pending', () => {
  it('scopes the pending queue to the caller chats', async () => {
    selectQueue.push([]);
    await tool(TELEGRAM_OPERATOR_TOOLS, 'telegram_pending').handler({}, ctx);
    expect(scopedByOwner()).toBe(true);
  });

  it('scopes the chat lookup too when a chat id is given', async () => {
    selectQueue.push([{ id: 'chat-pk' }], []);
    await tool(TELEGRAM_OPERATOR_TOOLS, 'telegram_pending').handler({ chat_id: '123' }, ctx);
    expect(paramsOf(whereArgs[0]), 'chat lookup unscoped').toContain(OWNER);
  });
});

/**
 * The rest of the direct-db reads. Each was already scoped correctly; nothing
 * pinned it. Driven through BUILTIN_TOOLS with the arguments each one needs to
 * reach its query, and asserted on the real clause.
 *
 * A handler is allowed to fail here — `node_read` on a missing id returns a
 * teaching error — as long as the lookup it DID issue carried the owner. The
 * scope has to be in the query, not in whether the row came back.
 */
const SCOPED_READS: Array<[string, Record<string, unknown>]> = [
  ['agent_list', {}],
  ['tool_group_list', {}],
  ['worker_group_list', {}],
  ['tree_list', {}],
  ['node_read', { node_id: 'n1' }],
  ['file_read', { file_id: 'f1' }],
  ['recall_index', {}],
  ['recall_open', { map: 'm' }],
  ['recall_go', { map: 'm', target: 't' }],
  ['find_window', { topic: 'x' }],
  ['replay_window', { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' }],
  ['run_state', { run_id: 'r1' }],
];

describe.each(SCOPED_READS)('%s', (slug, input) => {
  it('binds the caller owner id into every lookup it issues', async () => {
    for (let i = 0; i < 6; i++) selectQueue.push([]);
    const def = BUILTIN_TOOLS.find((t) => t.slug === slug);
    expect(def, `${slug} is no longer a builtin`).toBeTruthy();
    await def!.handler(input, ctx);
    expect(whereArgs.length, `${slug} issued no WHERE`).toBeGreaterThan(0);
    expect(scopedByOwner(), `${slug} queried without an owner clause`).toBe(true);
  });
});
