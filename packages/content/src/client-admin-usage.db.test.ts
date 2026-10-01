/**
 * clientAppDbBytes on Postgres (client tier audit 2026-09-30, I1): what the
 * databases of this brain's CLIENT-level apps hold, for the storage card.
 * Team apps and another brain's client apps do not count. Seeds its own rows
 * on a random owner; removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/client-admin-usage.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('clientAppDbBytes', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let admin: Parameters<Db['ensureViewerRoles']>[0];
  let usage: typeof import('./client-admin-usage');
  const owner = randomUUID();
  const other = randomUUID();
  const apps = { a: randomUUID(), b: randomUUID(), team: randomUUID(), otherBrain: randomUUID() };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    usage = await import('./client-admin-usage');
    for (const o of [owner, other]) {
      await admin`insert into auth.users (id, email, password_hash, role) values
        (${o}, ${`cadb-${o.slice(0, 8)}@example.invalid`}, 'x', 'admin')`;
      await admin`insert into spaces (id, kind, login_id) values (${o}, 'brain', ${o})`;
    }
    await admin`insert into nodes (id, owner_id, type, title, path, audience) values
      (${apps.a}, ${owner}, 'app', 'a', 'apps', 'client'),
      (${apps.b}, ${owner}, 'app', 'b', 'apps', 'client'),
      (${apps.team}, ${owner}, 'app', 't', 'apps', 'team'),
      (${apps.otherBrain}, ${other}, 'app', 'o', 'apps', 'client')`;
    await admin`insert into app_databases (owner_id, app_node_id, storage_path, size_bytes) values
      (${owner}, ${apps.a}, '/x/a.sqlite', 1000),
      (${owner}, ${apps.b}, '/x/b.sqlite', 234),
      (${owner}, ${apps.team}, '/x/t.sqlite', 50000),
      (${other}, ${apps.otherBrain}, '/x/o.sqlite', 70000)`;
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from nodes where owner_id in ${admin([owner, other])}`;
    await admin`delete from spaces where login_id in ${admin([owner, other])}`;
    await admin`delete from auth.users where id in ${admin([owner, other])}`;
    await m.closeDb();
  });

  it("sums this brain's client-level app databases only", async () => {
    expect(await usage.clientAppDbBytes(owner)).toBe(1234);
    expect(await usage.clientAppDbBytes(randomUUID())).toBe(0);
  });
});
