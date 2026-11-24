/**
 * The shipped Recall maps are seeded once per brain (seedManifestRecallMaps),
 * on one migrated scratch database, switched to workspaces:
 *  - the first run makes each map published, its entry card with an option
 *    to one confirmed prompt (kind `prompt`, not pending), and lists its key;
 *  - a second run makes nothing (idempotent);
 *  - a map the owner edits or deletes stays as the owner left it: a later
 *    run does not seed it again;
 *  - the boot reconcile (reconcileOwner) runs the seed.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/web/lib/system-manifest/recall-maps.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the shipped Recall maps, once per brain', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let seed: typeof import('./seed');
  let manifest: typeof import('./manifest');
  const owner = randomUUID();
  const tag = `rms${randomUUID().slice(0, 6)}`;

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const maps = () =>
    x<{ id: string; slug: string; published: boolean; title: string }>(sql`
      select id::text as id, slug, published, title from recall_maps where owner_id = ${owner}`);
  const cards = (mapId: string) =>
    x<{
      slug: string;
      kind: string;
      prompt_pending: boolean;
      options: { targetSlug: string }[];
    }>(sql`select slug, kind, prompt_pending, options from recall_nodes
      where map_id = ${mapId} order by rank`);
  const seededKeys = async () =>
    ((
      await x<{ k: string[] | null }>(sql`
      select preferences->'recallMapsSeeded' as k from profiles where user_id = ${owner}`)
    )[0]?.k ?? []) as string[];

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    seed = await import('./seed');
    manifest = await import('./manifest');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
      values (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    // The key a provisioned brain has (reconcileOwner provisions specialists).
    await x(sql`insert into api_keys (id, user_id, service, label, key_enc)
      values (${randomUUID()}, ${owner}, 'openrouter', 'default', '\\x00'::bytea)`);
    await ts.runWorkspacesSwitch();
  }, 240_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  it('makes each map published, with one confirmed prompt the entry card leads to', async () => {
    const keys = manifest.MANIFEST_RECALL_MAPS.map((r) => r.key);
    expect(await seed.seedManifestRecallMaps(owner)).toEqual(keys);
    expect(await seededKeys()).toEqual(keys);
    const made = await maps();
    expect(made).toHaveLength(manifest.MANIFEST_RECALL_MAPS.length);
    const map = made.find((r) => r.title === 'Read data from files')!;
    expect(map.published).toBe(true);
    const [entry, prompt, ...rest] = await cards(map.id);
    expect(rest).toEqual([]);
    expect(entry!.slug).toBe('start');
    expect(prompt!.kind).toBe('prompt');
    expect(prompt!.prompt_pending).toBe(false);
    expect(entry!.options.map((o) => o.targetSlug)).toEqual([prompt!.slug]);
  });

  it('makes nothing on a second run', async () => {
    expect(await seed.seedManifestRecallMaps(owner)).toEqual([]);
    expect(await maps()).toHaveLength(manifest.MANIFEST_RECALL_MAPS.length);
  });

  it("keeps the owner's edit and the owner's delete", async () => {
    const [map] = await maps();
    await x(sql`update recall_maps set title = 'Our own words' where id = ${map!.id}::uuid`);
    expect(await seed.seedManifestRecallMaps(owner)).toEqual([]);
    expect((await maps())[0]!.title).toBe('Our own words');
    const { deleteRecallMap } = await import('@mantle/content');
    await deleteRecallMap(owner, map!.id, { kind: 'owner', id: owner, name: 'Owner' });
    expect(await maps()).toHaveLength(0);
    expect(await seed.seedManifestRecallMaps(owner)).toEqual([]);
    expect(await maps()).toHaveLength(0);
  });

  it('is a step of the boot reconcile', async () => {
    await x(sql`update profiles set preferences = preferences - 'recallMapsSeeded'
      where user_id = ${owner}`);
    const { reconcileOwner } = await import('./reconcile');
    const out = await reconcileOwner(owner);
    expect(out.recallMapsSeeded).toEqual(manifest.MANIFEST_RECALL_MAPS.map((r) => r.key));
    expect(await maps()).toHaveLength(manifest.MANIFEST_RECALL_MAPS.length);
  }, 240_000);
});
