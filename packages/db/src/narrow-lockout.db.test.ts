/**
 * Migration 0327 and the counter's refused calls, on a real, migrated
 * Postgres:
 *
 *  - the login hold: the REAL narrow login (session_user
 *    mantle_system_narrow) may not move disabled_at or session_epoch of the
 *    owner, an admin by role, or a user of the Admin workspace (refused
 *    42501, rows unchanged); a plain member's it may (the users area's own
 *    write); off the narrow route the same change by a narrow reason is
 *    counted, at a spot it is not;
 *  - the member token budget reads the ledger's own tokens: the settle
 *    stamps them for the scope login only, only up; traces the narrow login
 *    may write change nothing (inflated for a victim, or zeroed for itself);
 *    the narrow login may neither run the settle nor touch the ledger;
 *  - the narrow login holds no DELETE of traces;
 *  - the count's epoch: the narrow login writes no narrow-epoch row and no
 *    miss dated ahead, directly or through mantle_actor_miss_log; a plain
 *    miss row it still may;
 *  - the would-refuse count reads calls: with the switch off, a statement
 *    of an exit routed narrow that calls a function the narrow role may not
 *    run is noted (narrow-would-refuse fn:<name> EXECUTE); one it may run,
 *    or the same call outside the exit, is not;
 *  - every migration of the narrow set (0315 to 0327) runs again over its
 *    own end state and leaves it as it was (0322's end-state check, 0319
 *    with the rules after it).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/narrow-lockout.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { sql as sqlTag } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedScratchDatabase,
  ensureAdminUsers,
  ensureTestAnchor,
  takeNarrowWrites,
} from './test-support';
import {
  NARROW_ROLE,
  ensureRuntimeRoles,
  narrowRolePassword,
  runtimeDatabaseUrl,
  runtimeRolePassword,
} from './runtime-role';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const KEY = process.env.MANTLE_MASTER_KEY ?? 'mantle-viewer-test-key';
const PREFIX = 'mantle narrow write: ';

/** The first error's SQLSTATE of `stmts` in one transaction on `conn`
 *  (rolled back unless `keep`), or null. */
async function run(
  conn: ReturnType<typeof postgres>,
  stmts: string[],
  keep = false,
): Promise<string | null> {
  try {
    await conn.begin(async (tx) => {
      for (const st of stmts) await tx.unsafe(st);
      if (!keep) throw Object.assign(new Error('rollback'), { rollback: true });
    });
  } catch (err) {
    if ((err as { rollback?: boolean }).rollback) return null;
    return (err as { code?: string }).code ?? 'error';
  }
  return null;
}

