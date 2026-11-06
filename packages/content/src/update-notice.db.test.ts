/**
 * The update notice's one stored value (update-notice.ts), on a migrated
 * scratch brain on workspaces: an Admin user who is not the anchor switches
 * it in its own scope, and it lands on the ANCHOR's row (a brain key), where
 * the public read finds it with no login; off clears it; the switching
 * login's own row never holds it.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/update-notice.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the update notice on the anchor row', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let un: typeof import('./update-notice');
  let sqlTag: typeof import('drizzle-orm').sql;
  let su: (q: ReturnType<typeof import('drizzle-orm').sql>) => Promise<unknown[]>;
  let version: string;

  const tag = `un${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const owner = randomUUID();
  const adminB = randomUUID();

  const stored = async (id: string) =>
    (
      (await su(
        sqlTag`select preferences->'updateNotice' as v from profiles where user_id = ${id}`,
      )) as { v: unknown }[]
    )[0]?.v ?? null;

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    un = await import('./update-notice');
    version = (await import('@mantle/client-types/version')).APP_VERSION;
    sqlTag = (await import('drizzle-orm')).sql;
    await ts.ensureTestViewerRoles(URL!, process.env.MANTLE_MASTER_KEY);
    su = (q) => ts.superuserExec(scratch!.url, q);

    await su(sqlTag`insert into auth.users (id, email, password_hash, role, is_owner, display_name)
      values (${owner}, ${`${tag}-o@example.invalid`}, 'x', 'admin', true, 'Olive Owner')`);
    await ts.runWorkspacesSwitch(scratch.url);
    await su(sqlTag`insert into auth.users (id, email, password_hash, role, display_name)
      values (${adminB}, ${`${tag}-b@example.invalid`}, 'x', 'admin', 'Bea Admin')`);
    const [adminWs] = (await su(
      sqlTag`select id::text as id from workspaces where is_admin and archived_at is null limit 1`,
    )) as { id: string }[];
    await su(sqlTag`insert into workspace_users (workspace_id, login_id) values (${adminWs!.id}, ${adminB})
      on conflict do nothing`);
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  }, 120_000);

  it('nothing is stored on a fresh brain', async () => {
    expect(await un.readUpdateNotice()).toBeUndefined();
  });

  it("an Admin user switches it on in its own scope; it lands on the anchor's row", async () => {
    const before = Date.now();
    const got = await m.withViewer({ login: adminB }, () => un.setUpdateNotice(adminB, true));
    expect(got?.version).toBe(version);
    expect(Date.parse(got!.setAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(await un.readUpdateNotice()).toEqual(got);
    expect(await stored(owner)).toEqual(got);
    expect(await stored(adminB)).toBeNull();
  });

  it('off clears it', async () => {
    await m.withViewer({ login: adminB }, () => un.setUpdateNotice(adminB, false));
    expect(await un.readUpdateNotice()).toBeUndefined();
    expect(await stored(owner)).toBeNull();
  });
});
