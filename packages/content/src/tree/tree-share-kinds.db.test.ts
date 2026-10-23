/**
 * Every live tree kind refuses a folder share since workspaces W5b2 (a
 * folder share is a grant, set in Grant Access): any `share` in the patch,
 * a level or null, answers a TreeError `gone` (410 on the route), never a
 * 500, and the folder's share stays as it was.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/tree/tree-share-kinds.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TREE_SHARE_LEVELS } from '@mantle/client-types/tree';
import { asSuperuser } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('every tree kind refuses a folder share', () => {
  let m: typeof import('@mantle/db');
  let tree: typeof import('./index');
  let files: typeof import('@mantle/files');
  let sqlTag: typeof import('drizzle-orm').sql;
  let root: string;
  let prevRoot: string | undefined;
  const owner = randomUUID();

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    prevRoot = process.env.MANTLE_FILES_ROOT;
    root = await mkdtemp(path.join(tmpdir(), 'mantle-sharekinds-'));
    process.env.MANTLE_FILES_ROOT = root;
    m = await import('@mantle/db');
    tree = await import('./index');
    files = await import('@mantle/files');
    sqlTag = (await import('drizzle-orm')).sql;
    await asSuperuser()(sqlTag`
      insert into auth.users (id, email, password_hash, role)
      values (${owner}, ${`sharekinds-${owner.slice(0, 8)}@example.invalid`}, 'x', 'admin')`);
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`);
  }, 60_000);

  afterAll(async () => {
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
    if (prevRoot === undefined) delete process.env.MANTLE_FILES_ROOT;
    else process.env.MANTLE_FILES_ROOT = prevRoot;
    await rm(root, { recursive: true, force: true });
  });

  it('answers gone for a share at every level, and for null', async () => {
    const live = tree.TREE_LIVE_KINDS;
    expect(live.length).toBeGreaterThan(5);
    for (const kind of live) {
      if (kind === 'files') await files.ensureFilesRootBranch(owner);
      else await tree.ensureKindRoot(owner, kind);
      const f = await tree.createTreeFolder(owner, kind, {
        parentId: null,
        name: `Share ${kind}`,
      });
      for (const share of [...TREE_SHARE_LEVELS, null]) {
        await expect(
          tree.updateTreeFolder(owner, kind, f.id, { share }, { confirm: true }),
          `${kind} at ${share}`,
        ).rejects.toMatchObject({ name: 'TreeError', code: 'gone' });
      }
      const [row] = (await m.db.execute(
        sqlTag`select share_level from nodes where id = ${f.id}`,
      )) as unknown as { share_level: string | null }[];
      expect(row?.share_level ?? null, kind).toBeNull();
    }
  });
});
