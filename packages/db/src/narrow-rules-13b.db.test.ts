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
 *    rewritten, by UPDATE, ON CONFLICT, MERGE or COPY; off the narrow
 *    route the same break by a narrow reason is counted and runs.
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
    for (const [label, stmt] of REFUSED) {
      const got = await run(stmt);
      if (got !== '42501') bad.push(`${label}: ${got}`);
    }
    expect(bad).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it('B: COPY meets the insert rule (a row with no assistant)', async () => {
    const got = await nl
      .begin(async (t) => {
        const w = await t
          .unsafe(`copy assistant_messages (owner_id, direction, text, login_id) from stdin`)
          .writable();
        await new Promise<void>((resolve, reject) => {
          w.on('error', reject);
          w.on('finish', () => resolve());
          w.write(`${brain}\tinbound\tx\t${brain}\n`);
          w.end();
        });
        throw Object.assign(new Error('rollback'), { ok: true });
      })
      .then(
        () => 'ok',
        (e: { ok?: boolean; code?: string }) => (e.ok ? 'ok' : (e.code ?? 'error')),
      );
    expect(got).toBe('42501');
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