describe.skipIf(!URL)('0327: the login hold, the ledger tokens, the epoch (S7b part b2)', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let su: ReturnType<typeof postgres>;
  let rt: ReturnType<typeof postgres>;
  let nl: ReturnType<typeof postgres>;
  let anchor = '';
  const adminByRole = randomUUID();
  const adminByWs = randomUUID();
  const member = randomUUID();
  const victim = randomUUID();
  const notices: string[] = [];
  const counted = () => notices.splice(0).filter((n) => n.startsWith(PREFIX));

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    const keep = (n: { message?: string }) => notices.push(n.message ?? '');
    su = postgres(scratch.url, { max: 1, prepare: false, onnotice: keep });
    expect(await ensureRuntimeRoles(su, KEY, { login: true, narrowLogin: true })).toBe('ok');
    anchor = await ensureTestAnchor(su);
    for (const [id, role] of [
      [adminByRole, 'admin'],
      [adminByWs, 'member'],
      [member, 'member'],
      [victim, 'member'],
    ] as const) {
      await su`insert into auth.users (id, email, password_hash, role)
               values (${id}, ${`${id}@example.test`}, 'x', ${role})`;
    }
    // A user of the Admin workspace whose role column still says member.
    await ensureAdminUsers(su, [adminByWs]);
    rt = postgres(runtimeDatabaseUrl(scratch.url, runtimeRolePassword(KEY)), {
      max: 1,
      prepare: false,
      onnotice: keep,
    });
    nl = postgres(runtimeDatabaseUrl(scratch.url, narrowRolePassword(KEY), NARROW_ROLE), {
      max: 1,
      prepare: false,
      onnotice: keep,
    });
    expect((await nl<{ u: string }[]>`select session_user::text as u`)[0]!.u).toBe(NARROW_ROLE);
  }, 180_000);

  afterAll(async () => {
    for (const c of [nl, rt, su]) await c?.end();
    await scratch?.drop();
  }, 60_000);

  const userRows = async () =>
    (
      await su<{ h: string }[]>`
        select md5(string_agg(id::text || coalesce(disabled_at::text, '-') || session_epoch, '|' order by id)) as h
          from auth.users`
    )[0]!.h;

  it('the real narrow login may not disable or sign out the owner or an Admin user; a member it may', async () => {
    const before = await userRows();
    for (const id of [anchor, adminByRole, adminByWs]) {
      expect(
        await run(nl, [`update auth.users set disabled_at = now() where id = '${id}'`], true),
        `disable ${id}`,
      ).toBe('42501');
      expect(
        await run(
          nl,
          [`update auth.users set session_epoch = session_epoch + 1 where id = '${id}'`],
          true,
        ),
        `epoch ${id}`,
      ).toBe('42501');
    }
    // All at once, as a forged session would: refused whole.
    expect(
      await run(nl, [`update auth.users set disabled_at = now() where disabled_at is null`], true),
    ).toBe('42501');
    expect(await userRows()).toBe(before);
    // A plain member: the users area's own disable and session end.
    expect(
      await run(nl, [
        `update auth.users set disabled_at = now(), session_epoch = session_epoch + 1 where id = '${member}'`,
      ]),
    ).toBeNull();
  });

  it('off the narrow route a narrow reason`s change of a held login is counted, the row written; at a spot or for a member not', async () => {
    counted();
    const who = 'system:http:admin-area';
    const set = (spot = false) =>
      `select set_config('mantle.actor', '${who}', true), set_config('mantle.write_mode', 'rw', true)` +
      (spot ? `, set_config('mantle.route', 'full', true)` : '');
    expect(
      await run(rt, [
        set(),
        `update auth.users set session_epoch = session_epoch + 1 where id = '${adminByWs}'`,
      ]),
    ).toBeNull();
    expect(counted()).toEqual([`${PREFIX}narrow-would-refuse ${who} auth.users UPDATE`]);
    expect(
      await run(rt, [
        set(true),
        `update auth.users set session_epoch = session_epoch + 1 where id = '${adminByWs}'`,
      ]),
    ).toBeNull();
    expect(
      await run(rt, [
        set(),
        `update auth.users set session_epoch = session_epoch + 1 where id = '${member}'`,
      ]),
    ).toBeNull();
    expect(counted()).toEqual([]);
  });

  it('the real narrow login may not revoke or remove a held login`s grants; a member`s it may; a revoked key`s revoked_by is never rewritten', async () => {
    const c1 = randomUUID();
    const c2 = randomUUID();
    const ids = {
      tOwner: randomUUID(),
      tAdmin: randomUUID(),
      tMember: randomUUID(),
      aOwner: randomUUID(),
      aAdmin: randomUUID(),
      aMember: randomUUID(),
      aRevoked: randomUUID(),
      mOwner: randomUUID(),
      mMember: randomUUID(),
    };
    const tag = randomUUID().slice(0, 8);
    await su`insert into oauth_clients (id, redirect_uris) values
      (${c1}, ${['https://c1.example.test/cb']}), (${c2}, ${['https://c2.example.test/cb']})`;
    const tok = (id: string, client: string, actor: string) =>
      su`insert into oauth_access_tokens (id, token_hash, owner_id, actor_id, client_id, expires_at)
         values (${id}, ${`${tag}-${id}`}, ${anchor}, ${actor}, ${client}, now() + interval '1 day')`;
    await tok(ids.tOwner, c1, anchor);
    await tok(ids.tAdmin, c2, adminByWs);
    await tok(ids.tMember, c2, member);
    const code = (client: string, actor: string, n: string) =>
      su`insert into oauth_auth_codes (code_hash, client_id, owner_id, actor_id, code_challenge, redirect_uri, expires_at)
         values (${`${tag}-code-${n}`}, ${client}, ${anchor}, ${actor}, 'x', 'https://c.example.test/cb', now() + interval '5 minutes')`;
    await code(c2, adminByRole, 'admin');
    await code(c2, member, 'member');
    const key = (id: string, login: string, revoked = false) =>
      su`insert into access_keys (id, name, login_id, key_prefix, key_hash, access, revoked_at, revoked_by)
         values (${id}, 'k', ${login}, ${id.replace(/-/g, '').slice(0, 8)},
                 ${createHash('sha256').update(`${tag}-${id}`).digest('hex')}, 'read',
                 ${revoked ? new Date() : null}, ${revoked ? login : null})`;
    const keyIds = [ids.aOwner, ids.aAdmin, ids.aMember, ids.aRevoked];
    await key(ids.aOwner, anchor);
    await key(ids.aAdmin, adminByRole);
    await key(ids.aMember, member);
    await key(ids.aRevoked, member, true);
    const dev = (id: string, login: string) =>
      su`insert into mobile_tokens (id, user_id, label, expires_at)
         values (${id}, ${login}, 'phone', now() + interval '1 day')`;
    await dev(ids.mOwner, anchor);
    await dev(ids.mMember, member);
    const grants = async () =>
      (
        await su<{ h: string }[]>`
          select md5(
            (select coalesce(string_agg(id::text || coalesce(revoked_at::text, '-'), '|' order by id), '')
               from oauth_access_tokens where client_id in (${c1}, ${c2})) || '#' ||
            (select coalesce(string_agg(code_hash, '|' order by code_hash), '')
               from oauth_auth_codes where client_id in (${c1}, ${c2})) || '#' ||
            (select coalesce(string_agg(id::text || coalesce(revoked_at::text, '-') || coalesce(revoked_by::text, '-'), '|' order by id), '')
               from access_keys where id in ${su(keyIds)}) || '#' ||
            (select coalesce(string_agg(id::text || coalesce(revoked_at::text, '-'), '|' order by id), '')
               from mobile_tokens where id in (${ids.mOwner}, ${ids.mMember})) || '#' ||
            (select count(*)::text from oauth_clients where id in (${c1}, ${c2}))) as h`
      )[0]!.h;
    const before = await grants();
    const refused: Array<[string, string]> = [
      [
        'owner token',
        `update oauth_access_tokens set revoked_at = now() where id = '${ids.tOwner}'`,
      ],
      [
        'Admin token',
        `update oauth_access_tokens set revoked_at = now() where id = '${ids.tAdmin}'`,
      ],
      [
        'owner key',
        `update access_keys set revoked_at = now(), revoked_by = '${member}' where id = '${ids.aOwner}'`,
      ],
      ['Admin key', `update access_keys set revoked_at = now() where id = '${ids.aAdmin}'`],
      ['owner device', `update mobile_tokens set revoked_at = now() where id = '${ids.mOwner}'`],
      [
        'Admin code',
        `delete from oauth_auth_codes where client_id = '${c2}' and actor_id = '${adminByRole}'`,
      ],
      ['client of the owner', `delete from oauth_clients where id = '${c1}'`],
      ['client of an Admin user', `delete from oauth_clients where id = '${c2}'`],
      [
        'every live grant at once',
        `update oauth_access_tokens set revoked_at = now() where revoked_at is null`,
      ],
      [
        "a revoked key's revoker",
        `update access_keys set revoked_by = '${anchor}' where id = '${ids.aRevoked}'`,
      ],
    ];
    for (const [what, stmt] of refused) {
      expect(await run(nl, [stmt], true), what).toBe('42501');
    }
    expect(await grants()).toBe(before);
    // A member's grants: the users area's own revokes on the narrow login.
    for (const stmt of [
      `update oauth_access_tokens set revoked_at = now() where id = '${ids.tMember}'`,
      `update access_keys set revoked_at = now(), revoked_by = '${anchor}' where id = '${ids.aMember}'`,
      `update mobile_tokens set revoked_at = now() where id = '${ids.mMember}'`,
      `delete from oauth_auth_codes where client_id = '${c2}' and actor_id = '${member}'`,
    ]) {
      expect(await run(nl, [stmt]), stmt).toBeNull();
    }
    // Off the narrow route a narrow reason's revoke of a held grant is
    // counted, the row written; at a spot not.
    counted();
    const who = 'system:http:admin-area';
    const set = (spot = false) =>
      `select set_config('mantle.actor', '${who}', true), set_config('mantle.write_mode', 'rw', true)` +
      (spot ? `, set_config('mantle.route', 'full', true)` : '');
    expect(
      await run(rt, [
        set(),
        `update mobile_tokens set revoked_at = now() where id = '${ids.mOwner}'`,
      ]),
    ).toBeNull();
    expect(counted()).toEqual([`${PREFIX}narrow-would-refuse ${who} public.mobile_tokens UPDATE`]);
    expect(await run(rt, [set(true), `delete from oauth_clients where id = '${c1}'`])).toBeNull();
    expect(counted()).toEqual([]);
    await su`delete from oauth_clients where id in (${c1}, ${c2})`;
    await su`delete from access_keys where id in ${su(keyIds)}`;
    await su`delete from mobile_tokens where id in (${ids.mOwner}, ${ids.mMember})`;
  });

  it('with the held readers taken from the runtime role (an older image`s grants) every sign-in and sign-out write writes, uncounted; the narrow login`s holds refuse', async () => {
    // One image back, the older image's migrate grants the runtime role its
    // own list: the two held readers are not on it. The report branches ask
    // them through mantle_narrow_report, which answers false on a 42501.
    const readers = [
      'public.mantle_narrow_login_held(uuid)',
      'public.mantle_narrow_client_held(uuid)',
    ];
    const client = randomUUID();
    const tokId = randomUUID();
    const keyId = randomUUID();
    const devA = randomUUID();
    const devB = randomUUID();
    const tag = randomUUID().slice(0, 8);
    await su`insert into oauth_clients (id, redirect_uris) values (${client}, ${['https://n1.example.test/cb']})`;
    await su`insert into oauth_access_tokens (id, token_hash, owner_id, actor_id, client_id, expires_at)
             values (${tokId}, ${`${tag}-t`}, ${anchor}, ${anchor}, ${client}, now() + interval '1 day')`;
    await su`insert into oauth_auth_codes (code_hash, client_id, owner_id, actor_id, code_challenge, redirect_uri, expires_at)
             values (${`${tag}-code`}, ${client}, ${anchor}, ${member}, 'x', 'https://c.example.test/cb', now() + interval '5 minutes')`;
    await su`insert into access_keys (id, name, login_id, key_prefix, key_hash, access)
             values (${keyId}, 'k', ${member}, ${keyId.replace(/-/g, '').slice(0, 8)},
                     ${createHash('sha256').update(`${tag}-k`).digest('hex')}, 'read')`;
    for (const d of [devA, devB]) {
      await su`insert into mobile_tokens (id, user_id, label, expires_at)
               values (${d}, ${member}, 'phone', now() + interval '1 day')`;
    }
    await su.unsafe(
      `REVOKE EXECUTE ON FUNCTION ${readers.join(', ')} FROM mantle_runtime, ${NARROW_ROLE}`,
    );
    try {
      counted();
      const set = (who: string, mark = false) =>
        `select set_config('mantle.actor', '${who}', true), set_config('mantle.write_mode', 'rw', true), ` +
        `set_config('mantle.actor_check', 'on', true)` +
        (mark ? `, set_config('mantle.route', 'narrow', true)` : '');
      const self = 'system:http:login-self';
      const area = 'system:http:admin-area';
      const writes: [string, string, string, boolean][] = [
        [
          'a device token rotated',
          self,
          `update mobile_tokens set revoked_at = now() where id = '${devA}'`,
          false,
        ],
        [
          'a phone signed out',
          self,
          `update mobile_tokens set revoked_at = now() where id = '${devB}'`,
          false,
        ],
        [
          'a member key revoked',
          area,
          `update access_keys set revoked_at = now(), revoked_by = '${anchor}' where id = '${keyId}'`,
          false,
        ],
        [
          'a member disabled',
          area,
          `update auth.users set disabled_at = now(), session_epoch = session_epoch + 1 where id = '${victim}'`,
          false,
        ],
        [
          'the owner`s sessions ended (held)',
          area,
          `update auth.users set session_epoch = session_epoch + 1 where id = '${anchor}'`,
          false,
        ],
        [
          'the owner`s MCP token revoked (held)',
          area,
          `update oauth_access_tokens set revoked_at = now() where id = '${tokId}'`,
          false,
        ],
        [
          'an OAuth code burned',
          area,
          `delete from oauth_auth_codes where code_hash = '${tag}-code'`,
          false,
        ],
        [
          'a member key revoked, the statement marked narrow',
          'login:x',
          `update access_keys set revoked_at = now() where id = '${keyId}'`,
          true,
        ],
        [
          'an MCP client removed (held)',
          area,
          `delete from oauth_clients where id = '${client}'`,
          false,
        ],
      ];
      for (const [what, who, stmt, mark] of writes) {
        expect(await run(rt, [set(who, mark), stmt]), what).toBeNull();
      }
      expect(counted()).toEqual([]);
      // Fail closed on the narrow login: a member's disable it could make
      // is refused while it may not run the reader.
      expect(
        await run(nl, [`update auth.users set disabled_at = now() where id = '${member}'`]),
      ).toBe('42501');
      expect(
        await run(nl, [`update mobile_tokens set revoked_at = now() where id = '${devA}'`]),
      ).toBe('42501');
    } finally {
      await su.unsafe(
        `GRANT EXECUTE ON FUNCTION ${readers.join(', ')} TO mantle_runtime, ${NARROW_ROLE}`,
      );
      await su`delete from oauth_clients where id = ${client}`;
      await su`delete from access_keys where id = ${keyId}`;
      await su`delete from mobile_tokens where id in (${devA}, ${devB})`;
    }
    // With the readers back, the same held write by a narrow reason counts.
    expect(
      await run(rt, [
        `select set_config('mantle.actor', 'system:http:admin-area', true), set_config('mantle.write_mode', 'rw', true)`,
        `update auth.users set session_epoch = session_epoch + 1 where id = '${anchor}'`,
      ]),
    ).toBeNull();
    expect(counted()).toEqual([
      `${PREFIX}narrow-would-refuse system:http:admin-area auth.users UPDATE`,
    ]);
  });

  const scopeOf = (login: string) => `select set_config('mantle.scope_login', '${login}', true)`;
  const ledgerRows = async () =>
    (
      await su<{ h: string }[]>`
        select coalesce(md5(string_agg(l::text, '|' order by l.turn_id)), '') as h
          from member_turn_ledger l where l.login_id in (${member}, ${victim})`
    )[0]!.h;

  it('the token budget reads the ledger`s own tokens, stamped for the scope login only and only up', async () => {
    const tag = randomUUID().slice(0, 8);
    const claim = (login: string, turn: string, tokens: number) =>
      rt.begin(async (tx) => {
        await tx.unsafe(scopeOf(login));
        return tx<{ ok: boolean; reason: string | null; used: string | null }[]>`
          select ok, reason, used from mantle_member_turn_claim(${turn}, ${anchor}::uuid,
            now() - interval '1 hour', 100, ${tokens}::bigint)`;
      });
    const settle = (login: string, turn: string, tokens: number) =>
      rt.begin(async (tx) => {
        await tx.unsafe(scopeOf(login));
        return (
          await tx<
            { hit: boolean }[]
          >`select mantle_member_turn_settle(${turn}, ${tokens}::bigint) as hit`
        )[0]!.hit;
      });
    expect((await claim(member, `${tag}.a`, 1000))[0]!.ok).toBe(true);
    expect((await claim(victim, `${tag}.v`, 1000))[0]!.ok).toBe(true);
    expect(await settle(member, `${tag}.a`, 700)).toBe(true);
    // Only up: a lower count keeps the higher one.
    expect(await settle(member, `${tag}.a`, 10)).toBe(true);
    // Never another login's slot.
    expect(await settle(member, `${tag}.v`, 5_000_000)).toBe(false);
    const tok = async (turn: string) =>
      Number(
        (
          await su<
            { t: string }[]
          >`select tokens::text as t from member_turn_ledger where turn_id = ${turn}`
        )[0]!.t,
      );
    expect(await tok(`${tag}.a`)).toBe(700);
    expect(await tok(`${tag}.v`)).toBe(0);
    // A trace the narrow login may write moves nothing now: a victim's
    // inflated, the member's own traces zero.
    await su`insert into traces (owner_id, kind, subject_kind, status, tokens_in, tokens_out, data)
             values (${anchor}, 'responder_turn', 'team_turn', 'success', 9000000, 0,
                     ${JSON.stringify({ login_id: victim })}::text::jsonb)`;
    expect((await claim(victim, `${tag}.v2`, 1000))[0]!.ok).toBe(true);
    // The member's own budget: 700 of 1000 used, 701 refuses.
    expect((await claim(member, `${tag}.b`, 1000))[0]!.ok).toBe(true);
    expect((await claim(member, `${tag}.c`, 700))[0]).toEqual({
      ok: false,
      reason: 'token_budget',
      used: '700',
    });
  });

  it('the real narrow login runs no settle and touches no ledger row; it deletes no trace', async () => {
    const before = await ledgerRows();
    const forge = `select set_config('mantle.scope_login', '${member}', true),
                          set_config('mantle.login_id', '${member}', true),
                          set_config('mantle.acting_login', '${member}', true)`;
    for (const st of [
      `select mantle_member_turn_settle('x', 0)`,
      `update member_turn_ledger set tokens = 0 where login_id = '${member}'`,
      `update member_turn_ledger set tokens = tokens + 9000000 where login_id = '${victim}'`,
      `delete from member_turn_ledger where login_id = '${member}'`,
      `delete from traces where owner_id = '${anchor}'`,
    ]) {
      expect(await run(nl, [forge, st], true), st).toBe('42501');
    }
    expect(await ledgerRows()).toBe(before);
    // Its measured trace writes stay: an insert of a trace row.
    expect(
      await run(nl, [
        `insert into traces (owner_id, kind, status) values ('${anchor}', 'responder_turn', 'running')`,
      ]),
    ).toBeNull();
  });

  it('the real narrow login writes no count epoch and no miss dated ahead; a plain miss row it may', async () => {
    const epochs = async () =>
      Number(
        (
          await su<{ n: string }[]>`select count(*)::text as n from actor_check_misses
             where check_name = 'narrow-epoch' or at > now() + interval '1 minute'`
        )[0]!.n,
      );
    const before = await epochs();
    for (const st of [
      `insert into actor_check_misses (source, check_name, actor, detail) values ('sql', 'narrow-epoch', '', 'forged')`,
      `insert into actor_check_misses (source, check_name, actor, detail, at)
         values ('ts', 'narrow-denied', 'x', 'y', now() + interval '10 years')`,
      `select mantle_actor_miss_log('sql', 'narrow-epoch', '', 'forged')`,
    ]) {
      expect(await run(nl, [st], true), st).toBe('42501');
    }
    expect(await epochs()).toBe(before);
    expect(
      await run(nl, [
        `insert into actor_check_misses (source, check_name, actor, detail) values ('ts', 'narrow-denied', 'x', 'y')`,
      ]),
    ).toBeNull();
  });

  it('every narrow migration runs again over its own end state and leaves it as it was', async () => {
    // Each function (by signature, with its rights) and trigger (by
    // table and name), sorted: a re-run that drops and makes an object
    // again shows only if its text or rights change.
    const snapshot = async () =>
      (
        await su<{ d: string }[]>`
          select p.oid::regprocedure::text || ' ' || coalesce(p.proacl::text, '') || ' '
                 || md5(pg_get_functiondef(p.oid)) as d
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'mantle\\_%' and p.prokind = 'f'
          union all
          select t.tgrelid::regclass::text || ' ' || t.tgname || ' ' || md5(pg_get_triggerdef(t.oid))
            from pg_trigger t where not t.tgisinternal
           order by 1`
      ).map((r) => r.d);
    const before = await snapshot();
    const dir = join(__dirname, '..', 'migrations');
    // The narrow set by name, from the journal (never by number: a
    // renumber at a rebase must not swap in another branch's migration or
    // drop the last of these).
    const names = [
      'acting_login_definers',
      'structure_item_definer',
      'promotion_agent_definers',
      'narrow_observe_definer_frames',
      'narrow_one_way_columns',
      'narrow_would_refuse',
      'narrow_row_rules',
      'identity_gateway',
      'narrow_message_rules',
      'narrow_enable_off',
      'narrow_off_on_insert',
      'member_turn_ledger_definers',
      'narrow_lockout_and_ledger_tokens',
    ];
    const journal = (
      JSON.parse(readFileSync(join(dir, 'meta', '_journal.json'), 'utf8')) as {
        entries: { idx: number; tag: string }[];
      }
    ).entries;
    const tags = journal
      .filter((e) => names.includes(e.tag.replace(/^[0-9]+_/, '')))
      .sort((a, b) => a.idx - b.idx)
      .map((e) => e.tag);
    expect(tags.map((t) => t.replace(/^[0-9]+_/, ''))).toEqual(names);
    const files = tags.map((t) => `${t}.sql`);
    expect(files.filter((f) => !readdirSync(dir).includes(f))).toEqual([]);
    for (const f of files) {
      const parts = readFileSync(join(dir, f), 'utf8').split('--> statement-breakpoint');
      await su.begin(async (tx) => {
        await tx.unsafe(`select set_config('mantle.actor', 'system:migration', true)`);
        for (const p of parts) if (p.trim()) await tx.unsafe(p);
      });
    }
    expect(await snapshot()).toEqual(before);
  });
});

