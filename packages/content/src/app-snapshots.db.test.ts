/**
 * App history on Postgres (apps snapshots, Phase 2; migration 0219): publish
 * appends a version; a snapshot keeps the code and a copy of the database;
 * restore puts back the code (draft), the data, or both (live), always after
 * an undo snapshot; a version holds no data and cannot be deleted; the
 * automatic snapshots are pruned, the owner's are not; a restore marker
 * stops the app's SQL while the file is swapped; a deleted app waits in the
 * trash for 30 days and comes back with its id (Phase 3). Seeds its own owner and
 * apps on random ids; removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/app-snapshots.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('app history on Postgres', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let admin: Parameters<Db['ensureViewerRoles']>[0];
  let apps: typeof import('./apps');
  let broker: typeof import('./app-broker');
  let snaps: typeof import('./app-snapshots');
  let dir = '';
  const owner = randomUUID();
  /** A second brain for the manual budget test: its sums see only its own rows. */
  const budgetOwner = randomUUID();
  /** Two member logins, for the per-member budget (audit B6). */
  const members = [randomUUID(), randomUUID()] as const;
  const tag = owner.slice(0, 8);
  const GREEN = {
    storageKey: 'attachments/aa/bb/test',
    sha256: 'test',
    builtAt: '2026-10-02T00:00:00.000Z',
    esbuildVersion: 'test',
    bytes: 1,
    ok: true,
  };
  const schema = {
    schemaSql: 'CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT);',
    schemaVersion: 1,
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    dir = await mkdtemp(path.join(tmpdir(), 'app-snapshots-db-'));
    process.env.APP_DB_DIR = dir;
    m = await import('@mantle/db');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    apps = await import('./apps');
    broker = await import('./app-broker');
    snaps = await import('./app-snapshots');
    await admin`insert into auth.users (id, email, password_hash, role) values
      (${owner}, ${`as-${tag}@example.invalid`}, 'x', 'admin')`;
    await admin`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`;
    await admin`insert into auth.users (id, email, password_hash, role) values
      (${budgetOwner}, ${`asb-${tag}@example.invalid`}, 'x', 'admin')`;
    await admin`insert into spaces (id, kind, login_id)
                values (${budgetOwner}, 'brain', ${budgetOwner})`;
    for (const [i, id] of members.entries()) {
      await admin`insert into auth.users (id, email, password_hash, role) values
        (${id}, ${`asm${i}-${tag}@example.invalid`}, 'x', 'member')`;
    }
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from nodes where owner_id in ${admin([owner, budgetOwner])}`;
    await admin`delete from spaces where login_id in ${admin([owner, budgetOwner])}`;
    await admin`delete from auth.users where id in ${admin([owner, budgetOwner, ...members])}`;
    await m.closeDb();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  /** An app with v1 published ("one") and one row in its database. */
  async function publishedApp(title: string) {
    const app = await apps.createApp(owner, { title: `${tag} ${title}` });
    await apps.writeDraftFile(owner, app.id, 'App.tsx', 'export default () => "one";');
    await apps.setManifest(owner, app.id, { sqlite: schema });
    await apps.setDraftBuild(owner, app.id, GREEN);
    await apps.publishApp(owner, app.id, { note: 'first', actor: 'owner' });
    await broker.appDbExec(owner, app.id, "INSERT INTO items (name) VALUES ('a')", [], schema);
    return app.id;
  }
  const names = async (id: string) =>
    (await broker.appDbQuery(owner, id, 'SELECT name FROM items ORDER BY id', [], schema)).map(
      (r) => r.name,
    );

  it('publish appends a version; a snapshot keeps the code and the data', async () => {
    const id = await publishedApp('timeline');
    const snap = await snaps.createAppSnapshot(owner, id, { note: 'safe point' });
    expect(snap).toMatchObject({ seq: 2, kind: 'snapshot', hasData: true, note: 'safe point' });
    const list = await snaps.listAppSnapshots(owner, id);
    expect(list.map((e) => [e.seq, e.kind, e.trigger])).toEqual([
      [2, 'snapshot', 'manual'],
      [1, 'version', 'publish'],
    ]);
    expect(list[1]).toMatchObject({ note: 'first', hasData: false, fileCount: 1 });
    const file = await snaps.appSnapshotFile(owner, id, snap!.id);
    expect(file && existsSync(file.path)).toBe(true);
  });

  it('restores the data, after an undo snapshot that can restore it back', async () => {
    const id = await publishedApp('data');
    const before = await snaps.createAppSnapshot(owner, id);
    await broker.appDbExec(owner, id, "INSERT INTO items (name) VALUES ('b')", [], schema);
    expect(await names(id)).toEqual(['a', 'b']);

    const res = await snaps.restoreAppSnapshot(owner, id, before!.id, { mode: 'data', drainMs: 0 });
    expect(res).toMatchObject({ mode: 'data', code: null });
    expect(await names(id)).toEqual(['a']);

    // The undo snapshot holds the 'b' row: restoring it brings it back.
    await snaps.restoreAppSnapshot(owner, id, res!.undo!.id, { mode: 'data', drainMs: 0 });
    expect(await names(id)).toEqual(['a', 'b']);
  });

  it('restores the data when the live file is lost; the undo keeps the code (audit item 4)', async () => {
    const id = await publishedApp('lost');
    const before = await snaps.createAppSnapshot(owner, id);
    const live = (await broker.appDatabasePath(owner, id))!;
    await broker.removeAppDatabaseFiles(live);
    const quiet = console.error;
    console.error = () => {};
    try {
      const res = await snaps.restoreAppSnapshot(owner, id, before!.id, {
        mode: 'data',
        drainMs: 0,
      });
      expect(res?.undo).toMatchObject({ trigger: 'pre_restore', hasData: false });
      expect(res?.undo?.note).toMatch(/code only/);
    } finally {
      console.error = quiet;
    }
    expect(await names(id)).toEqual(['a']);
  });

  // Team apps follow-up: file side effects follow the transaction they
  // belong to (withSystemTx, a member's app change).
  it('withSystemTx runs afterCommit after the commit and afterRollback on a rollback', async () => {
    const seen: string[] = [];
    await m.withSystemTx(async () => {
      await m.afterCommit(() => seen.push('commit'));
      m.afterRollback(() => seen.push('rollback'));
      seen.push('inside');
    });
    expect(seen).toEqual(['inside', 'commit']);
    seen.length = 0;
    await expect(
      m.withSystemTx(async () => {
        await m.afterCommit(() => seen.push('commit'));
        m.afterRollback(() => seen.push('rollback'));
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(seen).toEqual(['rollback']);
  });

  it('a code restore that rolls back with its transaction leaves no pre_restore copy', async () => {
    const { readdirSync } = await import('node:fs');
    const id = await publishedApp('restore-undo');
    const v1 = (await snaps.listAppSnapshots(owner, id)).find((e) => e.trigger === 'publish');
    const dirOf = path.join(dir, '_snapshots', owner, id);
    const before = existsSync(dirOf) ? readdirSync(dirOf).length : 0;
    await expect(
      m.withSystemTx(async () => {
        await snaps.restoreAppSnapshot(owner, id, v1!.id, { mode: 'code', discardDraft: true });
        throw new Error('the caller failed after the restore');
      }),
    ).rejects.toThrow(/after the restore/);
    // The pre_restore row rolled back, and its database copy with it.
    expect(existsSync(dirOf) ? readdirSync(dirOf).length : 0).toBe(before);
    // Outside a transaction the copy stays: it is the way back.
    const res = await snaps.restoreAppSnapshot(owner, id, v1!.id, {
      mode: 'code',
      discardDraft: true,
    });
    expect(res?.undo?.hasData).toBe(true);
    expect(readdirSync(dirOf).length).toBe(before + 1);
  });

  it('a snapshot taken in a transaction that rolls back leaves no copy', async () => {
    const id = await publishedApp('copy-undo');
    let file: string | null = null;
    await expect(
      m.withSystemTx(async () => {
        const snap = await snaps.createAppSnapshot(owner, id, { note: 'gone' });
        file = (await snaps.appSnapshotFile(owner, id, snap!.id))!.path;
        expect(existsSync(file)).toBe(true);
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect(file && existsSync(file)).toBe(false);
  });

  it('a code restore goes to the draft, and the next publish says where it came from', async () => {
    const id = await publishedApp('code');
    await apps.writeDraftFile(owner, id, 'App.tsx', 'export default () => "two";');
    await apps.setDraftBuild(owner, id, GREEN);
    await apps.publishApp(owner, id);
    const v1 = (await snaps.listAppSnapshots(owner, id)).find((e) => e.seq === 1)!;

    await apps.writeDraftFile(owner, id, 'App.tsx', 'export default () => "wip";');
    await expect(
      snaps.restoreAppSnapshot(owner, id, v1.id, { mode: 'code', drainMs: 0 }),
    ).rejects.toBeInstanceOf(apps.AppRestoreDraftError);

    const res = await snaps.restoreAppSnapshot(owner, id, v1.id, {
      mode: 'code',
      discardDraft: true,
      drainMs: 0,
    });
    expect(res?.code).toBe('draft');
    const detail = await apps.getApp(owner, id);
    expect(detail?.draft?.files['App.tsx']).toContain('"one"');
    expect(detail?.source.files['App.tsx']).toContain('"two"');

    await apps.setDraftBuild(owner, id, GREEN);
    await apps.publishApp(owner, id);
    const top = (await snaps.listAppSnapshots(owner, id))[0]!;
    expect(top).toMatchObject({ kind: 'version', restoredFrom: 1 });
  });

  it('a code restore leaves the live tools alone and names the old ones (audit item 9)', async () => {
    const id = await publishedApp('tools');
    await apps.setManifest(owner, id, { toolSlugs: ['web_fetch'] });
    const old = await snaps.createAppSnapshot(owner, id);
    await apps.setManifest(owner, id, { toolSlugs: [] });
    const res = await snaps.restoreAppSnapshot(owner, id, old!.id, { mode: 'code', drainMs: 0 });
    expect(res).toMatchObject({ code: 'draft', declaredTools: ['web_fetch'] });
    expect((await apps.getAppRuntime(owner, id))?.manifest.toolSlugs).toEqual([]);
  });

  it('a full restore brings back the draft the snapshot held (audit, low)', async () => {
    const id = await publishedApp('full-draft');
    await apps.writeDraftFile(owner, id, 'App.tsx', 'export default () => "wip";');
    const snap = await snaps.createAppSnapshot(owner, id);
    await apps.discardDraft(owner, id);
    const res = await snaps.restoreAppSnapshot(owner, id, snap!.id, { mode: 'full', drainMs: 0 });
    expect(res?.code).toBe('live');
    const detail = await apps.getApp(owner, id);
    expect(detail?.source.files['App.tsx']).toContain('"one"');
    expect(detail?.draft?.files['App.tsx']).toContain('"wip"');
  });

  it('a full restore puts the code live with the data, as a new version', async () => {
    const id = await publishedApp('full');
    const snap = await snaps.createAppSnapshot(owner, id);
    await apps.writeDraftFile(owner, id, 'App.tsx', 'export default () => "two";');
    await apps.setDraftBuild(owner, id, GREEN);
    await apps.publishApp(owner, id);
    await broker.appDbExec(owner, id, "INSERT INTO items (name) VALUES ('c')", [], schema);

    const res = await snaps.restoreAppSnapshot(owner, id, snap!.id, { mode: 'full', drainMs: 0 });
    expect(res?.code).toBe('live');
    expect((await apps.getApp(owner, id))?.source.files['App.tsx']).toContain('"one"');
    expect(await names(id)).toEqual(['a']);
    const top = (await snaps.listAppSnapshots(owner, id))[0]!;
    expect(top).toMatchObject({
      kind: 'version',
      restoredFrom: snap!.seq,
      note: `restored v${snap!.seq}`,
    });
  });

  it('refuses a data restore from a version, and deleting a version', async () => {
    const id = await publishedApp('refusals');
    const v1 = (await snaps.listAppSnapshots(owner, id))[0]!;
    await expect(
      snaps.restoreAppSnapshot(owner, id, v1.id, { mode: 'data', drainMs: 0 }),
    ).rejects.toThrow(/holds no data/);
    await expect(snaps.deleteAppSnapshot(owner, id, v1.id)).rejects.toThrow(/stays/);
    const snap = await snaps.createAppSnapshot(owner, id);
    const file = (await snaps.appSnapshotFile(owner, id, snap!.id))!.path;
    expect(await snaps.deleteAppSnapshot(owner, id, snap!.id)).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it('keeps the newest automatic snapshots only; the owner’s stay', async () => {
    const id = await publishedApp('prune');
    const mine = await snaps.createAppSnapshot(owner, id, { note: 'mine' });
    for (let i = 0; i < snaps.APP_SNAPSHOT_AUTO_KEEP + 2; i++) {
      await snaps.createAppSnapshot(owner, id, { trigger: 'pre_schema', actor: 'agent' });
    }
    const list = await snaps.listAppSnapshots(owner, id, { limit: 500 });
    expect(list.filter((e) => e.trigger === 'pre_schema')).toHaveLength(
      snaps.APP_SNAPSHOT_AUTO_KEEP,
    );
    expect(list.some((e) => e.id === mine!.id)).toBe(true);
    // requireData: an app with no database file yet takes no automatic one.
    const empty = await apps.createApp(owner, { title: `${tag} empty` });
    expect(
      await snaps.createAppSnapshot(owner, empty.id, { trigger: 'pre_schema', requireData: true }),
    ).toBeNull();
  });

  it('a prune never removes a snapshot taken while it runs (audit item 3)', async () => {
    const id = await publishedApp('prune-race');
    for (let i = 0; i < snaps.APP_SNAPSHOT_AUTO_KEEP; i++) {
      await snaps.createAppSnapshot(owner, id, { trigger: 'pre_schema', actor: 'agent' });
    }
    // Several at once, each pruning after itself; the pre_delete among them
    // (what the trash restores from) must survive every prune.
    const made = await Promise.all([
      ...Array.from({ length: 5 }, () =>
        snaps.createAppSnapshot(owner, id, { trigger: 'pre_schema', actor: 'agent' }),
      ),
      snaps.createAppSnapshot(owner, id, { trigger: 'pre_delete', actor: 'owner' }),
    ]);
    const list = await snaps.listAppSnapshots(owner, id, { limit: 500 });
    const auto = list.filter((e) => e.trigger !== 'publish');
    expect(auto).toHaveLength(snaps.APP_SNAPSHOT_AUTO_KEEP);
    for (const s of made)
      expect(
        auto.some((e) => e.id === s!.id),
        s!.trigger,
      ).toBe(true);
    // Every kept row has its file; no removed row left one behind.
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(path.join(dir, '_snapshots', owner, id))).toHaveLength(auto.length);
  });

  it('pre_mcp_write snapshots are their own line: they never push out the others (M1 audit, medium 2)', async () => {
    const id = await publishedApp('mcp line');
    const nightly = await snaps.createAppSnapshot(owner, id, {
      trigger: 'nightly',
      actor: 'system',
    });
    const schemaOne = await snaps.createAppSnapshot(owner, id, {
      trigger: 'pre_schema',
      actor: 'agent',
    });
    for (let i = 0; i < snaps.APP_SNAPSHOT_MCP_KEEP + 6; i++) {
      await snaps.createAppSnapshot(owner, id, { trigger: 'pre_mcp_write', actor: 'mcp' });
    }
    const list = await snaps.listAppSnapshots(owner, id, { limit: 500 });
    expect(list.filter((e) => e.trigger === 'pre_mcp_write')).toHaveLength(
      snaps.APP_SNAPSHOT_MCP_KEEP,
    );
    expect(list.some((e) => e.id === nightly!.id)).toBe(true);
    expect(list.some((e) => e.id === schemaOne!.id)).toBe(true);
    // And the hourly rule: one per window, checked under the lock.
    const since = new Date(Date.now() - 60_000);
    const again = await snaps.createAppSnapshot(owner, id, {
      trigger: 'pre_mcp_write',
      actor: 'mcp',
      onlyIfNoneSince: since,
    });
    expect(again).toBeNull();
  });

  it('automatic snapshots stay within APP_SNAPSHOT_AUTO_MAX_MB; the newest always stays (audit item 11)', async () => {
    const id = await publishedApp('budget');
    await broker.appDbExec(
      owner,
      id,
      'INSERT INTO items (name) VALUES (?)',
      ['x'.repeat(400_000)],
      schema,
    );
    process.env.APP_SNAPSHOT_AUTO_MAX_MB = '1';
    try {
      for (let i = 0; i < 4; i++) {
        await snaps.createAppSnapshot(owner, id, { trigger: 'pre_schema', actor: 'agent' });
      }
    } finally {
      delete process.env.APP_SNAPSHOT_AUTO_MAX_MB;
    }
    const auto = (await snaps.listAppSnapshots(owner, id)).filter(
      (e) => e.trigger === 'pre_schema',
    );
    expect(auto).toHaveLength(2);
    expect(auto.reduce((n, e) => n + (e.dbBytes ?? 0), 0)).toBeLessThanOrEqual(1024 * 1024);
  });

  it('the manual budget counts the owner’s own manual snapshots only (L22, N7)', async () => {
    const o = budgetOwner;
    const app = await apps.createApp(o, { title: `${tag} manual budget` });
    await apps.writeDraftFile(o, app.id, 'App.tsx', 'export default () => "one";');
    await apps.setManifest(o, app.id, { sqlite: schema });
    await apps.setDraftBuild(o, app.id, GREEN);
    await apps.publishApp(o, app.id, { actor: 'owner' });
    // A copy of this database is over 1 MB: one copy fills a 1 MB budget.
    await broker.appDbExec(
      o,
      app.id,
      'INSERT INTO items (name) VALUES (?)',
      ['x'.repeat(1_200_000)],
      schema,
    );
    process.env.APP_SNAPSHOT_MAX_MB = '1';
    try {
      // A member-era manual snapshot (an Accept moves these in with the
      // app), an automatic one before a schema change and an MCP undo one.
      await snaps.createAppSnapshot(o, app.id, { actor: 'member', note: 'member era' });
      await snaps.createAppSnapshot(o, app.id, { trigger: 'pre_schema', actor: 'agent' });
      await snaps.createAppSnapshot(o, app.id, { trigger: 'pre_mcp_write', actor: 'mcp' });
      // None of them counts against the admin's Take snapshot.
      const own = await snaps.createAppSnapshot(o, app.id, { note: 'admin' });
      expect(own).toMatchObject({ trigger: 'manual', hasData: true });
      // The admin's own copies still do.
      await expect(snaps.createAppSnapshot(o, app.id)).rejects.toBeInstanceOf(
        snaps.AppSnapshotBudgetError,
      );
      // A member's budget counts members' copies, and says what frees it.
      await expect(snaps.createAppSnapshot(o, app.id, { actor: 'member' })).rejects.toThrow(
        /cannot delete snapshots/,
      );
      // Per member login (audit B6): one member's copies never fill another's.
      const [first, second] = members;
      await snaps.createAppSnapshot(o, app.id, { actor: 'member', actorLoginId: first });
      await expect(
        snaps.createAppSnapshot(o, app.id, { actor: 'member', actorLoginId: first }),
      ).rejects.toThrow(/cannot delete snapshots/);
      const other = await snaps.createAppSnapshot(o, app.id, {
        actor: 'member',
        actorLoginId: second,
      });
      expect(other).toMatchObject({ trigger: 'manual' });
    } finally {
      delete process.env.APP_SNAPSHOT_MAX_MB;
    }
  });

  it('a fresh restore marker stops the app’s SQL; a stale one is ignored', async () => {
    const id = await publishedApp('marker');
    const live = (await broker.appDatabasePath(owner, id))!;
    await writeFile(`${live}.restoring`, 'x');
    await expect(broker.appDbQuery(owner, id, 'SELECT 1', [], schema)).rejects.toBeInstanceOf(
      broker.AppDbRestoringError,
    );
    const { utimes } = await import('node:fs/promises');
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(`${live}.restoring`, old, old);
    expect(await names(id)).toEqual(['a']);
    expect(existsSync(`${live}.restoring`)).toBe(false);
  });

  it('a deleted app waits in the trash and comes back with its id, code and data (Phase 3)', async () => {
    const trash = await import('./app-trash');
    const id = await publishedApp('trash');
    const snap = await snaps.createAppSnapshot(owner, id);
    const kept = (await snaps.appSnapshotFile(owner, id, snap!.id))!.path;
    await apps.deleteApp(owner, id);
    expect(await apps.getApp(owner, id)).toBeNull();
    // The history and its files outlive the app.
    expect(existsSync(kept)).toBe(true);
    const listed = (await trash.listDeletedApps(owner)).find((d) => d.id === id);
    expect(listed).toMatchObject({ title: `${tag} trash`, hasData: true });

    const back = await trash.restoreDeletedApp(owner, id);
    expect(back).toEqual({ id, title: `${tag} trash` });
    expect((await apps.getApp(owner, id))?.source.files['App.tsx']).toContain('"one"');
    expect(await names(id)).toEqual(['a']);
    expect((await trash.listDeletedApps(owner)).some((d) => d.id === id)).toBe(false);
    // The history line carries on: the restore is its newest version.
    expect((await snaps.listAppSnapshots(owner, id))[0]).toMatchObject({ kind: 'version' });
    await expect(trash.restoreDeletedApp(owner, id)).rejects.toThrow(/not deleted/);
  });

  it('purges a deleted app for good: now on request, or after the 30 days', async () => {
    const trash = await import('./app-trash');
    const a = await publishedApp('purge-now');
    const b = await publishedApp('purge-later');
    await apps.deleteApp(owner, a);
    await apps.deleteApp(owner, b);
    expect(await trash.purgeDeletedApp(owner, a)).toBe(true);
    expect(await snaps.listAppSnapshots(owner, a)).toEqual([]);
    expect(existsSync(path.join(dir, '_snapshots', owner, a))).toBe(false);

    const later = new Date(Date.now() + (trash.APP_TRASH_DAYS + 1) * 86_400_000);
    expect(
      (await trash.purgeExpiredDeletedApps({ dryRun: true, now: later })).apps,
    ).toBeGreaterThan(0);
    await trash.purgeExpiredDeletedApps({ now: later });
    expect(await snaps.listAppSnapshots(owner, b)).toEqual([]);
    expect(await trash.restoreDeletedApp(owner, b)).toBeNull();
  });
});
