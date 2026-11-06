/**
 * The agent UI channel's calls on a real, migrated Postgres (0363,
 * docs/agent-ui.md): a call opened in a login's turn scope (systemDb, the
 * narrow route: INSERT, UPDATE of status, result and answered_at); one row
 * per step key (a DBOS re-run finds it again); the answer holds to the login,
 * the turn, the window, pending and not expired, and only once; a Stop gives
 * the turn's open calls up; a login reads its own rows only; no login's
 * scope writes the table itself; 0363's rollback takes it off the ledger
 * only.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/ui-calls.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedScratchDatabase, ensureAdminUsers } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the agent UI calls (0363)', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let su: ReturnType<typeof postgres>;
  let m: typeof import('./index');
  let v: typeof import('./viewer');
  const admin = randomUUID();
  const member = randomUUID();
  let adminWs = '';
  const memberWs = randomUUID();
  const WINDOW = 'win_abcdefgh';

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    su = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    for (const [id, role] of [
      [admin, 'admin'],
      [member, 'member'],
    ] as const) {
      await su`insert into auth.users (id, email, password_hash, role)
        values (${id}, ${`ui-${id.slice(0, 8)}@example.invalid`}, 'x', ${role})`;
    }
    adminWs = await ensureAdminUsers(su, [admin]);
    m = await import('./index');
    v = await import('./viewer');
    await m.systemDb.execute(sql`select 1`);
  }, 120_000);

  afterAll(async () => {
    await m?.closeDb();
    await su?.end();
    await scratch?.drop();
  });

  /** Run `fn` in `login`'s request scope over `ws`. */
  const inRequest = <T>(login: string, ws: string, writes: boolean, fn: () => Promise<T>) =>
    v.runInRequestSlot(async () => {
      const scope = Object.freeze({
        kind: 'user' as const,
        loginId: login,
        ws: Object.freeze([ws]),
        modWs: Object.freeze([]),
      });
      expect(v.enterRequestScope(scope, { writes, drafts: false })).toBe(true);
      return fn();
    });

  const open = (turnId: string, stepKey: string, ttlMs = 15_000, loginId = admin) =>
    inRequest(loginId, loginId === admin ? adminWs : memberWs, true, () =>
      m.openUiCall({
        turnId,
        loginId,
        windowId: WINDOW,
        stepKey,
        action: 'click',
        args: { target: { ref: 'e1' } },
        ttlMs,
      }),
    );

  const answer = (a: Partial<import('./index').UiAnswer> & { callId: string; turnId: string }) =>
    inRequest(admin, adminWs, true, () =>
      m.answerUiCall({ loginId: admin, windowId: WINDOW, result: { ok: true }, ...a }),
    );

  it('one row per step key: a re-run of the step finds the same row', async () => {
    const turn = randomUUID();
    const first = await open(turn, `${turn}:call_1`);
    const again = await open(turn, `${turn}:call_1`);
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.row.id).toBe(first.row.id);
    expect(first.row.status).toBe('pending');
    expect(first.row.expiresAt.getTime()).toBeGreaterThan(Date.now() + 10_000);
  });

  it('the answer holds to the login, the turn and the window, and lands once', async () => {
    const turn = randomUUID();
    const { row } = await open(turn, `${turn}:call_1`);
    // Another login's request: not found, nothing changes.
    expect(
      await inRequest(member, memberWs, true, () =>
        m.answerUiCall({
          callId: row.id,
          turnId: turn,
          loginId: member,
          windowId: WINDOW,
          result: { ok: true },
        }),
      ),
    ).toBe('not_found');
    expect(await answer({ callId: row.id, turnId: 'another-turn' })).toBe('not_found');
    expect(await answer({ callId: row.id, turnId: turn, windowId: 'win_other000' })).toBe(
      'not_found',
    );
    expect(await answer({ callId: randomUUID(), turnId: turn })).toBe('not_found');
    expect((await m.readUiCall(row.id))!.status).toBe('pending');
    // The right one lands, once.
    expect(await answer({ callId: row.id, turnId: turn, result: { ok: true, n: 1 } })).toBe('done');
    expect(await answer({ callId: row.id, turnId: turn, result: { ok: true, n: 2 } })).toBe(
      'answered',
    );
    const done = (await m.readUiCall(row.id))!;
    expect(done.status).toBe('done');
    expect(done.result).toEqual({ ok: true, n: 1 });
    expect(done.answeredAt).not.toBeNull();
  });

  it('an expired call is never answered', async () => {
    const turn = randomUUID();
    const { row } = await open(turn, `${turn}:call_1`, 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(await answer({ callId: row.id, turnId: turn })).toBe('expired');
    expect((await m.readUiCall(row.id))!.status).toBe('pending');
  });

  it("a Stop gives up the turn's open calls of the login only", async () => {
    const turn = randomUUID();
    const a = await open(turn, `${turn}:call_1`);
    const b = await open(turn, `${turn}:call_2`);
    await answer({ callId: b.row.id, turnId: turn });
    // Another login's Stop of the same turn id changes nothing.
    expect(
      await inRequest(member, memberWs, true, () =>
        m.expireTurnUiCalls({ turnId: turn, loginId: member }),
      ),
    ).toBe(0);
    expect(
      await inRequest(admin, adminWs, true, () =>
        m.expireTurnUiCalls({ turnId: turn, loginId: admin }),
      ),
    ).toBe(1);
    expect((await m.readUiCall(a.row.id))!.status).toBe('expired');
    expect((await m.readUiCall(b.row.id))!.status).toBe('done');
    expect(await answer({ callId: a.row.id, turnId: turn })).toBe('expired');
  });

  it("a member's workspace turn (docs/agent-ui.md, Members): its own window answers, its Stop gives up, nobody else's does", async () => {
    // The member turn's stream id names its login (server/web lib/turn-access.ts).
    const turn = `ws-${member}.${randomUUID()}`;
    const memberAnswer = (callId: string) =>
      inRequest(member, memberWs, true, () =>
        m.answerUiCall({
          callId,
          turnId: turn,
          loginId: member,
          windowId: WINDOW,
          result: { ok: true },
        }),
      );
    const a = await open(turn, `${turn}:call_1`, 15_000, member);
    const b = await open(turn, `${turn}:call_2`, 15_000, member);
    expect(a.row.loginId).toBe(member);
    // An Admin user's answer or Stop of the member's call changes nothing.
    expect(await answer({ callId: a.row.id, turnId: turn })).toBe('not_found');
    expect(
      await inRequest(admin, adminWs, true, () =>
        m.expireTurnUiCalls({ turnId: turn, loginId: admin }),
      ),
    ).toBe(0);
    // The member's own window answers, once; its Stop gives up the other.
    expect(await memberAnswer(a.row.id)).toBe('done');
    expect(await memberAnswer(a.row.id)).toBe('answered');
    expect(
      await inRequest(member, memberWs, true, () =>
        m.expireTurnUiCalls({ turnId: turn, loginId: member }),
      ),
    ).toBe(1);
    expect((await m.readUiCall(b.row.id))!.status).toBe('expired');
    expect(await memberAnswer(b.row.id)).toBe('expired');
  });

  it('a login reads its own rows only', async () => {
    const turn = randomUUID();
    await open(turn, `${turn}:member`, 15_000, member);
    const seen = await inRequest(member, memberWs, false, () =>
      m.db.select({ loginId: m.uiCalls.loginId }).from(m.uiCalls),
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen.map((r) => r.loginId))).toEqual(new Set([member]));
  });

  it("no login's scope writes the table itself", async () => {
    const failed = await inRequest(member, memberWs, true, async () =>
      Promise.resolve()
        .then(() =>
          m.db.insert(m.uiCalls).values({
            turnId: 'forged',
            loginId: member,
            windowId: WINDOW,
            stepKey: `forged:${randomUUID()}`,
            action: 'click',
            args: {},
            expiresAt: new Date(Date.now() + 60_000),
          }),
        )
        .then(
          () => null,
          (err: unknown) => err,
        ),
    );
    expect(failed).toBeInstanceOf(v.SystemWorkRequiredError);
    const [n] = await su<
      { n: number }[]
    >`select count(*)::int as n from ui_calls where turn_id = 'forged'`;
    expect(n!.n).toBe(0);
  });

  it('0363: the rollback takes it off the ledger and keeps the table', async () => {
    const revert = readFileSync(
      new globalThis.URL('../rollback/0363_ui_calls.revert.sql', import.meta.url),
      'utf8',
    );
    const seen: number[] = [];
    await su
      .begin(async (tx) => {
        await tx`create schema if not exists "drizzle"`;
        await tx`create table if not exists "drizzle"."__drizzle_migrations" (
          id serial primary key, hash text not null, created_at bigint)`;
        await tx`insert into "drizzle"."__drizzle_migrations" (hash, created_at)
          values ('0363', 1791583383000)`;
        await tx.unsafe(revert);
        seen.push(
          (
            await tx<{ n: number }[]>`select count(*)::int as n
              from "drizzle"."__drizzle_migrations" where created_at = 1791583383000`
          )[0]!.n,
        );
        seen.push((await tx<{ n: number }[]>`select count(*)::int as n from ui_calls`)[0]!.n);
        throw new Error('roll back');
      })
      .catch((err: unknown) => {
        if (!(err instanceof Error) || err.message !== 'roll back') throw err;
      });
    expect(seen[0]).toBe(0);
    expect(seen[1]).toBeGreaterThan(0);
  });
});
