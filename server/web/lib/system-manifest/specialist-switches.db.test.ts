/**
 * The owner's param switches on a specialist (tool_loading, suggest_follow_up,
 * top_p) survive the boot reconcile and the per-item Adopt; the manifest still
 * owns the rest of params (temperature, max_tokens). Decided 2026-10-05
 * ("keep switches"): before, syncSpecialistDefs wrote the manifest params
 * whole and a tool_loading 'deferred' went back to full on the next version.
 * The persona's params are never touched by either path.
 * Seeds its own brain (random owner, own api key row); removes it.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/system-manifest/specialist-switches.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MANIFEST_AGENTS } from './manifest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Row = Record<string, unknown>;

// A specialist the boot reconcile syncs: not the persona, has a prompt.
const spec = MANIFEST_AGENTS.find((a) => !a.isPersona && a.systemPrompt)!;
const switches = { tool_loading: 'deferred', suggest_follow_up: true, top_p: 0.8 };

describe.skipIf(!URL)('owner param switches on a specialist', () => {
  let m: typeof import('@mantle/db');
  let admin: Parameters<typeof m.ensureViewerRoles>[0];
  let seed: typeof import('./seed');
  let rec: typeof import('./reconcile');
  const owner = randomUUID();

  const paramsOf = async (slug: string) =>
    (await admin<Row[]>`select params from agents where owner_id = ${owner} and slug = ${slug}`)[0]!
      .params as Record<string, unknown>;
  const setParams = (slug: string, params: Record<string, unknown>) =>
    admin`update agents set params = ${JSON.stringify(params)}::jsonb
          where owner_id = ${owner} and slug = ${slug}`;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    seed = await import('./seed');
    rec = await import('./reconcile');
    await admin`insert into auth.users (id, email, password_hash, role)
                values (${owner}, ${`sw-${owner.slice(0, 8)}@example.invalid`}, 'x', 'admin')`;
    await admin`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`;
    await admin`insert into api_keys (id, user_id, service, label, key_enc)
                values (${randomUUID()}, ${owner}, 'openrouter', 'default', '\\x00'::bytea)`;
    // The persona row comes from onboarding, not applyManifest (it skips it).
    await admin`insert into agents (owner_id, slug, name, model, role, system_prompt)
                values (${owner}, 'assistant', 'Assistant', 'test/model', 'responder', 'x')`;
    await seed.applyManifest(owner);
  }, 120_000);

  afterAll(async () => {
    if (!admin) return;
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
      await admin.unsafe(`delete from ${t} where owner_id = $1`, [owner]).catch(() => undefined);
    }
    await admin`delete from api_keys where user_id = ${owner}`;
    await admin`delete from profiles where id = ${owner}`.catch(() => undefined);
    await admin`delete from spaces where id = ${owner}`;
    await admin`delete from auth.users where id = ${owner}`;
    await m.closeDb();
  }, 120_000);

  it('the reconcile keeps the switches and puts the manifest tuning back', async () => {
    await setParams(spec.slug, { ...switches, temperature: 1.9, max_tokens: 7 });
    const r = await rec.reconcileOwner(owner);
    expect(r.defsSynced).toContain(spec.slug);
    expect(await paramsOf(spec.slug)).toEqual({ ...spec.params, ...switches });
  }, 120_000);

  it('a second reconcile finds nothing to change (no rewrite on key order)', async () => {
    const r = await rec.reconcileOwner(owner);
    expect(r.defsSynced).not.toContain(spec.slug);
    expect(await paramsOf(spec.slug)).toEqual({ ...spec.params, ...switches });
  }, 120_000);

  it('Adopt from template keeps the switches too', async () => {
    await setParams(spec.slug, { tool_loading: 'deferred', temperature: 1.5 });
    await seed.adoptManifestItem(owner, 'agent', spec.slug);
    expect(await paramsOf(spec.slug)).toEqual({ ...spec.params, tool_loading: 'deferred' });
  }, 120_000);

  it('the persona params are never touched', async () => {
    const persona = MANIFEST_AGENTS.find((a) => a.isPersona)!;
    const own = { ...switches, temperature: 1.1 };
    await setParams(persona.slug, own);
    await rec.reconcileOwner(owner);
    await seed.adoptManifestItem(owner, 'persona', persona.slug);
    expect(await paramsOf(persona.slug)).toEqual(own);
  }, 120_000);
});
