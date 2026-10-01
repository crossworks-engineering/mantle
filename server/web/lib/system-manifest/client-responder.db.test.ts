/**
 * Every brain gets a working client-responder (client logins C4, Jason's
 * requirement, plan section 15): a FRESH install through onboarding's
 * applyManifest, and an EXISTING brain through the boot reconcile
 * (reconcileOwner), each with the agent AT CLIENT LEVEL holding the
 * client-read group AT CLIENT LEVEL, so no admin has to do anything before a
 * client can chat. Also: the reconcile converges a raised client-read back to
 * client and a widened one back to the manifest's tools (audit L3), never
 * touches an agent level an admin chose, and leaves team-responder at admin
 * as it ships.
 * Seeds its own brains (random owners, own api key rows); removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/system-manifest/client-responder.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Row = Record<string, unknown>;

describe.skipIf(!URL)('client-responder on every brain', () => {
  let m: typeof import('@mantle/db');
  let admin: Parameters<typeof m.ensureViewerRoles>[0];
  let seed: typeof import('./seed');
  let rec: typeof import('./reconcile');
  const brains = { fresh: randomUUID(), existing: randomUUID(), raised: randomUUID() };

  const agent = async (owner: string, slug: string) =>
    (
      await admin<Row[]>`select slug, audience, enabled, tool_group_slugs, memory_config
                          from agents where owner_id = ${owner} and slug = ${slug}`
    )[0];
  const group = async (owner: string, slug: string) =>
    (
      await admin<Row[]>`select slug, audience, tool_slugs, enabled from tool_groups
                          where owner_id = ${owner} and slug = ${slug}`
    )[0];

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    seed = await import('./seed');
    rec = await import('./reconcile');
    for (const owner of Object.values(brains)) {
      await admin`insert into auth.users (id, email, password_hash, role)
                  values (${owner}, ${`cr-${owner.slice(0, 8)}@example.invalid`}, 'x', 'admin')`;
      await admin`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`;
      await admin`insert into api_keys (id, user_id, service, label, key_enc)
                  values (${randomUUID()}, ${owner}, 'openrouter', 'default', '\\x00'::bytea)`;
    }
    // An EXISTING brain from before C4: a persona and team-responder, no
    // client-responder, no client-read group.
    for (const owner of [brains.existing, brains.raised]) {
      await admin`insert into agents (owner_id, slug, name, model, role, system_prompt)
                  values (${owner}, 'assistant', 'Assistant', 'test/model', 'assistant', 'x')`;
      await admin`insert into agents (owner_id, slug, name, model, system_prompt, audience)
                  values (${owner}, 'team-responder', 'Team Responder', 'test/model', 'x', 'team')`;
    }
    // One whose client-read an admin raised to admin and widened (a
    // brain-wide read and a recipe added by hand), and whose client-responder
    // an admin set to team: the group is product-owned (it converges); the
    // agent's level is the admin's choice (kept).
    await admin`insert into tool_groups (owner_id, slug, name, tool_slugs, audience)
                values (${brains.raised}, 'client-read', 'Client reads',
                        ${['client_shared_list', 'page_get', 'recipe_read_page']}, 'admin')`;
    await admin`insert into agents (owner_id, slug, name, model, system_prompt, audience)
                values (${brains.raised}, 'client-responder', 'Client Responder', 'test/model', 'x', 'team')`;
  }, 120_000);

  afterAll(async () => {
    if (!admin) return;
    const owners = Object.values(brains);
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
      await admin
        .unsafe(`delete from ${t} where owner_id = any($1::uuid[])`, [owners])
        .catch(() => undefined);
    }
    await admin`delete from api_keys where user_id in ${admin(owners)}`;
    await admin`delete from profiles where id in ${admin(owners)}`.catch(() => undefined);
    await admin`delete from spaces where id in ${admin(owners)}`;
    await admin`delete from auth.users where id in ${admin(owners)}`;
    await m.closeDb();
  }, 120_000);

  it('a fresh install (onboarding applyManifest): client-responder and client-read at client', async () => {
    await seed.applyManifest(brains.fresh);
    expect(await agent(brains.fresh, 'client-responder')).toMatchObject({
      audience: 'client',
      enabled: true,
      tool_group_slugs: ['client-read'],
    });
    const g = await group(brains.fresh, 'client-read');
    expect(g).toMatchObject({ audience: 'client', enabled: true });
    expect(g!.tool_slugs).toEqual([
      'client_shared_list',
      'client_shared_search',
      'client_shared_open',
      'my_items_list',
      'my_item_open',
      'client_request_create',
    ]);
    // No retrieval context and no delegation for the client agent.
    expect((await agent(brains.fresh, 'client-responder'))!.memory_config).toMatchObject({
      fact_limit: 0,
      content_hit_limit: 0,
      chunk_limit: 0,
      delegate_to: [],
    });
    // team-responder still ships at admin (an admin lowers it).
    expect((await agent(brains.fresh, 'team-responder'))!.audience).toBe('admin');
    // The client tools are seeded as builtin tool rows.
    const tools = await admin<Row[]>`select slug from tools where owner_id = ${brains.fresh}
      and slug in ('client_shared_list','client_shared_search','client_shared_open','client_request_create')`;
    expect(tools).toHaveLength(4);
  }, 120_000);

  it('an existing brain (the boot reconcile): gets both at client, nothing else moves', async () => {
    const r = await rec.reconcileOwner(brains.existing);
    expect(r.provisioned).toContain('client-responder');
    expect(await agent(brains.existing, 'client-responder')).toMatchObject({
      audience: 'client',
      enabled: true,
      tool_group_slugs: ['client-read'],
    });
    expect((await group(brains.existing, 'client-read'))!.audience).toBe('client');
    // The admin's team-responder level is untouched.
    expect((await agent(brains.existing, 'team-responder'))!.audience).toBe('team');
    // client-responder is never wired as anyone's delegate.
    const persona = await agent(brains.existing, 'assistant');
    expect(
      ((persona!.memory_config ?? {}) as { delegate_to?: string[] }).delegate_to ?? [],
    ).not.toContain('client-responder');
    // A second run is a no-op for it.
    expect((await rec.reconcileOwner(brains.existing)).provisioned).not.toContain(
      'client-responder',
    );
  }, 120_000);

  it('the reconcile converges a raised, widened client-read and keeps an admin-set agent level', async () => {
    await rec.reconcileOwner(brains.raised);
    expect((await group(brains.raised, 'client-read'))!.audience).toBe('client');
    // Its tools are the manifest's again: page_get and the recipe are gone.
    expect((await group(brains.raised, 'client-read'))!.tool_slugs).toEqual([
      'client_shared_list',
      'client_shared_search',
      'client_shared_open',
      'my_items_list',
      'my_item_open',
      'client_request_create',
    ]);
    expect((await agent(brains.raised, 'client-responder'))!.audience).toBe('team');
  }, 120_000);
});
