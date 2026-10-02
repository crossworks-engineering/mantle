/**
 * Table history on Postgres (apps first-class plan, Phase 4; migration 0222):
 * a commit keeps the published workbook it replaces; a restore puts an entry
 * into the draft (refused over a draft unless asked), and the commit after it
 * brings the data back and keeps what it replaced; a manual snapshot is never
 * pruned, commit entries keep the newest TABLE_SNAPSHOT_COMMIT_KEEP within
 * TABLE_HISTORY_MAX_MB; a
 * deleted table's history goes after 30 days. Seeds its own owner and tables
 * on random ids; removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/table-snapshots.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableDocFromGrid } from '@mantle/content-core/table-model';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('table history on Postgres', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let admin: Parameters<Db['ensureViewerRoles']>[0];
  let tables: typeof import('./tables');
  let hist: typeof import('./table-snapshots');
  let dir = '';
  const owner = randomUUID();
  const tag = owner.slice(0, 8);

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    dir = await mkdtemp(path.join(tmpdir(), 'table-history-db-'));
    process.env.TABLE_DB_DIR = dir;
    m = await import('@mantle/db');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    tables = await import('./tables');
    hist = await import('./table-snapshots');
    await admin`insert into auth.users (id, email, password_hash, role) values
      (${owner}, ${`th-${tag}@example.invalid`}, 'x', 'admin')`;
    await admin`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`;
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from node_snapshots where owner_id = ${owner}`;
    await admin`delete from nodes where owner_id = ${owner}`;
    await admin`delete from spaces where login_id = ${owner}`;
    await admin`delete from auth.users where id = ${owner}`;
    await m.closeDb();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const grid = (...names: string[]) =>
    tableDocFromGrid({ columns: [{ name: 'Item', type: 'text' }], rows: names.map((n) => [n]) });

  /** A file-backed table published with `names`. */
  async function tableWith(title: string, ...names: string[]) {
    const t = await tables.createTable(owner, {
      title: `${tag} ${title}`,
      tabs: [{ ...grid(...names), name: 'Sheet1' }],
    });
    return t.id;
  }
  async function commitWith(id: string, ...names: string[]) {
    await tables.saveTableDraft(
      owner,
      id,
      { tabs: [{ ...grid(...names), name: 'Sheet1' }] },
      { replace: true },
    );
    await tables.commitTable(owner, id, undefined, {
      actor: 'agent',
      note: `to ${names.join('+')}`,
    });
  }
  async function published(id: string): Promise<string[]> {
    const t = await tables.getTable(owner, id);
    const col = t!.data.columns[0]!.id;
    return t!.data.rows.map((r) => String(r.cells[col] ?? ''));
  }

  it('a commit keeps the published table it replaces', async () => {
    const id = await tableWith('keep', 'a');
    expect(await hist.listTableSnapshots(owner, id)).toEqual([]);
    await commitWith(id, 'a', 'b');
    const [entry] = await hist.listTableSnapshots(owner, id);
    expect(entry).toMatchObject({ seq: 1, trigger: 'commit', actor: 'agent', note: 'to a+b' });
    expect(entry!.bytes).toBeGreaterThan(0);
    const file = await hist.tableSnapshotFile(owner, id, entry!.id);
    expect(file && existsSync(file.path)).toBe(true);
    expect(await published(id)).toEqual(['a', 'b']);
  });

  it('restores an entry into the draft; the commit brings it back and keeps what it replaced', async () => {
    const id = await tableWith('restore', 'one');
    await commitWith(id, 'two');
    await commitWith(id, 'three');
    const entries = await hist.listTableSnapshots(owner, id);
    const v1 = entries.find((e) => e.seq === 1)!; // holds 'one'

    // A draft in the way is refused, and nothing changes.
    await tables.saveTableDraft(
      owner,
      id,
      { tabs: [{ ...grid('wip'), name: 'Sheet1' }] },
      { replace: true },
    );
    await expect(hist.restoreTableSnapshot(owner, id, v1.id)).rejects.toBeInstanceOf(
      hist.TableRestoreDraftError,
    );

    expect(await hist.restoreTableSnapshot(owner, id, v1.id, { discardDraft: true })).toMatchObject(
      {
        restored: { seq: 1 },
      },
    );
    expect(await published(id)).toEqual(['three']); // the draft only, so far
    await tables.commitTable(owner, id, undefined, { note: 'restoring v1' });
    expect(await published(id)).toEqual(['one']);
    const after = await hist.listTableSnapshots(owner, id);
    expect(after[0]).toMatchObject({ seq: 3, trigger: 'commit', note: 'restoring v1' });
    // …and that entry holds 'three', so the restore can be undone.
    await hist.restoreTableSnapshot(owner, id, after[0]!.id);
    await tables.commitTable(owner, id);
    expect(await published(id)).toEqual(['three']);
  });

  it('a manual snapshot stays; commit entries keep the newest 20; delete removes the file', async () => {
    const id = await tableWith('prune', 'v0');
    const manual = await hist.createTableSnapshot(owner, id, { note: 'pin' });
    expect(manual).toMatchObject({ seq: 1, trigger: 'manual', note: 'pin' });
    for (let i = 1; i <= hist.TABLE_SNAPSHOT_COMMIT_KEEP + 2; i++) await commitWith(id, `v${i}`);
    const entries = await hist.listTableSnapshots(owner, id, { limit: 500 });
    expect(entries.filter((e) => e.trigger === 'commit')).toHaveLength(
      hist.TABLE_SNAPSHOT_COMMIT_KEEP,
    );
    expect(entries.find((e) => e.trigger === 'manual')?.id).toBe(manual!.id);
    const dirFiles = path.join(dir, '_snapshots', owner, id);
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(dirFiles)).toHaveLength(hist.TABLE_SNAPSHOT_COMMIT_KEEP + 1);

    const file = await hist.tableSnapshotFile(owner, id, manual!.id);
    expect(await hist.deleteTableSnapshot(owner, id, manual!.id)).toBe(true);
    expect(existsSync(file!.path)).toBe(false);
    expect(await hist.deleteTableSnapshot(owner, id, manual!.id)).toBe(false);
  });

  it('commit entries also stay within TABLE_HISTORY_MAX_MB; the newest always stays (audit item 5)', async () => {
    const id = await tableWith('budget', 'small');
    const big = (n: number) => `${n}`.padEnd(400_000, 'x');
    process.env.TABLE_HISTORY_MAX_MB = '1';
    try {
      for (let i = 1; i <= 4; i++) await commitWith(id, big(i));
    } finally {
      delete process.env.TABLE_HISTORY_MAX_MB;
    }
    const commits = (await hist.listTableSnapshots(owner, id)).filter(
      (e) => e.trigger === 'commit',
    );
    // Newest first: 400 KB, 800 KB, then past 1 MB. Two stay, files with them.
    expect(commits).toHaveLength(2);
    expect(commits.reduce((n, e) => n + (e.bytes ?? 0), 0)).toBeLessThanOrEqual(1024 * 1024);
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(path.join(dir, '_snapshots', owner, id))).toHaveLength(2);
  });

  it("a deleted table's history goes 30 days later", async () => {
    const id = await tableWith('gone', 'x');
    await commitWith(id, 'y');
    await admin`delete from nodes where id = ${id}`;
    expect(await hist.purgeOrphanTableHistory({ dryRun: true })).toEqual({ tables: 0 });
    await admin`update node_snapshots set created_at = now() - interval '31 days' where node_id = ${id}`;
    const r = await hist.purgeOrphanTableHistory();
    expect(r.tables).toBeGreaterThanOrEqual(1);
    expect(await admin`select 1 from node_snapshots where node_id = ${id}`).toHaveLength(0);
    expect(existsSync(path.join(dir, '_snapshots', owner, id))).toBe(false);
  });
});
