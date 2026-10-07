/**
 * The member chat's turn ledger and token budget (audit F09) on a real,
 * migrated Postgres (0182): a turn counts from the moment it is claimed, a
 * retry of the same turn id is not counted again, the cap and the token
 * budget refuse, a released claim gives the slot back, and two claims at once
 * cannot both take the last slot.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/member-turn-ledger.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Row = Record<string, unknown>;

describe.skipIf(!URL)('claimMemberTurn', () => {
  let m: typeof import('@mantle/db');
  let ledger: typeof import('./member-turn-ledger');
  let admin: (strings: TemplateStringsArray, ...v: unknown[]) => Promise<Row[]>;
  const tag = `ledger-${randomUUID().slice(0, 8)}`;
  const anchor = randomUUID();
  const pat = randomUUID();
  const sam = randomUUID();
  const since = new Date(Date.now() - 60 * 60 * 1000);
  // Turn ids are global (the primary key): prefix them per run.
  const tid = (id: string) => `${tag}.${id}`;
  const claim = (loginId: string, turnId: string, dailyTurns = 3, dailyTokens = 0) =>
    ledger.claimMemberTurn({
      ownerId: anchor,
      loginId,
      turnId: tid(turnId),
      since,
      limits: { dailyTurns, dailyTokens },
    });

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    ledger = await import('./member-turn-ledger');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    await admin`insert into auth.users (id, email, password_hash, role) values
      (${anchor}, ${`anchor-${tag}@example.invalid`}, 'x', 'admin'),
      (${pat}, ${`pat-${tag}@example.invalid`}, 'x', 'member'),
      (${sam}, ${`sam-${tag}@example.invalid`}, 'x', 'member')`;
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from traces where owner_id = ${anchor}`;
    await admin`delete from auth.users where id in (${pat}, ${sam}, ${anchor})`;
    await m.closeDb();
  });

  it('counts a turn once, however often it is retried, and refuses past the cap', async () => {
    expect(await claim(pat, 'pat.a')).toEqual({ ok: true, fresh: true });
    expect(await claim(pat, 'pat.a')).toEqual({ ok: true, fresh: false });
    expect(await claim(pat, 'pat.b')).toEqual({ ok: true, fresh: true });
    expect(await claim(pat, 'pat.c')).toEqual({ ok: true, fresh: true });
    expect(await claim(pat, 'pat.d')).toEqual({ ok: false, reason: 'daily_cap', used: 3 });
    // A retry of a queued turn is still admitted at the cap.
    expect(await claim(pat, 'pat.c')).toEqual({ ok: true, fresh: false });
    // Another login has its own count.
    expect(await claim(sam, 'sam.a')).toEqual({ ok: true, fresh: true });
  });

  it('gives a released slot back', async () => {
    await ledger.releaseMemberTurn(tid('pat.c'));
    expect(await claim(pat, 'pat.e')).toEqual({ ok: true, fresh: true });
  });

  it('ignores turns claimed before the window', async () => {
    await admin`update member_turn_ledger set created_at = now() - interval '2 days'
                 where turn_id in (${tid('pat.a')}, ${tid('pat.b')})`;
    expect(await claim(pat, 'pat.f')).toEqual({ ok: true, fresh: true });
  });

  it('waits for a claim in flight on the same login, then sees its row', async () => {
    // A claim in flight holds the per-login lock (its key is the one
    // claimMemberTurn takes). A second claim must wait for it, so it counts
    // the slot the first one took instead of both taking the last slot.
    const who = randomUUID();
    await admin`insert into auth.users (id, email, password_hash, role) values
      (${who}, ${`race-${tag}@example.invalid`}, 'x', 'member')`;
    const raw = admin as unknown as {
      begin: (fn: (tx: typeof admin) => Promise<unknown>) => Promise<unknown>;
    };
    let second: Promise<unknown> | null = null;
    let settled = false;
    await raw.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`member-turn:${who}`}, 0))`;
      second = claim(who, 'race.second', 1).then((r) => {
        settled = true;
        return r;
      });
      await new Promise((r) => setTimeout(r, 400));
      expect(settled).toBe(false);
      await tx`insert into member_turn_ledger (turn_id, owner_id, login_id)
               values (${tid('race.first')}, ${anchor}, ${who})`;
    });
    expect(await second).toEqual({ ok: false, reason: 'daily_cap', used: 1 });
    await admin`delete from auth.users where id = ${who}`;
  });

  it('refuses over the token budget from the login’s member chat traces only', async () => {
    await admin`insert into traces (owner_id, kind, subject_kind, status, tokens_in, tokens_out, data) values
      (${anchor}, 'responder_turn', 'team_turn', 'success', 600, 400, ${JSON.stringify({ login_id: sam })}::jsonb),
      (${anchor}, 'responder_turn', 'team_turn', 'success', 5000, 5000, ${JSON.stringify({ login_id: pat })}::jsonb),
      (${anchor}, 'responder_turn', 'chat', 'success', 90000, 0, ${JSON.stringify({ login_id: sam })}::jsonb)`;
    expect(await ledger.memberTokensSince(anchor, sam, since)).toBe(1000);
    expect(await claim(sam, 'sam.b', 100, 1000)).toEqual({
      ok: false,
      reason: 'token_budget',
      used: 1000,
    });
    expect(await claim(sam, 'sam.b', 100, 1001)).toEqual({ ok: true, fresh: true });
    // 0 = no token budget.
    expect(await claim(pat, 'pat.g', 100, 0)).toEqual({ ok: true, fresh: true });
  });

  it('drops the ledger rows with the login', async () => {
    await admin`delete from auth.users where id = ${sam}`;
    expect(await admin`select 1 from member_turn_ledger where login_id = ${sam}`).toHaveLength(0);
  });
});
