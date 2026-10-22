/**
 * The narrow login's rules of the b2 re-audit's fourteenth inputs, as the
 * REAL narrow login (its derived password): the off-only switches on an
 * INSERT too (0324: a calendar feed deleted and inserted again switched
 * on), the destination and cost class (an assistant's and a worker's
 * provider, model and effort, the embedder's providers, model, dimensions
 * and knobs, a pool entry added or removed) and a prompt version, each off
 * the narrow list (access-matrix.ts NARROW_WRITES). Each forge is refused
 * (42501) and changes no row; the product's narrow writes on the same rows
 * still run; and the catalog cell reads the narrow role's INSERT rights
 * too: a table it may insert into whose switch no INSERT rule holds fails.
 */
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedScratchDatabase, ensureTestAnchor } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const AGENT = 'c1400000-0000-4000-8000-000000000001';
const WORKER = '21400000-0000-4000-8000-000000000001';
const FEED = '21400000-0000-4000-8000-000000000002';
const POOL_ENTRY = '21400000-0000-4000-8000-000000000003';

const FIXTURES = [
  `insert into agents (id, owner_id, slug, name, provider, model, enabled, system_prompt, workspace_id) values
  ('${AGENT}', @BRAIN@, 'forge14', 'Forge 14', 'openrouter', 'x/y', false, 'p', null)`,
  `insert into ai_workers (id, owner_id, slug, name, kind, provider, model, enabled, is_default, backup_enabled)
   values ('${WORKER}', @BRAIN@, 'forge14-worker', 'Forge 14 worker', 'reflector', 'openrouter', 'x/y', false, false, false)`,
  `insert into calendar_accounts (id, owner_id, provider, display_name, enabled)
   values ('${FEED}', @BRAIN@, 'ics', 'Forge feed', false)`,
  `insert into embedding_config (owner_id, model, primary_provider)
   values (@BRAIN@, 'embeddinggemma', 'local') on conflict (owner_id) do nothing`,
  `insert into curated_models (id, owner_id, pool, position, name, routes)
   values ('${POOL_ENTRY}', @BRAIN@, 'agents', 0, 'x/y', '[]')`,
];

const FEED_ROW = (enabled: string) =>
  `insert into calendar_accounts (id, owner_id, provider, display_name${enabled ? ', enabled' : ''})
   values ('${FEED}', mantle_brain_id(), 'ics', 'Forge feed'${enabled ? `, ${enabled}` : ''})`;

const REFUSED: readonly [string, string][] = [
  [
    'a calendar feed deleted and inserted again switched on',
    `delete from calendar_accounts where id = '${FEED}'; ${FEED_ROW('true')}`,
  ],
  [
    'a calendar feed deleted and inserted again on by its default',
    `delete from calendar_accounts where id = '${FEED}'; ${FEED_ROW('')}`,
  ],
  [
    'a new calendar feed switched on (ON CONFLICT DO UPDATE)',
    `${FEED_ROW('true')} on conflict (id) do update set enabled = true`,
  ],
  ["an assistant's provider", `update agents set provider = 'forged' where id = '${AGENT}'`],
  ["an assistant's model", `update agents set model = 'forged/x' where id = '${AGENT}'`],
  [
    "an assistant's backup provider and model",
    `update agents set backup_provider = 'forged', backup_model = 'forged/x' where id = '${AGENT}'`,
  ],
  [
    "an assistant's thinking effort",
    `update agents set thinking_effort = 'high' where id = '${AGENT}'`,
  ],
  ["an AI worker's provider", `update ai_workers set provider = 'forged' where id = '${WORKER}'`],
  ["an AI worker's model", `update ai_workers set model = 'forged/x' where id = '${WORKER}'`],
  [
    "an AI worker's backup provider and model",
    `update ai_workers set backup_provider = 'forged', backup_model = 'forged/x' where id = '${WORKER}'`,
  ],
  ["the embedder's model", `update embedding_config set model = 'forged'`],
  ["the embedder's provider", `update embedding_config set primary_provider = 'forged'`],
  ["the embedder's backup provider", `update embedding_config set backup_provider = 'forged'`],
  ["the embedder's dimensions", `update embedding_config set dimensions = 1536`],
  ['the extraction concurrency', `update embedding_config set extraction_concurrency = 64`],
  [
    'the extraction time budget',
    `update embedding_config set extraction_time_budget_minutes = 600`,
  ],
  [
    'the local embed batch and timeout',
    `update embedding_config set local_embed_batch_size = 512, local_embed_request_timeout_ms = 1`,
  ],
  [
    'a pool entry added',
    `insert into curated_models (owner_id, pool, position, name, routes)
       values (mantle_brain_id(), 'agents', 9, 'forged/x', '[]')`,
  ],
  ['a pool entry removed', `delete from curated_models where id = '${POOL_ENTRY}'`],
  [
    'a prompt version',
    `insert into prompt_versions (owner_id, entity_type, entity_id, field, version, body, author)
       values (mantle_brain_id(), 'agent', '${AGENT}', 'system_prompt', 99, 'forged', 'owner')`,
  ],
];

