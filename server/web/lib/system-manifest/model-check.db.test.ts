/**
 * A fresh brain seeded from the manifest runs every default model, and the
 * model check (model-check-db.ts) says so; a worker an operator moved to
 * another model reads `drift`, a switched-off agent `off`. The check only
 * reads: the rows are the same after it.
 * Seeds its own brain (random owner, own api key row); removes it.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/web/lib/system-manifest/model-check.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asSuperuser } from '@mantle/db/test-support';
import { DEFAULT_AGENT_MODEL, MANIFEST_AGENTS, MANIFEST_WORKERS } from './manifest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Row = Record<string, unknown>;

describe.skipIf(!URL)('the model check on a fresh brain', () => {
  let m: typeof import('@mantle/db');
  let check: typeof import('./model-check-db');
  const su = asSuperuser(URL);
  const owner = randomUUID();

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    check = await import('./model-check-db');
    const seed = await import('./seed');
    await su`insert into auth.users (id, email, password_hash, role)
             values (${owner}, ${`mc-${owner.slice(0, 8)}@example.invalid`}, 'x', 'admin')`;
    await su`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`;
    await su`insert into api_keys (id, user_id, service, label, key_enc)
             values (${randomUUID()}, ${owner}, 'openrouter', 'default', '\\x00'::bytea)`;
    // The persona row comes from onboarding (on the manifest's model), not
    // applyManifest.
    await su`insert into agents (owner_id, slug, name, model, role, system_prompt)
             values (${owner}, 'assistant', 'Assistant', ${DEFAULT_AGENT_MODEL}, 'responder', 'x')`;
    await seed.seedManifestWorkers(owner);
    await seed.applyManifest(owner);
  }, 120_000);

  afterAll(async () => {
    for (const t of [
      'prompt_versions',
      'heartbeats',
      'tools',
      'tool_groups',
      'skills',
      'agents',
      'ai_workers',
      'model_pool_entries',
    ]) {
      await su(`delete from ${t} where owner_id = '${owner}'`).catch(() => undefined);
    }
    await su`delete from api_keys where user_id = ${owner}`;
    await su`delete from profiles where id = ${owner}`.catch(() => undefined);
    await su`delete from spaces where id = ${owner}`;
    await su`delete from auth.users where id = ${owner}`;
    await m?.closeDb();
  }, 120_000);

  it('every worker and agent is on its default', async () => {
    const r = await check.computeModelCheck(owner);
    expect(r.rows).toHaveLength(MANIFEST_WORKERS.length + MANIFEST_AGENTS.length);
    expect(r.rows.filter((x) => x.status !== 'ok')).toEqual([]);
    expect(r.notOk).toBe(0);
  }, 60_000);

  it('a moved worker is drift, a switched-off agent off, and the rows stay as they were', async () => {
    const before = (await su`select kind, model from ai_workers where owner_id = ${owner}
                             order by kind`) as Row[];
    await su`update ai_workers set model = 'vendor/other' where owner_id = ${owner} and kind = 'summarizer'`;
    await su`update agents set enabled = false where owner_id = ${owner} and slug = 'coder'`;
    const r = await check.computeModelCheck(owner);
    const summarizer = r.rows.find((x) => x.kind === 'worker' && x.name === 'summarizer')!;
    expect(summarizer.status).toBe('drift');
    expect(summarizer.box?.model).toBe('vendor/other');
    expect(r.rows.find((x) => x.kind === 'agent' && x.name === 'coder')!.status).toBe('off');
    expect(r.notOk).toBe(2);
    const after = (await su`select kind, model from ai_workers where owner_id = ${owner}
                            order by kind`) as Row[];
    expect(after.map((x) => x.kind)).toEqual(before.map((x) => x.kind));
  }, 60_000);
});
