/**
 * Round 13b's forges (the re-audits at e108f0f78, items B to E), each as the
 * REAL narrow login (its derived password; session_user is
 * mantle_system_narrow): refused with 42501 and no row changed, while the
 * product's own narrow writes on the same rows still run. The same forms
 * are the workstation's forge proof (forge13b.sql).
 *
 *  - B (0322): the message rows. An insert names its assistant, that
 *    assistant's workspace and a login that may talk there (the Admin
 *    workspace: the owner or an Admin user only); a settled row is never
 *    rewritten, by UPDATE, ON CONFLICT or MERGE (COPY: the forge proof's
 *    psql, forge13b.sql); off the narrow
 *    route the same break by a narrow reason is counted and runs.
 *  - C: the limit and prompt JSON columns (an assistant's memory_config and
 *    params, an AI worker's params) are off the narrow list.
 *  - D (0323): every enabled, is_default and backup_enabled column the
 *    narrow role may update is off-only, read from the catalog: a new one
 *    fails here.
 *  - F: the prompt-reaching text the narrow login held (a tool group's and
 *    an assistant's description, a login's display name) is off its list.
 *  - E: migrate takes CREATE on every schema and every app sequence right
 *    back from PUBLIC.
 */
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedScratchDatabase, ensureTestAnchor } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const ADMIN = 'a0000000-0000-4000-8000-000000000001';
const MEMBER = 'a0000000-0000-4000-8000-000000000002';
const OUTSIDER = 'a0000000-0000-4000-8000-000000000003';
const WS = 'b0000000-0000-4000-8000-000000000001';
const ADMIN_WS = 'b0000000-0000-4000-8000-000000000002';
/** An assistant of the Admin workspace (workspace_id NULL). */
const AGENT_ADMIN = 'c0000000-0000-4000-8000-000000000001';
/** An assistant of the member's workspace. */
const AGENT_WS = 'c0000000-0000-4000-8000-000000000002';
const PENDING = '10000000-0000-4000-8000-000000000001';
const WORKER = '20000000-0000-4000-8000-000000000001';
const FEED = '20000000-0000-4000-8000-000000000002';
const DOCS = '20000000-0000-4000-8000-000000000003';
const SETTLED = '10000000-0000-4000-8000-000000000002';

const FIXTURES = [
  `insert into auth.users (id, email, password_hash, role) values
  ('${ADMIN}', 'admin2@example.invalid', 'x', 'admin'),
  ('${MEMBER}', 'member@example.invalid', 'x', 'member'),
  ('${OUTSIDER}', 'outsider@example.invalid', 'x', 'member')`,
  `insert into workspaces (id, owner_id, name) values ('${WS}', @BRAIN@, 'Forge ws')`,
  `insert into workspaces (id, owner_id, name, is_admin, bridge_key)
   select '${ADMIN_WS}', @BRAIN@, 'Admin', true, 'admin'
    where not exists (select 1 from workspaces where is_admin)`,
  `insert into workspace_users (workspace_id, login_id, moderator) values ('${WS}', '${MEMBER}', false)`,
  `insert into workspace_users (workspace_id, login_id, moderator)
   select id, '${ADMIN}', false from workspaces where is_admin
   on conflict do nothing`,
  `insert into agents (id, owner_id, slug, name, provider, model, enabled, system_prompt, workspace_id) values
  ('${AGENT_ADMIN}', @BRAIN@, 'forge-admin', 'Forge admin', 'openrouter', 'x/y', false, 'p', null),
  ('${AGENT_WS}', @BRAIN@, 'forge-ws', 'Forge ws', 'openrouter', 'x/y', false, 'p', '${WS}')`,
  `insert into ai_workers (id, owner_id, slug, name, kind, provider, model, enabled, is_default, backup_enabled)
   values ('${WORKER}', @BRAIN@, 'forge-worker', 'Forge worker', 'reflector', 'openrouter', 'x/y', false, false, false)`,
  `insert into calendar_accounts (id, owner_id, provider, display_name, enabled)
   values ('${FEED}', @BRAIN@, 'ics', 'Forge feed', false)`,
  `insert into doc_collections (id, owner_id, key, label, enabled)
   values ('${DOCS}', @BRAIN@, 'forge-docs', 'Forge docs', false)`,
  `update agents set backup_enabled = false where id = '${AGENT_ADMIN}'`,
  `insert into assistant_messages (id, owner_id, agent_id, direction, text, status, login_id) values
  ('${PENDING}', @BRAIN@, '${AGENT_ADMIN}', 'outbound', '', 'pending', @BRAIN@),
  ('${SETTLED}', @BRAIN@, '${AGENT_ADMIN}', 'outbound', 'the answer', 'complete', @BRAIN@)`,
];