describe.skipIf(!URL)('the would-refuse count reads refused calls (switch off)', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let su: ReturnType<typeof postgres>;
  let m: typeof import('./index');
  let v: typeof import('./viewer');
  let rr: typeof import('./runtime-role');

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    su = postgres(scratch.url, { max: 1, prepare: false });
    expect(await ensureRuntimeRoles(su, KEY, { login: true, narrowLogin: true })).toBe('ok');
    await ensureTestAnchor(su);
    process.env.DATABASE_URL = scratch.url;
    rr = await import('./runtime-role');
    rr.setNarrowSystemForTests(false);
    v = await import('./viewer');
    m = await import('./index');
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    rr?.setNarrowSystemForTests(null);
    await su?.end();
    await scratch?.drop();
  }, 60_000);

  const fnNotes = () =>
    takeNarrowWrites().filter(
      (w) => w.check === 'narrow-would-refuse' && w.detail.startsWith('fn:'),
    );

  it('notes a call the narrow role may not run, in an exit routed narrow only', async () => {
    takeNarrowWrites();
    const id = randomUUID();
    // mantle_login_is_admin: the runtime role's, never the narrow role's.
    await v.asSystem(
      () => m.db.execute(sqlTag`select "public"."mantle_login_is_admin"(${id}::uuid) as a`),
      'admin-area',
    );
    await expect.poll(() => fnNotes().length > 0 || null, { timeout: 5000 }).toBe(true);
    // One it may run (mantle_brain_id), and the same refused call as plain
    // system work: nothing.
    await v.asSystem(
      () => m.db.execute(sqlTag`select "public"."mantle_brain_id"() as b`),
      'admin-area',
    );
    await v.asSystem(
      () => m.db.execute(sqlTag`select "public"."mantle_login_is_admin"(${id}::uuid) as a`),
      'app-data',
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(fnNotes()).toEqual([]);
  });

  it('reads the calls inside a transaction of that exit', async () => {
    takeNarrowWrites();
    const id = randomUUID();
    await v.asSystem(
      () =>
        m.db.transaction(async (tx) => {
          await tx.execute(sqlTag`select "public"."mantle_login_is_admin"(${id}::uuid) as a`);
        }),
      'admin-area',
    );
    await expect
      .poll(
        () =>
          takeNarrowWrites().some(
            (w) =>
              w.check === 'narrow-would-refuse' && w.detail === 'fn:mantle_login_is_admin EXECUTE',
          ) || null,
        { timeout: 5000 },
      )
      .toBe(true);
  });
});

