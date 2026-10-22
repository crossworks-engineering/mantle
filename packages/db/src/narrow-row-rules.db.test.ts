/**
 * The re-audit's forges (the full re-audit at 0e81fec1d),
 * each as the REAL narrow login (its derived password; session_user is
 * mantle_system_narrow): refused with 42501 and no row changed, while the
 * product's own narrow writes on the same rows still run. The same forms
 * are the workstation's forge proof (on the workstation).
 */
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedScratchDatabase, ensureTestAnchor } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const FIXTURES = [
  `insert into auth.users (id, email, password_hash, role) values
  ('a0000000-0000-4000-8000-000000000001', 'admin2@example.invalid', 'x', 'admin'),
  ('a0000000-0000-4000-8000-000000000002', 'member@example.invalid', 'x', 'member'),
  ('a0000000-0000-4000-8000-000000000003', 'outsider@example.invalid', 'x', 'member')`,
  `insert into workspaces (id, owner_id, name) values ('b0000000-0000-4000-8000-000000000001', @BRAIN@, 'Forge ws')`,
  `insert into workspace_users (workspace_id, login_id, moderator) values
  ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002', false)`,
  `insert into agents (id, owner_id, slug, name, provider, model, enabled, system_prompt)
  values ('c0000000-0000-4000-8000-000000000001', @BRAIN@, 'forge-agent', 'Forge', 'openrouter', 'x/y', false, 'p')`,
  `insert into heartbeats (id, owner_id, slug, name, agent_slug, skill_slug, schedule, schedule_kind, surface, status, fire_count, max_fires, last_fired_at, next_fire_at)
  values ('d0000000-0000-4000-8000-000000000001', @BRAIN@, 'hb-done', 'done', 'forge-agent', 'x', '{"every_minutes":60}', 'interval', '{}', 'completed', 1, 1, now() - interval '1 hour', null),
         ('d0000000-0000-4000-8000-000000000002', @BRAIN@, 'hb-live', 'live', 'forge-agent', 'x', '{"every_minutes":60}', 'interval', '{}', 'active', 3, null, now() - interval '1 hour', now() + interval '1 hour')`,
  `insert into email_accounts (id, user_id, provider, address, branch_path)
  values ('e0000000-0000-4000-8000-000000000001', @BRAIN@, 'imap', 'mail@example.invalid', 'inbox.forge')`,
  `insert into tool_groups (id, owner_id, slug, name, enabled)
  values ('f0000000-0000-4000-8000-000000000001', @BRAIN@, 'forge-group', 'Forge group', false)`,
  `insert into channels (id, owner_id, agent_id, type, display_name, enabled, credentials_enc)
  values ('f1000000-0000-4000-8000-000000000001', @BRAIN@, 'c0000000-0000-4000-8000-000000000001', 'telegram', '@forge', false, decode('00', 'hex'))`,
  `insert into telegram_accounts (id, user_id, bot_username, branch_path, enabled)
  values ('f2000000-0000-4000-8000-000000000001', @BRAIN@, 'forgebot', 'inbox.telegram_forgebot', false)`,
];