const MSG = (cols: string, vals: string) =>
  `insert into assistant_messages (owner_id, direction, text, ${cols}) values (mantle_brain_id(), 'inbound', 'x', ${vals})`;

const REFUSED: readonly [string, string][] = [
  ['B: message with no assistant', MSG('login_id', 'mantle_brain_id()')],
  [
    'B: message in the Admin workspace for a member',
    MSG('agent_id, login_id', `'${AGENT_ADMIN}', '${MEMBER}'`),
  ],
  [
    'B: message in the Admin workspace for an outsider',
    MSG('agent_id, login_id', `'${AGENT_ADMIN}', '${OUTSIDER}'`),
  ],
  [
    "B: message naming a workspace not its assistant's",
    MSG('agent_id, login_id, workspace_id', `'${AGENT_ADMIN}', mantle_brain_id(), '${WS}'`),
  ],
  [
    "B: message of a workspace assistant moved to the Admin workspace's (another ws)",
    MSG('agent_id, login_id, workspace_id', `'${AGENT_WS}', '${MEMBER}', '${ADMIN_WS}'`),
  ],
  [
    'B: message for a login outside the workspace',
    MSG('agent_id, login_id', `'${AGENT_WS}', '${OUTSIDER}'`),
  ],
  [
    'B: message with an unknown assistant',
    MSG('agent_id, login_id', `gen_random_uuid(), mantle_brain_id()`),
  ],
  [
    'B: settled text rewritten',
    `update assistant_messages set text = 'forged' where id = '${SETTLED}'`,
  ],
  [
    'B: settled row back to pending',
    `update assistant_messages set status = 'pending' where id = '${SETTLED}'`,
  ],
  ['B: settled model changed', `update assistant_messages set model = 'x' where id = '${SETTLED}'`],
  [
    'B: settled data rewritten',
    `update assistant_messages set data = data || '{"superseded_by":"x"}' where id = '${SETTLED}'`,
  ],
  [
    'B: settled text through ON CONFLICT',
    `insert into assistant_messages (id, owner_id, agent_id, direction, text, login_id)
     values ('${SETTLED}', mantle_brain_id(), '${AGENT_ADMIN}', 'outbound', 'x', mantle_brain_id())
     on conflict (id) do update set text = 'forged'`,
  ],
  [
    'B: settled text through MERGE',
    `merge into assistant_messages m using (select '${SETTLED}'::uuid as id) s on m.id = s.id
     when matched then update set text = 'forged'`,
  ],
  [
    'B: a message with no assistant through MERGE',
    `merge into assistant_messages m using (select gen_random_uuid() as id) s on m.id = s.id
     when not matched then insert (owner_id, direction, text, login_id)
     values (mantle_brain_id(), 'inbound', 'x', mantle_brain_id())`,
  ],
];

const REFUSED_CD: readonly [string, string][] = [
  [
    "C: an assistant's extraction cost cap raised",
    `update agents set memory_config = memory_config || '{"extract_cost_cap_micro_usd": 999999999}' where id = '${AGENT_ADMIN}'`,
  ],
  [
    "C: an assistant's tool call limit raised",
    `update agents set memory_config = memory_config || '{"max_tool_calls": 9999, "max_iterations": 9999}' where id = '${AGENT_ADMIN}'`,
  ],
  [
    "C: an assistant's follow-up suggestion switched on",
    `update agents set params = params || '{"suggest_follow_up": true}' where id = '${AGENT_ADMIN}'`,
  ],
  [
    "C: an AI worker's extraction prompt",
    `update ai_workers set params = params || '{"extraction_prompt": "forged"}' where id = '${WORKER}'`,
  ],
  ['D: an AI worker switched on', `update ai_workers set enabled = true where id = '${WORKER}'`],
  [
    "D: an AI worker made its kind's default",
    `update ai_workers set is_default = true where id = '${WORKER}'`,
  ],
  [
    "D: an AI worker's backup route switched on",
    `update ai_workers set backup_enabled = true where id = '${WORKER}'`,
  ],
  [
    "D: an assistant's backup route switched on",
    `update agents set backup_enabled = true where id = '${AGENT_ADMIN}'`,
  ],
  [
    'D: a calendar feed switched on',
    `update calendar_accounts set enabled = true where id = '${FEED}'`,
  ],
  [
    'D: a documentation collection switched on',
    `update doc_collections set enabled = true where id = '${DOCS}'`,
  ],
];

