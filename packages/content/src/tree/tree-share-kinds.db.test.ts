/**
 * Every live tree kind against the database's own share rule: a kind the
 * spec calls shareable really takes a share at each of its levels (the CHECK
 * nodes_share_level_ck and the triggers agree with TREE_KIND_SPECS), and a
 * kind that is not is refused as a TreeError, never a 500. Recall shipped
 * shareable in the spec while the database refused it (folder audit Q1);
 * this is the test that would have caught it.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/tree/tree-share-kinds.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TREE_KIND_SPECS, TREE_SHARE_LEVELS } from '@mantle/client-types/tree';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('every tree kind against the share rule', () => {
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
    await m.db.execute(sqlTag`
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

  it('shares what the spec says, at every level it names, and refuses the rest', async () => {
    const live = tree.TREE_LIVE_KINDS;
    expect(live.length).toBeGreaterThan(5);
    for (const kind of live) {
      if (kind === 'files') await files.ensureFilesRootBranch(owner);
      else await tree.ensureKindRoot(owner, kind);
      const f = await tree.createTreeFolder(owner, kind, {
        parentId: null,
        name: `Share ${kind}`,
      });
      const spec = TREE_KIND_SPECS[kind];
      for (const level of TREE_SHARE_LEVELS) {
        const allowed = spec.shareable && (spec.shareLevels ?? TREE_SHARE_LEVELS).includes(level);
        const res = tree.updateTreeFolder(owner, kind, f.id, { share: level }, { confirm: true });
        if (allowed) {
          await expect(res, `${kind} at ${level}`).resolves.toMatchObject({ share: level });
        } else {
          await expect(res, `${kind} at ${level}`).rejects.toMatchObject({
            name: 'TreeError',
            code: 'invalid',
          });
        }
      }
      if (spec.shareable) {
        await tree.updateTreeFolder(owner, kind, f.id, { share: null }, { confirm: true });
      }
    }
  });
});