const REFUSED: readonly [string, string][] = [
  ['1: delete the brain owner', `delete from auth.users where is_owner`],
  [
    '1: delete an Admin user',
    `delete from auth.users where id = 'a0000000-0000-4000-8000-000000000001'`,
  ],
  [
    '1: delete a member login',
    `delete from auth.users where id = 'a0000000-0000-4000-8000-000000000002'`,
  ],
  [
    '2: moderator via ws-clear-ticks actor',
    `select set_config('mantle.actor', 'system:ws-clear-ticks', true), mantle_ws_set_moderator(mantle_brain_id(), 'b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002', true, null)`,
  ],
  [
    '3: heartbeat re-armed (completed to active)',
    `update heartbeats set status = 'active', fire_count = 0, last_fired_at = null, next_fire_at = now() - interval '1 minute' where id = 'd0000000-0000-4000-8000-000000000001'`,
  ],
  [
    '3: heartbeat status completed to active',
    `update heartbeats set status = 'active' where id = 'd0000000-0000-4000-8000-000000000001'`,
  ],
  [
    '3: heartbeat fire_count lowered',
    `update heartbeats set fire_count = 0 where id = 'd0000000-0000-4000-8000-000000000001'`,
  ],
  [
    '3: heartbeat last_fired_at cleared',
    `update heartbeats set last_fired_at = null where id = 'd0000000-0000-4000-8000-000000000001'`,
  ],
  [
    '3: heartbeat next_fire_at set from NULL',
    `update heartbeats set next_fire_at = now() where id = 'd0000000-0000-4000-8000-000000000001'`,
  ],
  [
    '3: active heartbeat next_fire_at earlier',
    `update heartbeats set next_fire_at = now() - interval '1 day' where id = 'd0000000-0000-4000-8000-000000000002'`,
  ],
  [
    '3: heartbeat state (prompt input)',
    `update heartbeats set state = '{"x":1}' where id = 'd0000000-0000-4000-8000-000000000002'`,
  ],
  [
    '4: mail ms_account_id rebind',
    `update email_accounts set ms_account_id = null where id = 'e0000000-0000-4000-8000-000000000001'`,
  ],
  [
    '4: mail provider',
    `update email_accounts set provider = 'microsoft' where id = 'e0000000-0000-4000-8000-000000000001'`,
  ],
  [
    '4: mail account forged (branch_path)',
    `insert into email_accounts (user_id, provider, address, branch_path) values (mantle_brain_id(), 'microsoft', 'forged@example.invalid', 'inbox.forged')`,
  ],
  [
    '5: agent system_prompt',
    `update agents set system_prompt = 'forged' where id = 'c0000000-0000-4000-8000-000000000001'`,
  ],
  [
    '5: agent persona_notes',
    `update agents set persona_notes = '[]' where id = 'c0000000-0000-4000-8000-000000000001'`,
  ],
  [
    '5: agent skill_slugs',
    `update agents set skill_slugs = '{x}' where id = 'c0000000-0000-4000-8000-000000000001'`,
  ],
  ['5: AI worker system_prompt', `update ai_workers set system_prompt = 'forged' where true`],
  [
    '5: message for a login outside its workspace',
    `insert into assistant_messages (owner_id, direction, text, login_id, workspace_id) values (mantle_brain_id(), 'inbound', 'x', 'a0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000001')`,
  ],
  [
    '5: message for another brain',
    `insert into assistant_messages (owner_id, direction, text) values (gen_random_uuid(), 'inbound', 'x')`,
  ],
  [
    '5: message with a bad direction',
    `insert into assistant_messages (owner_id, direction, text) values (mantle_brain_id(), 'sideways', 'x')`,
  ],
  [
    '6: api key made (reinsert)',
    `insert into api_keys (id, user_id, service, label, key_enc, key_version, masked) values (gen_random_uuid(), mantle_brain_id(), 'openai', 'forged', 'x', 1, 'x')`,
  ],
  [
    '6: sandbox made',
    `insert into sandboxes (owner_id, name, created_by) values (mantle_brain_id(), 'forged', null)`,
  ],
  [
    '7: tool group enabled',
    `update tool_groups set enabled = true where id = 'f0000000-0000-4000-8000-000000000001'`,
  ],
  [
    '7: assistant enabled',
    `update agents set enabled = true where id = 'c0000000-0000-4000-8000-000000000001'`,
  ],
  [
    '7: channel enabled',
    `update channels set enabled = true where id = 'f1000000-0000-4000-8000-000000000001'`,
  ],
  [
    '7: telegram account enabled',
    `update telegram_accounts set enabled = true where id = 'f2000000-0000-4000-8000-000000000001'`,
  ],
];

const ALLOWED: readonly [string, string][] = [
  [
    'ok: heartbeat fire books forward',
    `update heartbeats set fire_count = fire_count + 1, last_fired_at = now(), next_fire_at = next_fire_at + interval '1 hour', updated_at = now() where id = 'd0000000-0000-4000-8000-000000000002'`,
  ],
  [
    'ok: heartbeat completed (next to NULL)',
    `update heartbeats set status = 'completed', next_fire_at = null, completion_reason = 'x' where id = 'd0000000-0000-4000-8000-000000000002'`,
  ],
  [
    'ok: tool group switched off',
    `update tool_groups set enabled = false where id = 'f0000000-0000-4000-8000-000000000001'`,
  ],
  [
    'ok: assistant switched off, renamed',
    `update agents set enabled = false, name = 'renamed' where id = 'c0000000-0000-4000-8000-000000000001'`,
  ],
  [
    'ok: mail folders and name',
    `update email_accounts set display_name = 'x', imap_included_folders = '{INBOX}' where id = 'e0000000-0000-4000-8000-000000000001'`,
  ],
  [
    'ok: a login disabled',
    `update auth.users set disabled_at = now() where id = 'a0000000-0000-4000-8000-000000000002'`,
  ],
  ['ok: trace status', `update traces set status = status where false`],
];