const REFUSED_F: readonly [string, string][] = [
  [
    "F: a tool group's description (read by the model)",
    `update tool_groups set description = 'forged' where true`,
  ],
  [
    "F: an assistant's description (read by the delegate tool)",
    `update agents set description = 'forged' where id = '${AGENT_ADMIN}'`,
  ],
  ["F: the owner's display name", `update auth.users set display_name = 'forged' where is_owner`],
];

const ALLOWED: readonly [string, string][] = [
  [
    "ok: a member's message to its workspace assistant",
    MSG('agent_id, login_id', `'${AGENT_WS}', '${MEMBER}'`),
  ],
  [
    "ok: the owner's message to an Admin assistant",
    MSG('agent_id, login_id', `'${AGENT_ADMIN}', mantle_brain_id()`),
  ],
  [
    "ok: an Admin user's message to an Admin assistant",
    MSG('agent_id, login_id', `'${AGENT_ADMIN}', '${ADMIN}'`),
  ],
  [
    'ok: a pending turn settles (text, model, status, data)',
    `update assistant_messages set text = 'done', model = 'x/y', status = 'complete',
       data = data || '{"thoughts":"t"}' where id = '${PENDING}'`,
  ],
  ['ok: an AI worker renamed', `update ai_workers set name = 'renamed' where id = '${WORKER}'`],
  [
    'ok: a calendar feed switched off',
    `update calendar_accounts set enabled = false where id = '${FEED}'`,
  ],
  [
    'ok: a settled turn gains its follow-up suggestion',
    `update assistant_messages set data = data || '{"suggestion":"s","suggestedAt":"t"}' where id = '${SETTLED}'`,
  ],
];

