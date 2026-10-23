/**
 * Filing an app into another folder warns about its tools only when the move
 * changes the rules its runs use (access matrix N11), on a real migrated
 * Postgres: a move that changes nothing for the app's tools warns nothing.
 * (A folder shared with clients set the level an app was used at until
 * W5b2; folder shares are gone, so that warning has no move to follow.)
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/tools/src/tree-move-app-warnings.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asSuperuser } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('moving an app between folders', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let tree: typeof import('@mantle/content/tree');
  let builtins: typeof import('./builtins');
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const tag = `tree-app-warn-${owner.slice(0, 8)}`;
  const appId = randomUUID();
  let plainFolder = '';

  const exec = (q: ReturnType<typeof sqlTag>) => m.systemDb.execute(q);
  const move = async (folderId: string | null) => {
    const def = builtins.BUILTIN_TOOLS.find((t) => t.slug === 'tree_item_move');
    if (!def) throw new Error('tree_item_move is not a builtin any more');
    return def.handler(
      { kind: 'apps', item_ids: [appId], folder_id: folderId, confirm: true },
      { ownerId: owner, surface: { kind: 'web' } },
    );
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    tree = await import('@mantle/content/tree');
    builtins = await import('./builtins');
    sqlTag = (await import('drizzle-orm')).sql;
    await asSuperuser()(sqlTag`
      insert into auth.users (id, email, password_hash, role)
      values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await exec(
      sqlTag`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`,
    );
    await tree.ensureKindRoot(owner, 'apps');
    plainFolder = (await tree.createTreeFolder(owner, 'apps', { parentId: null, name: 'Plain' }))
      .id;
    // An admin app that declares a built-in write tool: fine at admin, never
    // on the client rules.
    await exec(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience)
      values (${appId}, ${owner}, 'app', ${`${tag} app`}, 'apps', 'admin')`);
    await exec(sqlTag`
      insert into apps (node_id, manifest)
      values (${appId}, ${JSON.stringify({ toolSlugs: ['note_create'] })}::jsonb)`);
  }, 60_000);

  afterAll(async () => {
    if (!m) return;
    await exec(sqlTag`delete from nodes where owner_id = ${owner}`);
    await exec(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await exec(sqlTag`delete from auth.users where id = ${owner}`);
    await m.closeDb();
  }, 60_000);

  it('a move into a plain folder warns nothing', async () => {
    const res = await move(plainFolder);
    expect(res).toMatchObject({ ok: true, output: { moved: 1 } });
    expect((res as { output: { warnings?: string[] } }).output.warnings).toBeUndefined();
  });
});
