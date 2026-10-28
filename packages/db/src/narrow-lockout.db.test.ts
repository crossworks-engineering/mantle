/**
 * Migration 0327 and 0328 on a real, migrated Postgres:
 *
 *  - the login hold: the REAL narrow login (session_user
 *    mantle_system_narrow) may not move disabled_at or session_epoch of the
 *    owner, an admin by role, or a user of the Admin workspace (refused
 *    42501, rows unchanged); a plain member's it may (the users area's own
 *    write);
 *  - the member token budget reads the ledger's own tokens: the settle
 *    stamps them for the scope login only, only up; traces the narrow login
 *    may write change nothing (inflated for a victim, or zeroed for itself);
 *    the narrow login may neither run the settle nor touch the ledger;
 *  - the narrow login holds no DELETE of traces;
 *  - the count's epoch: the narrow login writes no narrow-epoch row and no
 *    miss dated ahead, directly or through mantle_actor_miss_log; a plain
 *    miss row it still may;
 *  - 0328: the grant hold also holds a held login's unclaimed pairing
 *    codes, push devices (a row with no login is the owner's) and the
 *    peers acting as it (released only at the spot); a member's the narrow
 *    login still removes;
 *  - every migration of the narrow set (0312 to 0329, and 0341 that took
 *    the report branch out; the narrow role stays read only on the content
 *    tables, closed in S7d) runs again over its own end state and leaves it
 *    as it was (0322's end-state check, 0319 with the rules after it).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/narrow-lockout.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { sql as sqlTag } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedScratchDatabase, ensureAdminUsers, ensureTestAnchor } from './test-support';
import {
  NARROW_ROLE,
  ensureRuntimeRoles,
  narrowRolePassword,
  runtimeDatabaseUrl,
  runtimeRolePassword,
} from './runtime-role';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const KEY = process.env.MANTLE_MASTER_KEY ?? 'mantle-viewer-test-key';

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

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    const keep = () => {};
    su = postgres(scratch.url, { max: 1, prepare: false, onnotice: keep });
    expect(await ensureRuntimeRoles(su, KEY, { login: true })).toBe('ok');
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
    await su`delete from oauth_clients where id in (${c1}, ${c2})`;
    await su`delete from access_keys where id in ${su(keyIds)}`;
    await su`delete from mobile_tokens where id in (${ids.mOwner}, ${ids.mMember})`;
  });

  it('0328: the real narrow login may not remove a held login`s pairing codes or push devices, nor release a peer acting as one; a member`s it may', async () => {
    const tag = randomUUID().slice(0, 8);
    const node = async (title: string) =>
      (
        await su<{ id: string }[]>`
          insert into nodes (owner_id, type, title, path) values (${anchor}, 'note', ${title}, 'notes')
          returning id::text as id`
      )[0]!.id;
    const peer = { owner: randomUUID(), admin: randomUUID(), member: randomUUID() };
    for (const [id, login] of [
      [peer.owner, anchor],
      [peer.admin, adminByWs],
      [peer.member, member],
    ] as const) {
      await su`insert into mantle_peers (id, owner_id, node_id, display_name, base_url, inbound_token_hash, acts_as_login_id)
               values (${id}, ${anchor}, ${await node(`peer ${id.slice(0, 8)}`)}, 'p', 'https://p.example.test',
                       ${`${tag}-${id}`}, ${login})`;
    }
    const code = (login: string, n: string) =>
      su`insert into pairing_codes (code_hash, user_id, expires_at)
         values (${`${tag}-pc-${n}`}, ${login}, now() + interval '5 minutes')`;
    await code(anchor, 'owner');
    await code(adminByRole, 'admin');
    await code(member, 'member');
    const device = (login: string | null, n: string) =>
      su`insert into push_subscriptions (owner_id, login_id, routing_token, public_key, platform)
         values (${anchor}, ${login}, ${`${tag}-rt-${n}`}, 'k', 'ios')`;
    await device(anchor, 'owner');
    await device(adminByWs, 'admin');
    await device(null, 'legacy');
    await device(member, 'member');
    const state = async () =>
      (
        await su<{ h: string }[]>`
          select md5(concat_ws('#',
            (select string_agg(code_hash, '|' order by code_hash) from pairing_codes where code_hash like ${`${tag}-%`}),
            (select string_agg(routing_token, '|' order by routing_token) from push_subscriptions where routing_token like ${`${tag}-%`}),
            (select string_agg(id::text || coalesce(acts_as_login_id::text, '-'), '|' order by id)
               from mantle_peers where id in (${peer.owner}, ${peer.admin}, ${peer.member})))) as h`
      )[0]!.h;
    const before = await state();
    const release = (id: string) =>
      `update mantle_peers set ended_acts_as_login_id = acts_as_login_id, acts_as_login_id = null where id = '${id}'`;
    const refused: Array<[string, string]> = [
      ['owner pairing code', `delete from pairing_codes where code_hash = '${tag}-pc-owner'`],
      ['Admin pairing code', `delete from pairing_codes where code_hash = '${tag}-pc-admin'`],
      ['owner device', `delete from push_subscriptions where routing_token = '${tag}-rt-owner'`],
      ['Admin device', `delete from push_subscriptions where routing_token = '${tag}-rt-admin'`],
      [
        'a device with no login',
        `delete from push_subscriptions where routing_token = '${tag}-rt-legacy'`,
      ],
      [
        'every device at once',
        `delete from push_subscriptions where routing_token like '${tag}-%'`,
      ],
      ['peer acting as the owner', release(peer.owner)],
      ['peer acting as an Admin user', release(peer.admin)],
    ];
    for (const [what, stmt] of refused) {
      expect(await run(nl, [stmt], true), what).toBe('42501');
    }
    expect(await state()).toBe(before);
    // A member's: the users area's own lockout writes on the narrow login.
    for (const stmt of [
      `delete from pairing_codes where code_hash = '${tag}-pc-member'`,
      `delete from push_subscriptions where routing_token = '${tag}-rt-member'`,
      release(peer.member),
    ]) {
      expect(await run(nl, [stmt]), stmt).toBeNull();
    }
    await su`delete from pairing_codes where code_hash like ${`${tag}-%`}`;
    await su`delete from push_subscriptions where routing_token like ${`${tag}-%`}`;
    await su`delete from mantle_peers where id in (${peer.owner}, ${peer.admin}, ${peer.member})`;
  });

  it('with the held readers taken from the runtime role (an older image`s grants) every sign-in and sign-out write on the full route writes; the narrow login`s holds refuse', async () => {
    // One image back, the older image's migrate grants the runtime role its
    // own list: the two held readers are not on it. The full route never
    // asks them; the narrow login's holds fail closed without them.
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
      const set = (who: string) =>
        `select set_config('mantle.actor', '${who}', true), set_config('mantle.write_mode', 'rw', true), ` +
        `set_config('mantle.actor_check', 'on', true)`;
      const self = 'system:http:login-self';
      const area = 'system:http:admin-area';
      const writes: [string, string, string][] = [
        [
          'a device token rotated',
          self,
          `update mobile_tokens set revoked_at = now() where id = '${devA}'`,
        ],
        [
          'a phone signed out',
          self,
          `update mobile_tokens set revoked_at = now() where id = '${devB}'`,
        ],
        [
          'a member key revoked',
          area,
          `update access_keys set revoked_at = now(), revoked_by = '${anchor}' where id = '${keyId}'`,
        ],
        [
          'a member disabled',
          area,
          `update auth.users set disabled_at = now(), session_epoch = session_epoch + 1 where id = '${victim}'`,
        ],
        [
          'the owner`s sessions ended (held)',
          area,
          `update auth.users set session_epoch = session_epoch + 1 where id = '${anchor}'`,
        ],
        [
          'the owner`s MCP token revoked (held)',
          area,
          `update oauth_access_tokens set revoked_at = now() where id = '${tokId}'`,
        ],
        [
          'an OAuth code burned',
          area,
          `delete from oauth_auth_codes where code_hash = '${tag}-code'`,
        ],
        ['an MCP client removed (held)', area, `delete from oauth_clients where id = '${client}'`],
      ];
      for (const [what, who, stmt] of writes) {
        expect(await run(rt, [set(who), stmt]), what).toBeNull();
      }
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
      // 0312 first: 0320's report predicate reads its mantle_narrow_actor,
      // which 0341 drops, and a SQL function's body is checked when made.
      'narrow_write_observe',
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
      'narrow_hold_wider',
      'narrow_counter_enabled',
      'narrow_observe_removed',
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

describe.skipIf(!URL)(
  'a narrow refusal raised by a row rule is noted and never read as a read-only database',
  () => {
    let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
    let su: ReturnType<typeof postgres>;
    let m: typeof import('./index');
    let ts: typeof import('./test-support');
    let anchor = '';
    const login = randomUUID();

    beforeAll(async () => {
      scratch = await createMigratedScratchDatabase(URL!);
      su = postgres(scratch.url, { max: 1, prepare: false });
      expect(await ensureRuntimeRoles(su, KEY, { login: true })).toBe('ok');
      anchor = await ensureTestAnchor(su);
      await su`insert into auth.users (id, email, password_hash, role)
             values (${login}, ${`${login}@example.test`}, 'x', 'member')`;
      process.env.DATABASE_URL = scratch.url;
      process.env.MANTLE_MASTER_KEY ??= KEY;
      ts = await import('./test-support');
      m = await import('./index');
    }, 180_000);

    afterAll(async () => {
      await m?.closeDb();
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