describe.skipIf(!URL)('round 13b: the narrow login`s rules, items B to E', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let su: ReturnType<typeof postgres>;
  let nl: ReturnType<typeof postgres>;
  let brain = '';
  const KEY = () => process.env.MANTLE_MASTER_KEY ?? 'mantle-viewer-test-key';

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    su = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    brain = await ensureTestAnchor(su);
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

  /** One statement as a turn's narrow exit, rolled back: 'ok' or the
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

  /** The rows the forges aim at, to show none changed. */
  const snapshot = async () =>
    su`select id::text, text, status, model, data from assistant_messages order by id`;

  it('the session is the narrow login itself', async () => {
    const [r] = await nl`select session_user::text as s, current_user::text as c`;
    expect(r).toEqual({ s: 'mantle_system_narrow', c: 'mantle_system_narrow' });
  });

  it('every forge is refused (42501) and changes no row', async () => {
    const before = await snapshot();
    const bad: string[] = [];
    for (const [label, stmt] of [...REFUSED, ...REFUSED_CD, ...REFUSED_F]) {
      const got = await run(stmt);
      if (got !== '42501') bad.push(`${label}: ${got}`);
    }
    expect(bad).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it('D: every switch the narrow role may update is off-only (read from the catalog)', async () => {
    // The narrow role's UPDATE rights on an enabled, is_default or
    // backup_enabled column, and the rules of each table's one-way trigger.
    const rows = await su<{ tbl: string; col: string; held: boolean }[]>`
      select p.table_schema || '.' || p.table_name as tbl, p.column_name as col,
             exists (
               select 1 from pg_trigger t
                where t.tgrelid = (quote_ident(p.table_schema) || '.' || quote_ident(p.table_name))::regclass
                  and t.tgname = 'mantle_narrow_one_way_trg'
                  and ('off:' || p.column_name) = any (
                        array_remove(string_to_array(encode(t.tgargs, 'escape'), '\\000'), ''))
             ) as held
        from information_schema.column_privileges p
        join information_schema.columns c
          on c.table_schema = p.table_schema and c.table_name = p.table_name
         and c.column_name = p.column_name
       where p.grantee = 'mantle_system_narrow' and p.privilege_type = 'UPDATE'
         and c.data_type = 'boolean'
         and p.column_name in ('enabled', 'is_default', 'backup_enabled')
       order by 1, 2`;
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.filter((r) => !r.held).map((r) => `${r.tbl}.${r.col}`)).toEqual([]);
  });

  it('E: migrate takes CREATE on a schema and a sequence right back from PUBLIC', async () => {
    const [seq] = await su<{ s: string }[]>`
      select quote_ident(n.nspname) || '.' || quote_ident(c.relname) as s
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where c.relkind = 'S' and n.nspname = 'public' order by c.relname limit 1`;
    expect(seq?.s).toBeTruthy();
    await su.unsafe(`grant create on schema public to public`);
    await su.unsafe(`grant create on schema auth to public`);
    await su.unsafe(`create schema if not exists forge_13b`);
    await su.unsafe(`grant create on schema forge_13b to public`);
    await su.unsafe(
      `grant usage, select, update on all sequences in schema public, auth to public`,
    );
    // The hand grants reach the narrow login (a member of PUBLIC).
    expect(await run(`create table public.forge_13b_t (x int)`)).toBe('ok');
    const rr = await import('./runtime-role');
    await rr.applyRuntimeGrants(su);
    const [r] = await su.unsafe(`select
        has_schema_privilege('public', 'public', 'CREATE') as pub,
        has_schema_privilege('public', 'auth', 'CREATE') as auth,
        has_schema_privilege('public', 'forge_13b', 'CREATE') as other,
        (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relkind = 'S' and n.nspname in ('public', 'auth')
            and (has_sequence_privilege('public', c.oid, 'USAGE')
                 or has_sequence_privilege('public', c.oid, 'UPDATE'))) as seqs`);
    expect(r).toEqual({ pub: false, auth: false, other: false, seqs: 0 });
    const bad: string[] = [];
    for (const [label, stmt] of [
      ['E: a table made in public', `create table public.forge_13b_t (x int)`],
      ['E: a table made in auth', `create table auth.forge_13b_t (x int)`],
      ['E: a table made in another schema', `create table forge_13b.t (x int)`],
      ['E: a sequence moved', `select setval('${seq!.s}', 1)`],
    ] as const) {
      const got = await run(stmt);
      if (got !== '42501') bad.push(`${label}: ${got}`);
    }
    expect(bad).toEqual([]);
    await su.unsafe(`drop schema forge_13b cascade`);
  });

  it('the product`s own narrow writes on the same rows still run', async () => {
    const bad: string[] = [];
    for (const [label, stmt] of ALLOWED) {
      const got = await run(stmt);
      if (got !== 'ok') bad.push(`${label}: ${got}`);
    }
    expect(bad).toEqual([]);
  });

  it('B: off the narrow route a narrow reason`s break is counted and runs (0319`s notice)', async () => {
    const notices: string[] = [];
    const c = postgres(scratch.url, {
      max: 1,
      prepare: false,
      onnotice: (n) => notices.push(String(n.message)),
    });
    try {
      const got = await c
        .begin(async (t) => {
          await t.unsafe(`select set_config('mantle.actor', 'system:http:admin-area', true)`);
          await t.unsafe(`update assistant_messages set text = 'counted' where id = '${SETTLED}'`);
          const [r] = await t.unsafe(`select text from assistant_messages where id = '${SETTLED}'`);
          throw Object.assign(new Error('rollback'), {
            ok: true,
            text: (r as { text: string }).text,
          });
        })
        .catch((e: { ok?: boolean; text?: string; code?: string }) => (e.ok ? e.text : e.code));
      expect(got).toBe('counted');
      expect(notices.some((n) => /narrow-would-refuse .*assistant_messages UPDATE/.test(n))).toBe(
        true,
      );
    } finally {
      await c.end();
    }
  });
});
