/**
 * Arch A7 fix round (L3): a first owner whose brain the switch leaves off
 * workspaces is answered `not-switched` with the reason, never `ok`, so the
 * signup route stops the web process (its restart runs the boot's switch
 * again, and the boot refuses to serve while that fails). Driven on a fresh
 * scratch brain with a former client login (archived by 0272), which makes
 * mantle_ws_migrate_locked skip it ("clients present").
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/auth/first-owner.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Ts = typeof import('@mantle/db/test-support');

describe.skipIf(!URL)('the first owner of a brain the switch skips (arch A7)', () => {
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let sql: ReturnType<typeof postgres> | undefined;

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    sql = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET ??= 'first-owner-db-test-secret-at-least-32-chars';
  }, 240_000);

  afterAll(async () => {
    const m = await import('@mantle/db');
    await m.closeDb().catch(() => {});
    await sql?.end();
    await scratch?.drop();
  }, 120_000);

  it('is not-switched with the reason, and the brain is not on workspaces', async () => {
    await sql!`insert into archive_client_logins (login_id, email, created_at, session_epoch)
      values (${randomUUID()}, 'fo-c@example.invalid', now(), 0)`;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { createFirstOwner } = await import('./first-owner');
      const res = await createFirstOwner('fo-owner@example.invalid', 'a long enough password 1');
      expect(res).toMatchObject({
        ok: false,
        reason: 'not-switched',
        email: 'fo-owner@example.invalid',
      });
      expect((res as { why: string }).why).toMatch(/^clients present/);
    } finally {
      warn.mockRestore();
    }
    // The owner was made; the brain has no workspace, and the boot's check
    // refuses it.
    expect(Number((await sql!`select count(*) as n from auth.users`)[0]!.n)).toBe(1);
    expect(Number((await sql!`select count(*) as n from workspaces`)[0]!.n)).toBe(0);
    const { unmigratedBrainReason } = await import('../workspaces-migrate');
    expect(await unmigratedBrainReason()).toMatch(/^clients present/);
  });

  it('refuseUnswitchedBrain logs the refusal and stops the process after a short delay', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { refuseUnswitchedBrain } = await import('./unswitched-brain');
      const exit = vi.fn();
      refuseUnswitchedBrain('clients present: test', exit);
      // Not the first call: the checks' floor (check-floor.ts) says its line
      // when the pool warms, fired and forgotten, so on a loaded runner it
      // can land in this spy before the refusal.
      expect(error.mock.calls.map((c) => String(c[0]))).toContainEqual(
        expect.stringMatching(/not on workspaces \(clients present: test\)/),
      );
      expect(exit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      error.mockRestore();
      vi.useRealTimers();
    }
  });
});
