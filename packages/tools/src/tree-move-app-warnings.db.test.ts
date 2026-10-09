/**
 * Filing an app into another folder warns about its tools (access matrix
 * N11), on a real migrated Postgres. A folder shared with clients sets the
 * level an app is used at (M5), so moving an admin app into one makes its
 * runs use the client rules, an admin's too: a declared tool those rules
 * refuse now fails for every runner. `tree_item_move` says so, as
 * `app_tools_set`, `app_publish` and `access_set` do; a move that changes
 * nothing for the app's tools warns nothing.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/tools/src/tree-move-app-warnings.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('moving an app into a client-shared folder', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let tree: typeof import('@mantle/content/tree');
  let builtins: typeof import('./builtins');
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const tag = `tree-app-warn-${owner.slice(0, 8)}`;
  const appId = randomUUID();
  let clientFolder = '';
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
    await exec(sqlTag`
      insert into auth.users (id, email, password_hash, role)
      values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await exec(
      sqlTag`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`,
    );
    await tree.ensureKindRoot(owner, 'apps');
    const client = await tree.createTreeFolder(owner, 'apps', { parentId: null, name: 'Client' });
    await tree.updateTreeFolder(owner, 'apps', client.id, { share: 'client' }, { confirm: true });
    clientFolder = client.id;
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

  it('a move into a client-shared folder names the tool its runs now refuse', async () => {
    const res = await move(clientFolder);
    expect(res).toMatchObject({ ok: true, output: { moved: 1 } });
    const warnings = (res as { output: { warnings?: string[] } }).output.warnings ?? [];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/note_create/);
    expect(warnings[0]).toMatch(/client rules/);
  });
});