const ALLOWED: readonly [string, string][] = [
  [
    'ok: a calendar feed inserted off',
    `delete from calendar_accounts where id = '${FEED}'; ${FEED_ROW('false')}`,
  ],
  [
    'ok: a calendar feed switched off',
    `update calendar_accounts set enabled = false where id = '${FEED}'`,
  ],
  ['ok: an assistant renamed', `update agents set name = 'renamed' where id = '${AGENT}'`],
  ['ok: an AI worker renamed', `update ai_workers set name = 'renamed' where id = '${WORKER}'`],
  ["ok: the embedder's backup switched off", `update embedding_config set backup_enabled = false`],
  ["ok: the embedder's labels", `update embedding_config set primary_label = 'Local'`],
  [
    'ok: a pool entry stamped',
    `update curated_models set updated_at = now() where id = '${POOL_ENTRY}'`,
  ],
];

describe.skipIf(!URL)(
  'the narrow login`s rules: switches on insert, destinations and costs',
  () => {
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

    /** Statements as an Admin area exit's narrow work, rolled back: 'ok' or
     *  the error's code. */
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

    const snapshot = async () => ({
      feed: await su`select id, enabled from calendar_accounts order by id`,
      agent:
        await su`select provider, model, backup_provider, backup_model, thinking_effort from agents where id = ${AGENT}`,
      worker:
        await su`select provider, model, backup_provider, backup_model from ai_workers where id = ${WORKER}`,
      emb: await su`select model, primary_provider, backup_provider, dimensions, extraction_concurrency from embedding_config`,
      pools: await su`select id, name from curated_models order by id`,
      versions: await su`select count(*)::int as n from prompt_versions`,
    });

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

    it("the product's narrow writes on the same rows still run", async () => {
      const bad: string[] = [];
      for (const [label, stmt] of ALLOWED) {
        const got = await run(stmt);
        if (got !== 'ok') bad.push(`${label}: ${got}`);
      }
      expect(bad).toEqual([]);
    });

    it('every switch of a table the narrow role may insert into is held on INSERT too (read from the catalog)', async () => {
      const rows = await su<{ tbl: string; col: string; held: boolean }[]>`
      select c.table_schema || '.' || c.table_name as tbl, c.column_name as col,
             exists (
               select 1 from pg_trigger t
                where t.tgrelid = (quote_ident(c.table_schema) || '.' || quote_ident(c.table_name))::regclass
                  and t.tgname = 'mantle_narrow_one_way_trg'
                  and t.tgtype::int & 4 <> 0
                  and ('off:' || c.column_name) = any (
                        array_remove(string_to_array(encode(t.tgargs, 'escape'), '\\000'), ''))
             ) as held
        from information_schema.columns c
       where c.table_schema in ('public', 'auth')
         and c.data_type = 'boolean'
         and c.column_name in ('enabled', 'is_default', 'backup_enabled')
         and has_table_privilege('mantle_system_narrow',
               (quote_ident(c.table_schema) || '.' || quote_ident(c.table_name))::regclass, 'INSERT')
       order by 1, 2`;
      expect(rows.map((r) => r.tbl)).toContain('public.calendar_accounts');
      expect(rows.filter((r) => !r.held).map((r) => `${r.tbl}.${r.col}`)).toEqual([]);
    });
  },
);
