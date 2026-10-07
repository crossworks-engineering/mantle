/**
 * New bytes for an existing file leave nothing of the old version for an
 * agent to find: not the summary or embedding, not the passages, not a
 * "migrated" mark that sends search to a page made from the old bytes. What
 * the bytes do not decide stays, above all the `indexing: 'metadata'`
 * privacy flag (an editor save used to drop it). Both write paths: upload /
 * editor (`upsertFile`) and the disk watcher (`syncFileFromDisk`).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/files/src/content-change.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('a file whose bytes change drops its old index', () => {
  type Db = typeof import('@mantle/db');
  type Ops = typeof import('./ops');
  let m: Db;
  let ops: Ops;
  let sqlTag: typeof import('drizzle-orm').sql;
  let root: string;
  let prevRoot: string | undefined;
  let pageId: string;
  const owner = randomUUID();
  const tag = `cc-test-${owner.slice(0, 8)}`;
  const top = `files.${tag.replace(/-/g, '_')}`;

  type Row = {
    data: Record<string, unknown>;
    has_embedding: boolean;
    superseded_by: string | null;
    superseded_reason: string | null;
    salience: number;
    chunks: number;
  };
  const rowOf = async (id: string): Promise<Row> => {
    const [row] = (await m.db.execute(sqlTag`
      select data, embedding is not null as has_embedding, superseded_by,
             superseded_reason, salience,
             (select count(*)::int from content_chunks c where c.node_id = n.id) as chunks
      from nodes n where id = ${id}`)) as unknown as Row[];
    return row!;
  };

  /** What one extract (plus a page_from_file) leaves on a file node. */
  const indexAndMigrate = async (id: string) => {
    await m.db.execute(sqlTag`
      update nodes set
        data = data || '{"indexing":"metadata","summary":"Old plan.","entities":["Old Co"],
                         "text":"old text","extract_completed_at":"2026-10-01",
                         "indexing_applied":"metadata"}'::jsonb,
        embedding = array_fill(0.1::real, array[768])::vector,
        superseded_by = ${pageId}, superseded_reason = 'migrated', salience = 0.6
      where id = ${id}`);
    await m.db.execute(sqlTag`
      insert into content_chunks (owner_id, node_id, ordinal, text)
      values (${owner}, ${id}, 0, 'an old passage')`);
  };

  const expectOldIndexGone = (row: Row) => {
    expect(row.data.indexing).toBe('metadata');
    for (const key of ['summary', 'entities', 'text', 'extract_completed_at', 'indexing_applied']) {
      expect(row.data).not.toHaveProperty(key);
    }
    expect(row.has_embedding).toBe(false);
    expect(row.chunks).toBe(0);
    expect(row.superseded_by).toBeNull();
    expect(row.superseded_reason).toBeNull();
    expect(row.salience).toBe(1);
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    prevRoot = process.env.MANTLE_FILES_ROOT;
    root = await mkdtemp(path.join(tmpdir(), 'mantle-cc-'));
    process.env.MANTLE_FILES_ROOT = root;
    m = await import('@mantle/db');
    ops = await import('./ops');
    sqlTag = (await import('drizzle-orm')).sql;
    await m.db.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role) values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`);
    await m.db.execute(sqlTag`
      insert into nodes (owner_id, type, title, slug, path) values
        (${owner}, 'branch', 'files', 'files', 'files'),
        (${owner}, 'branch', ${tag}, ${tag}, ${top}::ltree)
      on conflict do nothing`);
    const [page] = (await m.db.execute(sqlTag`
      insert into nodes (owner_id, type, title, path)
      values (${owner}, 'note', 'The page copy', 'notes'::ltree)
      returning id`)) as unknown as { id: string }[];
    pageId = page!.id;
  }, 60_000);

  afterAll(async () => {
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
    if (prevRoot === undefined) delete process.env.MANTLE_FILES_ROOT;
    else process.env.MANTLE_FILES_ROOT = prevRoot;
    await rm(root, { recursive: true, force: true });
  });

  it('an upload without replace is still refused when the name is taken', async () => {
    await ops.upsertFile({
      ownerId: owner,
      parentPath: top,
      filename: 'taken.md',
      bytes: Buffer.from('v1'),
    });
    await expect(
      ops.upsertFile({
        ownerId: owner,
        parentPath: top,
        filename: 'taken.md',
        bytes: Buffer.from('v2'),
      }),
    ).rejects.toThrow(/already exists/);
  });

  it('a replace keeps the node and its privacy flag, and drops the old index', async () => {
    const v1 = await ops.upsertFile({
      ownerId: owner,
      parentPath: top,
      filename: 'plan.md',
      bytes: Buffer.from('plan v1'),
    });
    await indexAndMigrate(v1.id);
    const v2 = await ops.upsertFile({
      ownerId: owner,
      parentPath: top,
      filename: 'plan.md',
      bytes: Buffer.from('plan v2, revised'),
      overwrite: true,
    });
    expect(v2.id).toBe(v1.id);
    const row = await rowOf(v1.id);
    expect(row.data.content).toBe('plan v2, revised');
    expectOldIndexGone(row);
  });

  it('a save with the same bytes keeps the index as it is', async () => {
    const v1 = await ops.upsertFile({
      ownerId: owner,
      parentPath: top,
      filename: 'same.md',
      bytes: Buffer.from('unchanged'),
    });
    await indexAndMigrate(v1.id);
    await ops.upsertFile({
      ownerId: owner,
      parentPath: top,
      filename: 'same.md',
      bytes: Buffer.from('unchanged'),
      overwrite: true,
    });
    const row = await rowOf(v1.id);
    expect(row.data).toMatchObject({ summary: 'Old plan.', indexing: 'metadata' });
    expect(row.has_embedding).toBe(true);
    expect(row.chunks).toBe(1);
    expect(row.superseded_reason).toBe('migrated');
  });

  it('the disk watcher drops the old index the same way', async () => {
    const first = await ops.syncFileFromDisk({
      ownerId: owner,
      parentPath: top,
      filename: 'watched.md',
      bytes: Buffer.from('watched v1'),
    });
    await indexAndMigrate(first.nodeId!);
    const next = await ops.syncFileFromDisk({
      ownerId: owner,
      parentPath: top,
      filename: 'watched.md',
      bytes: Buffer.from('watched v2, edited on disk'),
    });
    expect(next).toEqual({ status: 'updated', nodeId: first.nodeId });
    expectOldIndexGone(await rowOf(first.nodeId!));
  });

  it('a version or corrected mark is a person’s call and stays', async () => {
    const v1 = await ops.upsertFile({
      ownerId: owner,
      parentPath: top,
      filename: 'old-version.md',
      bytes: Buffer.from('old'),
    });
    await m.db.execute(sqlTag`
      update nodes set superseded_by = ${pageId}, superseded_reason = 'corrected', salience = 0.3
      where id = ${v1.id}`);
    await ops.upsertFile({
      ownerId: owner,
      parentPath: top,
      filename: 'old-version.md',
      bytes: Buffer.from('old, touched'),
      overwrite: true,
    });
    const row = await rowOf(v1.id);
    expect(row.superseded_reason).toBe('corrected');
    expect(row.salience).toBeCloseTo(0.3);
  });
});
