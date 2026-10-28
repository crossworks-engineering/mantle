/**
 * The approval queue's writes on a real, migrated Postgres (pending-calls.ts):
 * in a login's mutating request scope a call is parked, claimed, put back,
 * settled, reverted and rejected on the system pool, with the rule in each
 * WHERE as it was when the login's scoped write sent them there. A login
 * that does not decide a call claims nothing; the decider claims it; an
 * approval never claims an elevated call. None is a scoped system write,
 * which is refused (plan v3.2 S4b).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/pending-calls.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedScratchDatabase } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the approval queue on the system pool (pending-calls.ts)', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let su: ReturnType<typeof postgres>;
  let m: typeof import('./index');
  let v: typeof import('./viewer');
  const owner = randomUUID();
  const asker = randomUUID();
  const other = randomUUID();
  const ws = randomUUID();

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    su = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('./index');
    v = await import('./viewer');
    await m.systemDb.execute(sql`select 1`);
    for (const [id, role] of [
      [owner, 'member'],
      [asker, 'member'],
      [other, 'member'],
    ] as const) {
      await su`insert into auth.users (id, email, password_hash, role)
        values (${id}, ${`pc-${id.slice(0, 8)}@example.invalid`}, 'x', ${role})`;
    }
  }, 120_000);

  afterAll(async () => {
    await m?.closeDb();
    await su?.end();
    await scratch?.drop();
  });

  /** Run `fn` in `login`'s mutating request scope, as the session guard
   *  leaves it (the login actor bound). */
  const inWriteRequest = <T>(login: string, fn: () => Promise<T>): Promise<T> =>
    v.runInRequestSlot(async () => {
      const scope = Object.freeze({
        kind: 'user' as const,
        loginId: login,
        ws: Object.freeze([ws]),
        modWs: Object.freeze([]),
      });
      expect(v.enterRequestScope(scope, { writes: true, drafts: false })).toBe(true);
      return fn();
    });
  /** Whose calls `login` decides (pending.ts deciderFilter for a login
   *  other than the owner: the calls queued for it). */
  const decides = (login: string) => eq(m.pendingToolCalls.loginId, login);
  const statusOf = async (id: string) =>
    (
      await su<{ status: string }[]>`select status::text from pending_tool_calls where id = ${id}`
    )[0]?.status;

  it('a park, a refused claim by a login that does not decide it, then the claim, put back, settle', async () => {
    const id = await inWriteRequest(asker, () =>
      m.parkPendingCall({ ownerId: owner, loginId: asker, toolSlug: 'task_list', args: {} }),
    );
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await statusOf(id!)).toBe('pending');

    // Another login: not its call, so nothing is claimed.
    const refused = await inWriteRequest(other, () =>
      m.decidePendingCall({
        ownerId: owner,
        id: id!,
        decision: 'approved',
        decider: decides(other),
        notElevated: true,
      }),
    );
    expect(refused).toBeNull();
    expect(await statusOf(id!)).toBe('pending');

    // The login it was queued for decides it.
    const claimed = await inWriteRequest(asker, () =>
      m.decidePendingCall({
        ownerId: owner,
        id: id!,
        decision: 'approved',
        decider: decides(asker),
        notElevated: true,
      }),
    );
    expect(claimed?.status).toBe('approved');
    expect(claimed?.decidedAt).toBeInstanceOf(Date);

    // Put back while still approved; a second put-back changes nothing.
    await inWriteRequest(asker, () => m.unclaimPendingCall(id!));
    expect(await statusOf(id!)).toBe('pending');

    // Claimed again by the owner (no narrowing), then its outcome recorded.
    const again = await inWriteRequest(owner, () =>
      m.decidePendingCall({
        ownerId: owner,
        id: id!,
        decision: 'approved',
        decider: undefined,
        notElevated: true,
      }),
    );
    expect(again?.status).toBe('approved');
    const settled = await inWriteRequest(owner, () =>
      m.settlePendingCall(id!, {
        result: { ok: 1 },
        error: null,
        executedAt: new Date(),
        updatedAt: new Date(),
      }),
    );
    expect(settled).toMatchObject({ status: 'approved', result: { ok: 1 }, error: null });
    expect(settled?.executedAt).toBeInstanceOf(Date);
    await inWriteRequest(owner, () => m.unclaimPendingCall(id!));
    // Only an approved call is put back: this one is, so it is pending again.
    expect(await statusOf(id!)).toBe('pending');
  });

  it('a revert keeps its error, an expiry and a rejection by the decider; never another brain', async () => {
    const id = await inWriteRequest(asker, () =>
      m.parkPendingCall({ ownerId: owner, loginId: asker, toolSlug: 'ask_human', args: {} }),
    );
    const reverted = await inWriteRequest(asker, () =>
      m.revertPendingCall(id!, 'the decision did not apply'),
    );
    expect(reverted).toMatchObject({
      status: 'pending',
      decidedAt: null,
      error: 'the decision did not apply',
    });
    // Another brain's id: the owner is in the WHERE.
    const otherBrain = await inWriteRequest(asker, () =>
      m.decidePendingCall({
        ownerId: other,
        id: id!,
        decision: 'rejected',
        decider: decides(asker),
      }),
    );
    expect(otherBrain).toBeNull();
    const rejected = await inWriteRequest(asker, () =>
      m.decidePendingCall({
        ownerId: owner,
        id: id!,
        decision: 'rejected',
        decider: decides(asker),
      }),
    );
    expect(rejected?.status).toBe('rejected');
    // Decided already: a second decision claims nothing.
    const twice = await inWriteRequest(asker, () =>
      m.decidePendingCall({
        ownerId: owner,
        id: id!,
        decision: 'approved',
        decider: decides(asker),
      }),
    );
    expect(twice).toBeNull();
    const expired = await inWriteRequest(owner, () =>
      m.settlePendingCall(id!, {
        status: 'expired',
        error: 'moved on',
        executedAt: new Date(),
        updatedAt: new Date(),
      }),
    );
    expect(expired).toMatchObject({ status: 'expired', error: 'moved on' });
  });

  it('an approval never claims an elevated call (its rule is pending-elevated.ts)', async () => {
    const id = await inWriteRequest(asker, () =>
      m.parkPendingCall({
        ownerId: owner,
        loginId: asker,
        toolSlug: 'task_list',
        args: {},
        elevated: { elevated: true, reason: 'test' },
      }),
    );
    const claimed = await inWriteRequest(owner, () =>
      m.decidePendingCall({
        ownerId: owner,
        id: id!,
        decision: 'approved',
        decider: undefined,
        notElevated: true,
      }),
    );
    expect(claimed).toBeNull();
    expect(await statusOf(id!)).toBe('pending');
  });
});