describe.skipIf(!URL)(
  'a narrow refusal raised by a row rule is noted and never read as a read-only database (switch on)',
  () => {
    let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
    let su: ReturnType<typeof postgres>;
    let m: typeof import('./index');
    let rr: typeof import('./runtime-role');
    let ts: typeof import('./test-support');
    let anchor = '';
    const login = randomUUID();

    beforeAll(async () => {
      scratch = await createMigratedScratchDatabase(URL!);
      su = postgres(scratch.url, { max: 1, prepare: false });
      expect(await ensureRuntimeRoles(su, KEY, { login: true, narrowLogin: true })).toBe('ok');
      anchor = await ensureTestAnchor(su);
      await su`insert into auth.users (id, email, password_hash, role)
             values (${login}, ${`${login}@example.test`}, 'x', 'member')`;
      process.env.DATABASE_URL = scratch.url;
      process.env.MANTLE_MASTER_KEY ??= KEY;
      rr = await import('./runtime-role');
      rr.setNarrowSystemForTests(true);
      ts = await import('./test-support');
      m = await import('./index');
    }, 180_000);

    afterAll(async () => {
      await m?.closeDb();
      rr?.setNarrowSystemForTests(null);
      await su?.end();
      await scratch?.drop();
    }, 60_000);

    it('the hold`s refusal of systemDb inside a login`s request scope is noted, and isWriteRefused says no', async () => {
      ts.takeNarrowDenials();
      let caught: unknown = null;
      await m.runInRequestSlot(async () => {
        const scope = Object.freeze({
          kind: 'user' as const,
          loginId: login,
          ws: Object.freeze([]),
          modWs: Object.freeze([]),
        });
        expect(m.enterRequestScope(scope, { writes: true, drafts: false })).toBe(true);
        try {
          await m.systemDb
            .update(m.authUsers)
            .set({ sessionEpoch: sqlTag`${m.authUsers.sessionEpoch} + 1` })
            .where(sqlTag`${m.authUsers.id} = ${anchor}`);
        } catch (err) {
          caught = err;
          // Caught here: never a read-only database to skip.
          expect(m.isWriteRefused(err)).toBe(false);
        }
      });
      expect(caught).not.toBeNull();
      const denied = ts.takeNarrowDenials();
      expect(denied.map((d) => d.what).join('\n')).toContain(
        'may not disable or sign out the owner',
      );
    });
  },
);
