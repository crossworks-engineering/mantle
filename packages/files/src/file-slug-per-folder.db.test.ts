/**
 * A file name is unique per FOLDER, not per brain (migrations 0184/0185).
 *
 * 2026-09-28: files/church/<name>.md and files/church/sermons/<name>.md (two
 * different sermons) could not both be nodes. The watcher's INSERT hit the
 * owner-wide nodes_owner_slug_uq and the second file stayed on disk with no
 * node. Against a real, migrated Postgres:
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/files/src/file-slug-per-folder.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('file slugs are unique per folder', () => {
  type Db = typeof import('@mantle/db');
  type Ops = typeof import('./ops');
  let m: Db;
  let ops: Ops;
  let sqlTag: typeof import('drizzle-orm').sql;
  let root: string;
  let prevRoot: string | undefined;
  const owner = randomUUID();
  const tag = `slug-test-${owner.slice(0, 8)}`;
  const top = `files.${tag.replace(/-/g, '_')}`;
  const sub = `${top}.sermons`;
  const other = `${top}.other`;
  const name = 'the-tree-of-knowledge.md';

  const fileRows = async (filename: string) =>
    (await m.db.execute(sqlTag`
      select id, path::text as path, slug from nodes
      where owner_id = ${owner} and type = 'file' and slug = ${filename}
      order by path`)) as unknown as { id: string; path: string; slug: string }[];

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    prevRoot = process.env.MANTLE_FILES_ROOT;
    root = await mkdtemp(path.join(tmpdir(), 'mantle-slug-'));
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
        (${owner}, 'branch', ${tag}, ${tag}, ${top}::ltree),
        (${owner}, 'branch', 'sermons', 'sermons', ${sub}::ltree),
        (${owner}, 'branch', 'other', 'other', ${other}::ltree)
      on conflict do nothing`);
  });

  afterAll(async () => {
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
    if (prevRoot === undefined) delete process.env.MANTLE_FILES_ROOT;
    else process.env.MANTLE_FILES_ROOT = prevRoot;
    await rm(root, { recursive: true, force: true });
  });

  it('the watcher syncs the same filename in two folders as two nodes', async () => {
    const a = await ops.syncFileFromDisk({
      ownerId: owner,
      parentPath: top,
      filename: name,
      bytes: Buffer.from('sermon one'),
    });
    const b = await ops.syncFileFromDisk({
      ownerId: owner,
      parentPath: sub,
      filename: name,
      bytes: Buffer.from('sermon two, different content'),
    });
    expect(a.status).toBe('inserted');
    expect(b.status).toBe('inserted');
    expect(a.nodeId).not.toBe(b.nodeId);
    expect((await fileRows(name)).map((r) => r.path)).toEqual([top, sub]);
  });

  it('upsertFile (upload, MCP file_upload, copy) takes a name another folder holds', async () => {
    const up = await ops.upsertFile({
      ownerId: owner,
      parentPath: other,
      filename: name,
      bytes: Buffer.from('a third copy'),
    });
    expect(up.id).toBeTruthy();
    expect((await fileRows(name)).map((r) => r.path)).toEqual([top, other, sub]);
  });

  it('the same name twice in ONE folder is still refused by the index', async () => {
    await expect(
      m.db.execute(sqlTag`
        insert into nodes (owner_id, type, title, slug, path)
        values (${owner}, 'file', ${name}, ${name}, ${top}::ltree)`),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('a sync that loses the insert race to another writer is a no-op, not an error', async () => {
    // A row owning (folder, slug) that the watcher's filename lookup cannot
    // see: the shape of an upload that inserted between lookup and insert.
    const raced = 'raced.md';
    const [winner] = (await m.db.execute(sqlTag`
      insert into nodes (owner_id, type, title, slug, path, data)
      values (${owner}, 'file', ${raced}, ${raced}, ${sub}::ltree, '{}'::jsonb)
      returning id`)) as unknown as { id: string }[];
    const res = await ops.syncFileFromDisk({
      ownerId: owner,
      parentPath: sub,
      filename: raced,
      bytes: Buffer.from('bytes'),
    });
    expect(res).toEqual({ status: 'noop', nodeId: winner!.id });
  });

  it('other node types keep the owner-wide slug rule', async () => {
    const slug = `${tag}-note`;
    await m.db.execute(sqlTag`
      insert into nodes (owner_id, type, title, slug, path)
      values (${owner}, 'note', 'n1', ${slug}, 'notes')`);
    await expect(
      m.db.execute(sqlTag`
        insert into nodes (owner_id, type, title, slug, path)
        values (${owner}, 'note', 'n2', ${slug}, 'elsewhere')`),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });
});
