/**
 * The narrow login's containment (plan v3.2 S7b part b2: the
 * interim audit of 0314 and 0315). On the narrow login the acting login is
 * a mistake guard only: a raw narrow session may name any acting login
 * (only the gateway's text check stops it). The database boundaries are
 * the definers' kind, op, place, type and owner checks and the column
 * rights. So, on a switched brain (an Admin workspace with bridge_key
 * 'admin', real logins), sent raw on a narrow session:
 *
 *  - no credential or rights column of auth.users is writable, no login and
 *    no credential row may be made (access-matrix.ts NARROW_COLUMN_RIGHTS);
 *    the audit's chain (a member's role raised, bridged into Admin, then a
 *    structure item as that member) is refused at each step, rows unchanged;
 *  - every definer that takes a login with no scope (0314's header, the
 *    0315 and 0316 definers) writes nothing for a login it is given with
 *    another acting login named, or is refused;
 *  - the writers' positive runs (a real chat unpaired, a real key revoked,
 *    an assistant's pinned Telegram chat denied);
 *  - the session check accepts the definers' owner (a non-superuser owner
 *    brain);
 *  - mantle_structure_item: an update that names no data is refused; a
 *    delete's match is read again under the heads (both routes);
 *  - the structure gateway in a turn whose actor is no login (the actor
 *    check off: a Telegram turn) takes the turn's login; with no login at
 *    all (a heartbeat's) it runs at the spot structure-no-login; a nested
 *    system transaction sends the acting login;
 *  - an edit through the definer equals the app's: the vector dropped, the
 *    node_ingested announcement sent on both.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedScratchDatabase,
  ensureTestAnchor,
  runWorkspacesSwitch,
} from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the narrow login holds no right and no credential', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let rr: typeof import('./runtime-role');
  let v: typeof import('./viewer');
  let m: typeof import('./index');
  let pools: typeof import('./gateway/pools');
  let su: ReturnType<typeof postgres>;
  let nl: ReturnType<typeof postgres>;
  let brain = '';
  let adminWs = '';
  /** A real admin login (in Admin through the switch) and a real member. */
  const admin = randomUUID();
  const member = randomUUID();
  const KEY = () => process.env.MANTLE_MASTER_KEY ?? 'mantle-viewer-test-key';

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    su = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    brain = await ensureTestAnchor(su);
    for (const [id, role] of [
      [admin, 'admin'],
      [member, 'member'],
    ] as const) {
      await su`insert into auth.users (id, email, password_hash, role, display_name)
               values (${id}, ${`${id}@example.test`}, 'x', ${role}, ${role})`;
    }
    // A switched brain: the switch makes Admin (bridge_key 'admin') and
    // bridges every admin login into it.
    await runWorkspacesSwitch(scratch.url);
    const [ws] = await su<{ id: string }[]>`
      select id::text as id from workspaces where owner_id = ${brain} and bridge_key = 'admin'`;
    adminWs = ws!.id;
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    rr = await import('./runtime-role');
    rr.setNarrowSystemForTests(true);
    v = await import('./viewer');
    m = await import('./index');
    pools = await import('./gateway/pools');
    nl = postgres(
      rr.runtimeDatabaseUrl(scratch.url, rr.narrowRolePassword(KEY()), rr.NARROW_ROLE),
      {
        max: 1,
        prepare: false,
        onnotice: () => {},
      },
    );
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    rr?.setNarrowSystemForTests(null);
    for (const c of [nl, su]) await c?.end();
    await scratch?.drop();
  });

  /** Statements on `on` in a transaction that rolls back: 'ok' or the
   *  first error's code. */
  const run = (on: ReturnType<typeof postgres>, stmts: string[]) =>
    on
      .begin(async (t) => {
        for (const s of stmts) await t.unsafe(s);
        throw Object.assign(new Error('rollback'), { ok: true });
      })
      .then(
        () => 'ok',
        (e: { ok?: boolean; code?: string }) => (e.ok ? 'ok' : (e.code ?? 'error')),
      );
  const acting = (login: string) => `select set_config('mantle.acting_login', '${login}', true)`;
  /** A digest of the rights and credential rows a chain could change. */
  const rights = async () =>
    (
      await su<{ h: string }[]>`
      select md5(concat_ws('#',
        (select string_agg(u::text, '|' order by u.id) from auth.users u),
        (select string_agg(w::text, '|' order by w.workspace_id, w.login_id) from workspace_users w),
        (select count(*)::text from workspace_events),
        (select string_agg(k::text, '|' order by k.id) from access_keys k),
        (select string_agg(c::text, '|' order by c.id) from telegram_chats c))) as h`
    )[0]!.h;

  it('no credential or rights column of auth.users, no new login and no minted credential', async () => {
    const before = await rights();
    const refused = [
      `update auth.users set role = 'admin' where id = '${member}'`,
      `update auth.users set password_hash = 'y' where id = '${admin}'`,
      `update auth.users set email = 'z@example.test' where id = '${admin}'`,
      `update auth.users set is_owner = true where id = '${member}'`,
      `update auth.users set contact_id = null where id = '${member}'`,
      `insert into auth.users (id, email, password_hash, role)
         values ('${randomUUID()}', 'n@example.test', 'x', 'admin')`,
      `insert into access_keys default values`,
      `insert into oauth_access_tokens default values`,
      `insert into mobile_tokens default values`,
      `update access_keys set login_id = '${member}'`,
      `update oauth_access_tokens set actor_id = '${member}'`,
    ];
    for (const s of refused) expect(await run(nl, [s]), s).toBe('42501');
    // What narrow work writes (measured), each allowed.
    for (const s of [
      `update auth.users set display_name = 'd' where id = '${member}'`,
      `update auth.users set disabled_at = now() where id = '${member}'`,
      `update auth.users set session_epoch = session_epoch + 1 where id = '${member}'`,
      `update access_keys set revoked_at = now(), revoked_by = '${admin}' where false`,
      `update oauth_access_tokens set revoked_at = now() where false`,
      `update mobile_tokens set revoked_at = now() where false`,
    ]) {
      expect(await run(nl, [s]), s).toBe('ok');
    }
    expect(await rights()).toBe(before);
  });

  it('the open rights tables (round 5): every right and every insert refused, the measured columns allowed', async () => {
    const before = await rights();
    const refused = [
      `insert into pairing_codes default values`,
      `update pairing_codes set claimed_at = now() where false`,
      `update pairing_codes set user_id = '${member}' where false`,
      `insert into oauth_auth_codes default values`,
      `update oauth_auth_codes set actor_id = '${member}' where false`,
      `insert into member_invites default values`,
      `update member_invites set redeemed_login_id = '${member}' where false`,
      `update member_invites set expires_at = now() where false`,
      `delete from member_invites where false`,
      `insert into mantle_peers default values`,
      `update mantle_peers set inbound_token_hash = 'x' where false`,
      `update mantle_peers set enabled = true where false`,
      `update mantle_peers set status = 'active' where false`,
      `update mantle_peers set write_enabled = true where false`,
      `update mantle_peers set allowed_risky_tools = '{}' where false`,
      `update mantle_peers set created_by = '${member}' where false`,
      `update mantle_peers set base_url = 'https://x.example.test' where false`,
      `delete from mantle_peers where false`,
      `insert into peer_shares default values`,
      `update peer_shares set node_id = null where false`,
      `insert into peer_share_scopes default values`,
      `update peer_share_scopes set node_type = 'note' where false`,
      `insert into telegram_chats default values`,
      `update telegram_chats set login_id = '${member}' where false`,
      `update telegram_chats set allowlist_status = 'allowed' where false`,
      `delete from telegram_chats where false`,
    ];
    for (const s of refused) expect(await run(nl, [s]), s).toBe('42501');
    for (const s of [
      `delete from pairing_codes where false`,
      `delete from oauth_auth_codes where false`,
      `update member_invites set revoked_at = now() where false`,
      `update mantle_peers set last_contacted_at = now(), updated_at = now() where false`,
      `update mantle_peers set ended_acts_as_login_id = acts_as_login_id, acts_as_login_id = null where false`,
      `update peer_shares set revoked_at = now() where false`,
      `update peer_share_scopes set revoked_at = now() where false`,
    ]) {
      expect(await run(nl, [s]), s).toBe('ok');
    }
    // No INSERT on any of them, at the table or a column.
    for (const t of [
      'pairing_codes',
      'oauth_auth_codes',
      'member_invites',
      'mantle_peers',
      'peer_shares',
      'peer_share_scopes',
      'telegram_chats',
    ]) {
      const [g] = await su<{ i: boolean }[]>`
        select has_table_privilege(${rr.NARROW_ROLE}, ${`public.${t}`}, 'INSERT')
            or has_any_column_privilege(${rr.NARROW_ROLE}, ${`public.${t}`}, 'INSERT') as i`;
      expect(g!.i, t).toBe(false);
    }
    expect(await rights()).toBe(before);
  });

  it('0318: a revoke, a disable and a session end only go one way on the narrow login; the system pool is not held', async () => {
    const peer = randomUUID();
    const invite = randomUUID();
    const device = randomUUID();
    await su`update auth.users set disabled_at = now() where id = ${member}`;
    await su`insert into mobile_tokens (id, user_id, expires_at, revoked_at)
             values (${device}, ${member}, now() + interval '1 day', now())`;
    await su`insert into member_invites (id, owner_id, email, code_hash, expires_at, revoked_at)
             values (${invite}, ${brain}, ${`${invite}@example.test`}, ${invite}, now() + interval '1 day', now())`;
    const [pn] = await su<{ id: string }[]>`
      insert into nodes (owner_id, type, title, path) values (${brain}, 'note', 'peer', 'notes')
      returning id::text as id`;
    await su`insert into mantle_peers (id, owner_id, node_id, display_name, base_url, inbound_token_hash, acts_as_login_id)
             values (${peer}, ${brain}, ${pn!.id}, 'p', 'https://p.example.test', ${peer}, ${admin})`;
    const state = async () =>
      (
        await su<{ h: string }[]>`
        select md5(concat_ws('#',
          (select disabled_at::text || session_epoch::text from auth.users where id = ${member}),
          (select revoked_at::text from mobile_tokens where id = ${device}),
          (select revoked_at::text from member_invites where id = ${invite}),
          (select coalesce(acts_as_login_id::text, '-') || coalesce(ended_acts_as_login_id::text, '-')
             from mantle_peers where id = ${peer}))) as h`
      )[0]!.h;
    const before = await state();
    for (const s of [
      `update auth.users set disabled_at = null where id = '${member}'`,
      `update auth.users set session_epoch = session_epoch - 1 where id = '${member}'`,
      `update mobile_tokens set revoked_at = null where id = '${device}'`,
      `update member_invites set revoked_at = null where id = '${invite}'`,
      `update mantle_peers set acts_as_login_id = '${member}' where id = '${peer}'`,
      `update mantle_peers set ended_acts_as_login_id = '${member}' where id = '${peer}'`,
    ]) {
      expect(await run(nl, [s]), s).toBe('42501');
    }
    expect(await state()).toBe(before);
    // The directions narrow work takes, each allowed.
    for (const s of [
      `update auth.users set disabled_at = now() where id = '${member}'`,
      `update auth.users set session_epoch = session_epoch + 1 where id = '${member}'`,
      `update mobile_tokens set revoked_at = now() where id = '${device}'`,
      `update mantle_peers set ended_acts_as_login_id = acts_as_login_id, acts_as_login_id = null where id = '${peer}'`,
    ]) {
      expect(await run(nl, [s]), s).toBe('ok');
    }
    // The system pool (here the superuser) is not held by the rules.
    expect(
      await run(su, [
        `update auth.users set disabled_at = null, session_epoch = 0 where id = '${member}'`,
        `update mobile_tokens set revoked_at = null where id = '${device}'`,
        `update mantle_peers set acts_as_login_id = '${member}' where id = '${peer}'`,
      ]),
    ).toBe('ok');
    const [t] = await su<{ n: number }[]>`
      select count(*)::int as n from pg_trigger where tgname = 'mantle_narrow_one_way_trg'`;
    expect(t!.n).toBe(9);
    await su`update auth.users set disabled_at = null where id = ${member}`;
  });

  it('agents and tool_groups (rounds 6, 7): no insert, no grant column, no delegate, an assignment only released; the other columns allowed', async () => {
    const agent = randomUUID();
    const group = randomUUID();
    const gslug = `g-${group.slice(0, 8)}`;
    await su`insert into tool_groups (id, owner_id, slug, name, tool_slugs)
             values (${group}, ${brain}, ${gslug}, 'g', '{search}')`;
    await su`insert into agents (id, owner_id, slug, name, role, model, system_prompt, tool_group_slugs, assigned_user_id, memory_config)
             values (${agent}, ${brain}, ${`a-${agent.slice(0, 8)}`}, 'a', 'responder', 'm', 'p', ${[gslug]}, ${admin},
                     ${su.json({ delegate_to: ['pages'], max_iterations: 3 })})`;
    const state = async () =>
      (
        await su<{ h: string }[]>`
        select md5(concat_ws('#',
          (select a::text from agents a where id = ${agent}),
          (select g::text from tool_groups g where id = ${group}),
          (select count(*)::text from agents where owner_id = ${brain}),
          (select count(*)::text from tool_groups where owner_id = ${brain}))) as h`
      )[0]!.h;
    const before = await state();
    const refused = [
      `insert into agents (owner_id, slug, name, role, model, system_prompt)
         values ('${brain}', 'x-${agent.slice(0, 6)}', 'x', 'responder', 'm', 'p')`,
      `update agents set tool_group_slugs = '{admin-tools}' where id = '${agent}'`,
      `update agents set role = 'worker' where id = '${agent}'`,
      `update agents set workspace_id = '${adminWs}' where id = '${agent}'`,
      `update agents set slug = 'other' where id = '${agent}'`,
      `update agents set owner_id = '${member}' where id = '${agent}'`,
      `update agents set id = '${randomUUID()}' where id = '${agent}'`,
      `update agents set assigned_user_id = '${member}' where id = '${agent}'`,
      `delete from agents where id = '${agent}'`,
      // Round 7: a delegate runs with its own tool groups, so delegate_to is
      // a grant: added, replaced, dropped with the key or the column, each
      // refused (0318 keep:memory_config:delegate_to).
      `update agents set memory_config = memory_config || '{"delegate_to":["pages","toolsmith"]}' where id = '${agent}'`,
      `update agents set memory_config = jsonb_set(memory_config, '{delegate_to}', '["toolsmith"]') where id = '${agent}'`,
      `update agents set memory_config = memory_config - 'delegate_to' where id = '${agent}'`,
      `update agents set memory_config = '{}' where id = '${agent}'`,
      `update agents set memory_config = null where id = '${agent}'`,
      `insert into tool_groups (owner_id, slug, name) values ('${brain}', 'x-${group.slice(0, 6)}', 'x')`,
      `update tool_groups set tool_slugs = '{search,sandbox_exec}' where id = '${group}'`,
      `update tool_groups set slug = 'admin-tools' where id = '${group}'`,
      `update tool_groups set admin_only = true where id = '${group}'`,
      `update tool_groups set owner_id = '${member}' where id = '${group}'`,
      `delete from tool_groups where id = '${group}'`,
    ];
    for (const s of refused) expect(await run(nl, [s]), s).toBe('42501');
    expect(await state()).toBe(before);
    // What narrow work writes (the round 4 and 5 measurements, and the
    // assistants, connectors and settings areas' edits), each allowed.
    for (const s of [
      `update agents set name = 'b', description = 'd', model = 'm2', system_prompt = 'q',
         skill_slugs = '{}', memory_config = memory_config || '{"max_iterations":5}', params = '{}', thinking_effort = 'low',
         persona_notes = '[]', avatar = null, priority = 5, enabled = false, api_key_id = null,
         tts_worker_id = null, configured_by = null, updated_at = now() where id = '${agent}'`,
      `update agents set last_used_at = now(), usage_count = usage_count + 1 where id = '${agent}'`,
      `update agents set assigned_user_id = null, assigned_at = null where id = '${agent}'`,
      `update tool_groups set name = 'h', description = 'e', integration = null, enabled = false,
         configured_by = null, updated_at = now() where id = '${group}'`,
    ]) {
      expect(await run(nl, [s]), s).toBe('ok');
    }
    for (const t of ['agents', 'tool_groups']) {
      const [g] = await su<{ i: boolean; d: boolean }[]>`
        select (has_table_privilege(${rr.NARROW_ROLE}, ${`public.${t}`}, 'INSERT')
            or has_any_column_privilege(${rr.NARROW_ROLE}, ${`public.${t}`}, 'INSERT')) as i,
               has_table_privilege(${rr.NARROW_ROLE}, ${`public.${t}`}, 'DELETE') as d`;
      expect(g, t).toEqual({ i: false, d: false });
    }
    for (const [t, c] of [
      ['agents', 'tool_group_slugs'],
      ['agents', 'role'],
      ['agents', 'workspace_id'],
      ['agents', 'slug'],
      ['agents', 'owner_id'],
      ['tool_groups', 'tool_slugs'],
      ['tool_groups', 'slug'],
      ['tool_groups', 'admin_only'],
      ['tool_groups', 'owner_id'],
    ] as const) {
      const [g] = await su<{ u: boolean }[]>`
        select has_column_privilege(${rr.NARROW_ROLE}, ${`public.${t}`}, ${c}, 'UPDATE') as u`;
      expect(g!.u, `${t}.${c}`).toBe(false);
    }
    // Another key of memory_config moves on the narrow login, delegate_to
    // kept (read in the same transaction: run rolls back; a wrong value
    // divides by zero).
    expect(
      await run(nl, [
        `update agents set memory_config = memory_config || '{"max_iterations":5}' where id = '${agent}'`,
        `select case when memory_config = '{"delegate_to":["pages"],"max_iterations":5}'::jsonb
                then 1 else 1 / 0 end from agents where id = '${agent}'`,
      ]),
    ).toBe('ok');
    // The system pool (here the superuser) is not held by the one-way rule.
    expect(
      await run(su, [`update agents set assigned_user_id = '${member}' where id = '${agent}'`]),
    ).toBe('ok');
    expect(
      await run(su, [
        `update agents set memory_config = memory_config || '{"delegate_to":["toolsmith"]}' where id = '${agent}'`,
      ]),
    ).toBe('ok');
    await su`delete from agents where id = ${agent}`;
    await su`delete from tool_groups where id = ${group}`;
  });

  it("the audit's chain: a member raised, bridged into Admin, then a structure item as it: refused at each step", async () => {
    const before = await rights();
    // A raw narrow session may name any acting login: a mistake guard only.
    expect(await run(nl, [acting(admin)])).toBe('ok');
    expect(
      await run(nl, [acting(admin), `update auth.users set role = 'admin' where id = '${member}'`]),
    ).toBe('42501');
    expect(await run(nl, [acting(admin), `select mantle_bridge_login('${member}'::uuid)`])).toBe(
      '42501',
    );
    const item = `select * from mantle_structure_item('secrets-root', 'insert', '${member}'::uuid,
                    '${brain}'::uuid, null, '{"title": "S", "path": "secrets"}'::jsonb)`;
    expect(await run(nl, [acting(member), item])).toBe('42501');
    expect(await rights()).toBe(before);
    const [g] = await su<{ b: boolean }[]>`
      select has_function_privilege('mantle_system_narrow', 'public.mantle_bridge_login(uuid)', 'EXECUTE') as b`;
    expect(g!.b).toBe(false);
  });

  it('every definer that takes a login with no scope writes nothing for another login on the narrow login', async () => {
    const fns = [
      'mantle_tg_chat_set',
      'mantle_access_key_revoke',
      'mantle_tg_my_chats',
      'mantle_tg_moderated_chats',
      'mantle_read_cursors',
      'mantle_login_connector_rows',
      'mantle_turn_heartbeats',
      'mantle_ws_seen',
      'mantle_access_keys_seen',
      'mantle_snapshot_bytes',
      'mantle_area_rule',
      'mantle_login_area',
      'mantle_login_areas',
      'mantle_login_is_admin',
      'mantle_login_is_admin_user',
      'mantle_ws_private_for',
      'mantle_ws_private_workspace',
      'mantle_personal_space',
      'mantle_tg_login_moderates',
      'mantle_ws_remove_user',
      'mantle_bridge_login',
      'mantle_structure_item',
      'mantle_space_settle_promotion',
      'mantle_agent_delete',
    ];
    const sigs = await su<{ name: string; args: string; names: string[] | null }[]>`
      select p.proname::text as name, pg_get_function_identity_arguments(p.oid) as args,
             p.proargnames::text[] as names
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = any(${fns})`;
    expect(fns.filter((f) => !sigs.some((s) => s.name === f))).toEqual([]);
    const WRITES = `select coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0)::int as n
                      from pg_stat_xact_all_tables where schemaname in ('public', 'auth')`;
    const before = await rights();
    const answers: string[] = [];
    // The member as the login argument, the admin named as the acting login
    // (what a raw narrow session can do), and the member as both.
    for (const [login, act] of [
      [member, admin],
      [member, member],
    ] as const) {
      for (const s of sigs) {
        const types = s.args ? s.args.split(',').map((a) => a.trim().split(/\s+/).pop()!) : [];
        const args = types.map((t, i) => {
          const n = s.names?.[i] ?? '';
          if (t === 'uuid') {
            if (/^(owner|brain)/.test(n)) return `'${brain}'::uuid`;
            if (/^(login|who|target)/.test(n)) return `'${login}'::uuid`;
            return `'${randomUUID()}'::uuid`;
          }
          if (t === 'text')
            return n === 'kind'
              ? `'secrets-root'`
              : n === 'op'
                ? `'insert'`
                : n === 'action'
                  ? `'unpair'`
                  : `'users'`;
          if (t === 'jsonb') return `'{"title": "S", "path": "secrets"}'::jsonb`;
          if (t === 'boolean') return 'true';
          if (/^(integer|bigint|smallint)$/.test(t)) return `0::${t}`;
          return `null::${t}`;
        });
        const answer = await nl
          .begin(async (t) => {
            await t.unsafe(acting(act));
            const [b] = await t.unsafe<{ n: number }[]>(WRITES);
            await t.unsafe(`select * from public.${s.name}(${args.join(', ')})`);
            const [a] = await t.unsafe<{ n: number }[]>(WRITES);
            throw Object.assign(new Error('rollback'), { writes: a!.n - b!.n });
          })
          .then(
            () => 'ran',
            (e: { writes?: number; code?: string }) =>
              e.writes !== undefined ? `ran, ${e.writes} rows written` : `refused ${e.code}`,
          );
        answers.push(
          `${s.name} login=${login === admin ? 'admin' : 'member'} acting=${act === admin ? 'admin' : 'member'}: ${answer}`,
        );
        expect(answer, `${s.name} ${login} ${act}`).toMatch(/^(ran, 0 rows written|refused \w+)$/);
      }
    }
    if (process.env.MANTLE_ACTING_REPORT) process.stdout.write(`${answers.join('\n')}\n`);
    expect(await rights()).toBe(before);
  });

  it("the writers' own runs write: a real chat unpaired on the narrow login, a real key revoked, a pinned chat denied by an assistant's delete", async () => {
    // Setup rows only: their foreign keys (the bot's account) are not what
    // is measured.
    const chat = randomUUID();
    const pinned = randomUUID();
    const agent = randomUUID();
    const keyId = randomUUID();
    await su.begin(async (t) => {
      await t`set local session_replication_role = replica`;
      await t`insert into agents (id, owner_id, slug, name, model, system_prompt)
              values (${agent}, ${brain}, ${`ag-${agent.slice(0, 8)}`}, 'a', 'test/model', 'p')`;
      const acct = randomUUID();
      await t`insert into telegram_accounts (id, user_id, bot_username, branch_path)
              values (${acct}, ${brain}, ${`bot_${acct.slice(0, 8)}`}, 'telegram')`;
      await t`insert into telegram_chats (id, account_id, user_id, telegram_chat_id, chat_type,
                                          login_id, allowlist_status)
              values (${chat}, ${acct}, ${brain}, ${`c-${chat}`}, 'private', ${admin}, 'allowed'),
                     (${pinned}, ${acct}, ${brain}, ${`c-${pinned}`}, 'private', null, 'allowed')`;
      await t`update telegram_chats set responder_agent_id = ${agent} where id = ${pinned}`;
      await t`insert into access_keys (id, name, login_id, key_prefix, key_hash, access)
              values (${keyId}, 'k', ${admin}, 'abcd1234', ${'a'.repeat(64)}, 'read')`;
    });
    await nl.begin(async (t) => {
      await t.unsafe(acting(admin));
      const rows = await t`select * from mantle_tg_chat_set(${brain}::uuid, ${admin}::uuid,
                             ${chat}::uuid, 'unpair', null)`;
      expect(rows.length).toBe(1);
    });
    const [c] = await su<{ s: string; l: string | null }[]>`
      select allowlist_status::text as s, login_id::text as l from telegram_chats where id = ${chat}`;
    expect(c).toEqual({ s: 'pending', l: null });
    // The key revoke: the system session (the narrow role may not run it).
    await su.begin(async (t) => {
      await t.unsafe(acting(admin));
      const rows = await t`select * from mantle_access_key_revoke(${keyId}::uuid, ${admin}::uuid)`;
      expect(rows.length).toBe(1);
    });
    const [k] = await su<
      { r: boolean }[]
    >`select revoked_at is not null as r from access_keys where id = ${keyId}`;
    expect(k!.r).toBe(true);
    await nl.begin(async (t) => {
      await t.unsafe(acting(admin));
      const [r] = await t`select found from mantle_agent_delete(${admin}::uuid, ${brain}::uuid,
                            ${agent}::uuid, false)`;
      expect(r!.found).toBe(true);
    });
    const [p] = await su<
      { s: string }[]
    >`select allowlist_status::text as s from telegram_chats where id = ${pinned}`;
    expect(p!.s).toBe('denied');
  });

  it("the session check also takes the definers' owner (a non-superuser owner brain), never the write role", async () => {
    const owner = `s7b_owner_${randomUUID().slice(0, 8)}`;
    const fn = `public.s7b_session_probe_${owner.slice(-8)}`;
    try {
      await su.unsafe(`create role ${owner} nologin nosuperuser`);
      await su.unsafe(`create function ${fn}() returns boolean language sql security definer
                         set search_path = public, pg_temp as $$ select public.mantle_system_session() $$`);
      await su.unsafe(`alter function ${fn}() owner to ${owner}`);
      await su.unsafe(
        `grant execute on function ${fn}() to ${owner}, mantle_write_user, mantle_system_narrow`,
      );
      const asWho = async (who: string) =>
        su.begin(async (t) => {
          await t.unsafe(`set local session authorization ${who}`);
          const [r] = await t.unsafe<{ ok: boolean; s: string }[]>(
            `select ${fn}() as ok, session_user::text as s`,
          );
          return r!;
        });
      expect(await asWho(owner)).toEqual({ ok: true, s: owner });
      expect(await asWho('mantle_write_user')).toEqual({ ok: false, s: 'mantle_write_user' });
      expect(await asWho('mantle_system_narrow')).toEqual({ ok: true, s: 'mantle_system_narrow' });
    } finally {
      await su.unsafe(`drop function if exists ${fn}()`);
      await su.unsafe(`drop role if exists ${owner}`);
    }
  });

  /** `fn` in the Admin area's request exit of `login`: the narrow route. */
  const exit = <T>(fn: () => Promise<T>, login = admin) =>
    m.runInRequestSlot(async () => {
      m.setRequestActor(m.loginActor(login, 'rw'));
      m.noteRequestSystem('area');
      return fn();
    });
  const exitFull = <T>(fn: () => Promise<T>) => exit(() => v.onFullSystemRoute('profile-row', fn));
  const secret = async () => {
    const id = randomUUID();
    await su`insert into nodes (id, owner_id, type, title, path, data)
             values (${id}, ${brain}, 'secret', 's', 'secrets', '{"description": "d"}'::jsonb)`;
    return id;
  };

  it('an update that names no data is refused (22023), the row unchanged', async () => {
    const id = await secret();
    for (const fields of [`'{"title": "x"}'::jsonb`, 'null::jsonb', `'{"data": "s"}'::jsonb`]) {
      const call = `select * from mantle_structure_item('secret-item', 'update', '${admin}'::uuid,
                      '${brain}'::uuid, array['${id}'::uuid], ${fields})`;
      expect(await run(nl, [acting(admin), call]), fields).toBe('22023');
    }
    const [r] = await su<
      { d: unknown; t: string }[]
    >`select data as d, title as t from nodes where id = ${id}`;
    expect(r).toEqual({ d: { description: 'd' }, t: 's' });
  });

  it("a delete's match is read again under the heads: an event moved to another account, a doc to another collection, left on both routes", async () => {
    for (const [route, name] of [
      [exit, 'narrow'],
      [exitFull, 'full'],
    ] as const) {
      const acct = randomUUID();
      const [e1, e2] = [randomUUID(), randomUUID()];
      await su`insert into nodes (id, owner_id, type, title, path, data) values
        (${e1}, ${brain}, 'event', 'e1', 'events', ${su.json({ external_account_id: acct })}),
        (${e2}, ${brain}, 'event', 'e2', 'events', ${su.json({ external_account_id: acct })})`;
      // Read, then the race: e2 moves to another account before the delete.
      await su`update nodes set data = ${su.json({ external_account_id: randomUUID() })} where id = ${e2}`;
      expect(
        await route(() =>
          m.deleteStructureItems('calendar-event', brain, [e1, e2], { external_account_id: acct }),
        ),
        name,
      ).toEqual([e1]);
      const [d1, d2] = [randomUUID(), randomUUID()];
      await su`insert into nodes (id, owner_id, type, title, path, data) values
        (${d1}, ${brain}, 'documentation', 'd1', 'documentation', ${su.json({ collection: 'k' })}),
        (${d2}, ${brain}, 'documentation', 'd2', 'documentation', ${su.json({ collection: 'other' })})`;
      expect(
        await route(() =>
          m.deleteStructureItems('docs-item', brain, [d1, d2], { collection: 'k' }),
        ),
        name,
      ).toEqual([d1]);
      expect((await su`select 1 from nodes where id in (${e2}, ${d2})`).length, name).toBe(2);
    }
  });

  /** The session and acting login a structure write's own transaction saw. */
  const sawOf = async () => {
    let saw: Record<string, string | null> = {};
    const row = await m.insertStructureItem(
      'secret-item',
      { ownerId: brain, title: 't', path: 'secrets' },
      async (tx) => {
        const [r] = (await tx.execute(
          sql`select session_user::text as s,
                     nullif(current_setting('mantle.acting_login', true), '') as a`,
        )) as unknown as { s: string; a: string | null }[];
        saw = { s: r!.s, a: r!.a };
      },
    );
    expect(row).not.toBeNull();
    return saw;
  };
  const turn = <T>(
    loginId: string | null,
    actor: ReturnType<typeof m.loginActor>,
    fn: () => Promise<T>,
  ) =>
    m.withTurnScope({ kind: 'assistant', loginId, ws: [adminWs], modWs: [adminWs] }, () =>
      Promise.resolve(m.runAsActor(actor, () => m.asSystem(fn, 'admin-area'))),
    );

  it("a turn whose actor is no login (actor check off: a Telegram turn) takes the turn's login; on too; no login at all runs at the spot", async () => {
    // Off: the turn's actor is system(workflow:telegram-turn).
    const off = await turn(admin, m.systemActor('workflow:telegram-turn'), sawOf);
    expect(off).toEqual({ s: rr.NARROW_ROLE, a: admin });
    // On: the turn's actor is the login.
    const on = await turn(admin, m.loginActor(admin, 'rw'), sawOf);
    expect(on).toEqual({ s: rr.NARROW_ROLE, a: admin });
    // No login (a heartbeat's turn that answers none): the app's own
    // statements at the spot structure-no-login, on the system pool's login.
    const none = await turn(null, m.systemActor('heartbeat'), async () => {
      expect(pools.narrowRouteNow()).toBe(true);
      return sawOf();
    });
    expect(none.s).not.toBe(rr.NARROW_ROLE);
    expect(none.a).toBeNull();
  });

  it('a structure write inside an open system transaction of a narrow exit (a savepoint) sends the acting login', async () => {
    const saw = await exit(() => m.withSystemTx(() => sawOf()));
    expect(saw).toEqual({ s: rr.NARROW_ROLE, a: admin });
  });

  it("an edit through the definer drops a set vector and announces node_ingested, as the app's edit does", async () => {
    const heard: string[] = [];
    const listener = postgres(scratch.url, { max: 1, onnotice: () => {} });
    try {
      await listener.listen('node_ingested', (id) => heard.push(id));
      const [dim] = await su<{ d: number }[]>`
        select atttypmod as d from pg_attribute where attrelid = 'public.nodes'::regclass and attname = 'embedding'`;
      const ids = [await secret(), await secret()];
      for (const id of ids) {
        await su.unsafe(
          `update nodes set embedding = array_fill(0.01::real, array[${dim!.d}])::vector where id = '${id}'`,
        );
      }
      const set = { title: 'k2', data: { description: 'new' } };
      await exit(() => m.updateStructureItem('secret-item', brain, ids[0]!, set, ['description']));
      await exitFull(() =>
        m.updateStructureItem('secret-item', brain, ids[1]!, set, ['description']),
      );
      for (let i = 0; i < 50 && ids.some((id) => !heard.includes(id)); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      for (const id of ids) {
        const [r] = await su<{ e: boolean }[]>`
          select embedding is null as e from nodes where id = ${id}`;
        expect(r!.e, id).toBe(true);
      }
      // The announcement: sent on both routes, the same number of times.
      const count = (id: string) => heard.filter((h) => h === id).length;
      expect(count(ids[0]!)).toBeGreaterThan(0);
      expect(count(ids[0]!)).toBe(count(ids[1]!));
    } finally {
      await listener.end();
    }
  });
});