describe.skipIf(!URL)('round 12: the narrow login`s row rules (0320) and the moved writes', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let su: ReturnType<typeof postgres>;
  let nl: ReturnType<typeof postgres>;
  const KEY = () => process.env.MANTLE_MASTER_KEY ?? 'mantle-viewer-test-key';

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    su = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    const brain = await ensureTestAnchor(su);
    for (const f of FIXTURES) await su.unsafe(f.replaceAll('@BRAIN@', `'${brain}'`));
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    const rr = await import('./runtime-role');
    nl = postgres(
      rr.runtimeDatabaseUrl(scratch.url, rr.narrowRolePassword(KEY()), rr.NARROW_ROLE),
      { max: 1, prepare: false, onnotice: () => {} },
    );
  }, 180_000);

  afterAll(async () => {
    for (const c of [nl, su]) await c?.end();
    await scratch?.drop();
  });

  /** One statement as an admin-area narrow exit, rolled back: 'ok' or the
   *  error's code. */
  const run = (stmt: string) =>
    nl
      .begin(async (t) => {
        await t.unsafe(`select set_config('mantle.actor', 'system:http:admin-area', true)`);
        await t.unsafe(stmt);
        throw Object.assign(new Error('rollback'), { ok: true });
      })
      .then(
        () => 'ok',
        (e: { ok?: boolean; code?: string }) => (e.ok ? 'ok' : (e.code ?? 'error')),
      );

  it('the session is the narrow login itself', async () => {
    const [r] = await nl`select session_user::text as s, current_user::text as c`;
    expect(r).toEqual({ s: 'mantle_system_narrow', c: 'mantle_system_narrow' });
  });

  it('every forge of the re-audit is refused (42501)', async () => {
    const bad: string[] = [];
    for (const [label, stmt] of REFUSED) {
      const got = await run(stmt);
      if (got !== '42501') bad.push(`${label}: ${got}`);
    }
    expect(bad).toEqual([]);
  });

  it('the product`s own narrow writes on the same rows still run', async () => {
    const bad: string[] = [];
    for (const [label, stmt] of ALLOWED) {
      const got = await run(stmt);
      if (got !== 'ok') bad.push(`${label}: ${got}`);
    }
    expect(bad).toEqual([]);
  });

  it('system work trusts no self-set actor: the write role (SET on the superuser) is refused too', async () => {
    const got = await su
      .begin(async (t) => {
        await t.unsafe(`set local role mantle_write_user`);
        await t.unsafe(`select set_config('mantle.actor', 'system:ws-clear-ticks', true)`);
        await t.unsafe(
          `select mantle_ws_set_moderator(mantle_brain_id(), 'b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002', true, null)`,
        );
        throw Object.assign(new Error('rollback'), { ok: true });
      })
      .then(
        () => 'ok',
        (e: { ok?: boolean; code?: string }) => (e.ok ? 'ok' : (e.code ?? 'error')),
      );
    expect(got).toBe('42501');
    const [r] = await su`select moderator from workspace_users
                          where workspace_id = 'b0000000-0000-4000-8000-000000000001'
                            and login_id = 'a0000000-0000-4000-8000-000000000002'`;
    expect(r?.moderator).toBe(false);
  });

  it('migrate takes a hand grant to PUBLIC back, on a table and on a definer (DB LOW-5)', async () => {
    const [fn] = await su`select p.oid::regprocedure::text as f from pg_proc p
                           where p.proname = 'mantle_ws_add_user' limit 1`;
    await su.unsafe(`grant select, insert on public.workspace_users to public`);
    await su.unsafe(`grant execute on function ${fn!.f} to public`);
    const rr = await import('./runtime-role');
    await rr.applyRuntimeGrants(su);
    const [r] =
      await su.unsafe(`select has_table_privilege('public', 'public.workspace_users', 'SELECT') as t,
                                        has_function_privilege('public', '${fn!.f}', 'EXECUTE') as f,
                                        has_function_privilege('public', 'public.mantle_actor_check_mode()', 'EXECUTE') as keep`);
    expect(r).toEqual({ t: false, f: false, keep: true });
  });

  it('the owner and the Admin user are still there, the heartbeat still completed', async () => {
    const [r] = await su`select (select count(*)::int from auth.users where is_owner) as owners,
                               (select status::text from heartbeats where id = 'd0000000-0000-4000-8000-000000000001') as hb`;
    expect(r).toEqual({ owners: 1, hb: 'completed' });
  });
});
