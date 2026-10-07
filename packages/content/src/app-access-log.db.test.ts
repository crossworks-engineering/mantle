/**
 * The app access log reaper on Postgres (client tier audit 2026-09-30, I4,
 * maintenance sweep `app-access-log-reap`): rows older than 90 days go, in
 * batches, whoever wrote them; error rows after 14 days, and past the newest
 * APP_ERROR_LOG_KEEP_PER_APP of an app (apps audit 2026-10-02, item 12);
 * newer rows stay; a dry run counts and deletes nothing. Seeds its own rows on a random owner; removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/app-access-log.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('reapAppAccessLog', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let admin: Parameters<Db['ensureViewerRoles']>[0];
  let log: typeof import('./app-access-log');
  const owner = randomUUID();
  const app = randomUUID();
  const loud = randomUUID();
  const now = new Date('2026-09-30T12:00:00Z');
  const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 60 * 60 * 1000).toISOString();

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    log = await import('./app-access-log');
    await admin`insert into auth.users (id, email, password_hash, role) values
      (${owner}, ${`aal-${owner.slice(0, 8)}@example.invalid`}, 'x', 'admin')`;
    await admin`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`;
    await admin`insert into nodes (id, owner_id, type, title, path) values
      (${app}, ${owner}, 'app', 'polls', 'apps')`;
    await admin`insert into app_access_log (owner_id, app_node_id, kind, detail, created_at) values
      (${owner}, ${app}, 'db', '{"tag":"old-1"}'::jsonb, ${daysAgo(120)}),
      (${owner}, ${app}, 'tool', '{"tag":"old-2"}'::jsonb, ${daysAgo(91)}),
      (${owner}, ${app}, 'db', '{"tag":"kept-1"}'::jsonb, ${daysAgo(89)}),
      (${owner}, ${app}, 'auth', '{"tag":"kept-2"}'::jsonb, ${daysAgo(1)}),
      (${owner}, ${app}, 'error', '{"tag":"err-old"}'::jsonb, ${daysAgo(15)}),
      (${owner}, ${app}, 'error', '{"tag":"err-kept"}'::jsonb, ${daysAgo(13)})`;
    // An app past the per-app error cap: its oldest five go.
    await admin`insert into nodes (id, owner_id, type, title, path) values
      (${loud}, ${owner}, 'app', 'loud', 'apps')`;
    await admin`insert into app_access_log (owner_id, app_node_id, kind, detail, created_at)
      select ${owner}, ${loud}, 'error', '{}'::jsonb, ${daysAgo(1)}::timestamptz + make_interval(secs => g)
        from generate_series(1, ${log.APP_ERROR_LOG_KEEP_PER_APP + 5}) g`;
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from nodes where owner_id = ${owner}`;
    await admin`delete from spaces where login_id = ${owner}`;
    await admin`delete from auth.users where id = ${owner}`;
    await m.closeDb();
  });

  const tags = async () =>
    (
      await admin<{ tag: string }[]>`
        select detail->>'tag' as tag from app_access_log where app_node_id = ${app} order by tag`
    ).map((r) => r.tag);

  const loudErrors = async () =>
    Number(
      (await admin`select count(*)::int as n from app_access_log where app_node_id = ${loud}`)[0]!
        .n,
    );

  it('a dry run counts the rows past 90 days and deletes nothing', async () => {
    const r = await log.reapAppAccessLog({ now, dryRun: true });
    expect(r.deleted).toBeGreaterThanOrEqual(2 + 1 + 5);
    expect(await tags()).toEqual(['err-kept', 'err-old', 'kept-1', 'kept-2', 'old-1', 'old-2']);
  });

  it('deletes the rows past 90 days, errors past 14, and errors past the per-app cap', async () => {
    const r = await log.reapAppAccessLog({ now });
    expect(r.deleted).toBeGreaterThanOrEqual(2 + 1 + 5);
    expect(await tags()).toEqual(['err-kept', 'kept-1', 'kept-2']);
    expect(await loudErrors()).toBe(log.APP_ERROR_LOG_KEEP_PER_APP);
    // Idempotent.
    expect((await log.reapAppAccessLog({ now })).deleted).toBe(0);
  });
});
