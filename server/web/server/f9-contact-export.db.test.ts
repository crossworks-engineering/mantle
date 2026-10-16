/**
 * A8 matrix F9 (migration 0294; docs/actors.md, "A8 matrix"): a contact
 * share with Can write writes its app's data and nothing else, and its
 * write still reaches the app's exported Table. On a migrated scratch
 * database with both checks on, end to end through the product's own path:
 * the contact's cookie, POST /s/<token>/db-broker through the full HTTP
 * pipeline (runRoute: the gate, the share gate naming contact:rw), the
 * app's real SQLite, and the debounced export sync (a real timer, about
 * 15 s). The dirty stamp and the sync run as system(app-export), never as
 * the contact (before the fix the timer carried contact:rw to the Table's
 * writes, which 0294 refuses). The same contact:rw actor on any other item
 * table is refused by the database. `pnpm test:edit-on` runs this file too.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/f9-contact-export.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('F9: a contact share writes its app’s data, and its export syncs', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let content: typeof import('@mantle/content');
  let appdb: typeof import('@mantle/content/app-broker');
  let exportsMod: typeof import('@mantle/content/app-table-exports');
  let runRoute: typeof import('./run-route').runRoute;
  let dir = '';
  const owner = randomUUID();
  const contactId = randomUUID();
  const tag = `f9${randomUUID().slice(0, 6)}`;
  const schema = {
    schemaSql: 'CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT);',
    schemaVersion: 1,
  };
  const green = {
    storageKey: 'apps/x.js',
    sha256: 'x',
    builtAt: '2026-10-01T00:00:00Z',
    esbuildVersion: '0',
    bytes: 1,
    ok: true,
  };
  let appId = '';
  let linkId = '';
  let token = '';
  let cookie = '';

  const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);
  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const sys = <T>(fn: () => Promise<T>) => m.runAsSystem('test:f9', fn) as Promise<T>;
  type Link = {
    dirty: string | null;
    synced: string | null;
    hash: string | null;
    error: string | null;
  };
  const link = async (): Promise<Link> =>
    (
      await x<Link>(sql`
        select dirty_since::text as dirty, last_synced_at::text as synced,
               content_hash as hash, last_error as error
          from app_table_exports where id = ${linkId}`)
    )[0]!;

  beforeAll(async () => {
    process.env.MANTLE_ACTOR_CHECK = 'on';
    process.env.MANTLE_TEST_EDIT_CHECK = 'on';
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'f9-contact-export-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'f9-contact-export-secret-at-least-32-characters';
    delete process.env.MANTLE_DETACHED_DEV;
    m = await import('@mantle/db');
    content = await import('@mantle/content');
    appdb = await import('@mantle/content/app-broker');
    exportsMod = await import('@mantle/content/app-table-exports');
    runRoute = (await import('./run-route')).runRoute;
    // The scratch database runs with the edit check on, as a box an
    // operator switched (MANTLE_TEST_EDIT_CHECK above).
    const [mode] = await su<{ m: string }>(sql`select mantle_check_box_mode('edit_check') as m`);
    expect(mode?.m).toBe('on');

    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
      values (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await ts.runWorkspacesSwitch();

    // An app with one exported table, published.
    const app = await sys(() => content.createApp(owner, { title: `${tag} Orders` }));
    appId = app.id;
    await sys(() => content.setManifest(owner, appId, { sqlite: schema }));
    await sys(() =>
      appdb.appDbExec(owner, appId, "INSERT INTO notes (body) VALUES ('first')", [], schema),
    );
    linkId = (await sys(() => exportsMod.createAppTableExport(owner, appId, 'notes'))).export.id;
    await x(sql`update apps set published_build = ${JSON.stringify(green)}::jsonb
                 where node_id = ${appId}`);

    // A contact with sharing on, a share of the app with Can write, and the
    // visitor cookie the code prompt sets (lib/contact-share-gate.ts).
    await x(sql`insert into nodes (id, owner_id, type, title, path)
      values (${contactId}, ${owner}, 'contact', ${`${tag} contact`}, 'contacts')`);
    await sys(() => content.enableContactSharing(owner, contactId));
    const [share] = await sys(() => content.createContactShares(owner, appId, [contactId], true));
    token = share!.path.slice('/s/'.length);
    const [code] = await x<{ epoch: number }>(sql`
      select code_epoch as epoch from contact_share_codes where contact_id = ${contactId}`);
    const auth = await import('../lib/auth/tokens');
    const visitor = auth.buildContactVisitorValue({
      contactId,
      ownerId: owner,
      codeEpoch: code!.epoch,
    });
    cookie = `${auth.CONTACT_VISITOR_COOKIE}=${visitor.value}`;
    m.takeActorMisses();
  }, 240_000);

  afterAll(async () => {
    process.env.MANTLE_ACTOR_CHECK = 'warn';
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }, 60_000);

  it('the write lands, the exports are stamped and the Table syncs, all with the check on', async () => {
    const before = await link();
    expect(before).toMatchObject({ dirty: null, error: null });
    const res = await runRoute(
      null,
      'POST',
      `/s/${token}/db-broker`,
      { op: 'exec', sql: 'INSERT INTO notes (body) VALUES (?)', params: ['from the contact'] },
      { headers: { cookie, 'x-forwarded-for': '10.9.9.1' } },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    // The app's own rows and its client-written stamp (app_databases: its
    // app's data, the one item table a contact share writes).
    const rows = await sys(() =>
      appdb.appDbQuery(owner, appId, 'SELECT body FROM notes ORDER BY id', [], schema),
    );
    expect(JSON.stringify(rows)).toContain('from the contact');
    const [stamp] = await x<{ at: string | null }>(sql`
      select client_written_at::text as at from app_databases where app_node_id = ${appId}`);
    expect(stamp?.at).not.toBeNull();
    // The dirty stamp (fire-and-forget, as system(app-export)).
    await vi.waitFor(async () => expect((await link()).dirty).not.toBeNull(), {
      timeout: 10_000,
      interval: 50,
    });
    // The debounced sync (15 s), as system(app-export): the Table rebuilt
    // from the new rows, no error, the stamp cleared.
    const after = await vi.waitFor(
      async () => {
        const l = await link();
        expect(l.synced).not.toBe(before.synced);
        return l;
      },
      { timeout: 45_000, interval: 250 },
    );
    expect(after).toMatchObject({ error: null, dirty: null });
    expect(after.hash).not.toBe(before.hash);
    expect(m.takeActorMisses()).toEqual([]);
  }, 90_000);

  it('the same actor on any other item table is refused by the database', async () => {
    const attempt = async (q: ReturnType<typeof sql>) => {
      try {
        await m.systemDb.transaction(async (tx) => {
          await tx.execute(sql`select set_config('mantle.actor', 'contact:rw', true),
                                      set_config('mantle.write_mode', 'rw', true)`);
          await tx.execute(q);
        });
        return 'made';
      } catch (err) {
        const e = (err as { cause?: { code?: string; detail?: string } }).cause ?? err;
        return `${(e as { code?: string }).code} ${(e as { detail?: string }).detail}`;
      }
    };
    const refused = '42501 ro_actor';
    expect(await attempt(sql`update nodes set title = title where id = ${appId}`)).toBe(refused);
    expect(
      await attempt(sql`update app_table_exports set last_write_at = now() where id = ${linkId}`),
    ).toBe(refused);
    expect(await attempt(sql`update shares set revoked_at = now() where node_id = ${appId}`)).toBe(
      refused,
    );
    expect(
      await attempt(
        sql`update app_databases set size_bytes = size_bytes where app_node_id = ${appId}`,
      ),
    ).toBe('made');
    m.takeActorMisses();
  });
});
