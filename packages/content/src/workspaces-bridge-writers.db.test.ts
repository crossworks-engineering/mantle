/**
 * The writers with the level bridge OFF (workspaces W5b2, migration 0261),
 * with the heads check ON for the database: each still takes its heads
 * first, and none writes a level. A new item gets its home (Admin, or its
 * folder's home) and takes its folder's grant rows (S6); a page save that
 * adds an embed changes no grant; a folder share is refused (`gone`) and
 * writes nothing; and an UPDATE of a level column is refused (55000).
 *
 * Runs on a scratch database of its own (migrated from scratch, dropped
 * after): the workspaces migration and the database-wide heads setting are
 * per database.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/workspaces-bridge-writers.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { teamWorkspaceSql } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Grant = { ws: string; excluded: boolean; home: boolean };

describe.skipIf(!URL)('writers with the bridge off hold their heads (heads check on)', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let sqlTag: typeof import('drizzle-orm').sql;
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-bridge-writers-'));
  const brain = randomUUID();
  const files: Record<string, string> = {};
  let team = '';
  let admin = '';

  const rows = async <T>(q: ReturnType<typeof import('drizzle-orm').sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const grants = async (id: string): Promise<Record<string, Grant>> => {
    const r = await rows<Grant & { name: string }>(sqlTag`
      select w.name, g.workspace_id::text as ws, g.excluded, g.is_home as home
        from item_grants g join workspaces w on w.id = g.workspace_id where g.node_id = ${id}`);
    return Object.fromEntries(r.map(({ name, ...g }) => [name, g]));
  };
  /** Whether Team reads the item (a Team row that is not "removed here"). */
  const teamReads = async (id: string) => {
    const g = await grants(id);
    return !!g.Team && !g.Team.excluded;
  };
  const misses = async () =>
    Number(
      (
        await rows<{ n: number }>(sqlTag`select count(*)::int as n from heads_check_misses
        where check_name <> 'bypass'`)
      )[0]!.n,
    );
  /** A file node row (no bytes), made with its folder's heads as a writer. */
  const file = async (key: string) => {
    const id = randomUUID();
    await m.withNodeInsertHeads(brain, [{ type: 'file', path: 'files' }], (tx) =>
      tx.execute(sqlTag`insert into nodes (id, owner_id, type, title, path, audience, data)
        values (${id}, ${brain}, 'file', ${key}, 'files', 'admin',
                ${JSON.stringify({ filename: `${key}.png`, mime_type: 'image/png' })}::jsonb)`),
    );
    files[key] = id;
    return id;
  };
  const fileEmbedDoc = (fileId: string) => ({
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'see the picture' }] },
      { type: 'fileEmbed', attrs: { nodeId: fileId } },
    ],
  });

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.MANTLE_FILES_ROOT = path.join(root, 'files');
    process.env.TABLE_DB_DIR = path.join(root, 'table-dbs');
    m = await import('@mantle/db');
    sqlTag = (await import('drizzle-orm')).sql;
    await m.systemDb
      .execute(sqlTag`insert into auth.users (id, email, password_hash, is_owner, role)
      values (${brain}, ${`bw-${brain.slice(0, 8)}@example.invalid`}, 'x', true, 'admin')`);
    await m.systemDb.execute(sqlTag`insert into spaces (id, kind, login_id)
      values (${brain}, 'brain', ${brain}) on conflict (id) do nothing`);
    await (await import('@mantle/db/test-support')).runWorkspacesSwitch();
    // A Team as a brain switched before 0286 has it (a new brain has none).
    await m.systemDb.execute(sqlTag.raw(teamWorkspaceSql(brain)));
    const ws = await rows<{ name: string; id: string }>(
      sqlTag`select name, id::text as id from workspaces where owner_id = ${brain}`,
    );
    admin = ws.find((w) => w.name === 'Admin')!.id;
    team = ws.find((w) => w.name === 'Team')!.id;
    // The check ON for this database: a writer without its heads is refused.
    // As the superuser: the app's pool may be the runtime role (arch A9).
    await ts.superuserExec(
      scratch.url,
      `alter database "${scratch.name}" set mantle.heads_check = 'on'`,
    );
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
    rmSync(root, { recursive: true, force: true });
  });

  it('migrated, and the check is on', async () => {
    expect(admin && team).toBeTruthy();
    // The box mode, as the superuser: the runtime role (arch A9) may not
    // run mantle_heads_check_mode (the app never calls it).
    const mode = await (
      await import('@mantle/db/test-support')
    ).superuserExec<{ m: string }>(scratch!.url, 'select mantle_heads_check_mode() as m');
    expect(mode[0]!.m).toBe('on');
  });

  it('a page save that adds an embed changes no grant', async () => {
    const c = await import('./pages/tree');
    const d = await import('./pages/draft');
    const f = await file('page-image');
    const page = await c.createPage(brain, { title: 'With a picture' });
    expect(await grants(page.id)).toEqual({ Admin: { ws: admin, excluded: false, home: true } });
    const before = await grants(f);
    await d.updatePage(brain, page.id, { doc: fileEmbedDoc(f) });
    expect(await grants(f)).toEqual(before);
    expect(await teamReads(f)).toBe(false);
  });

  it('a page made in a folder Team reads takes the folder rows (S6)', async () => {
    const t = await import('./tree/write');
    const c = await import('./pages/tree');
    const folder = await t.createTreeFolder(brain, 'pages', {
      parentId: null,
      name: 'For the team',
    });
    // The grant as the Grant Access panel writes it: under the folder's heads.
    await m.withSubtreeHeads(folder.id, [], (tx) =>
      tx.execute(sqlTag`insert into item_grants (node_id, workspace_id, write)
        values (${folder.id}, ${team}, false)`),
    );
    // Made in a folder Team reads: the confirm names Team first.
    await expect(
      c.createPage(brain, { title: 'In the folder', folderId: folder.id }),
    ).rejects.toMatchObject({ name: 'TreeVisibilityError' });
    const page = await c.createPage(brain, {
      title: 'In the folder',
      folderId: folder.id,
      confirm: true,
    });
    expect(await teamReads(page.id)).toBe(true);
    expect((await grants(page.id)).Admin?.home).toBe(true);
  });

  it('a folder share is refused (gone) and writes nothing, the rest of the patch neither', async () => {
    const t = await import('./tree/write');
    const folder = await t.createTreeFolder(brain, 'pages', { parentId: null, name: 'Shared' });
    for (const share of ['team', null] as const) {
      await expect(
        t.updateTreeFolder(
          brain,
          'pages',
          folder.id,
          { name: 'Renamed', share },
          { confirm: true },
        ),
      ).rejects.toMatchObject({ code: 'gone' });
    }
    const [row] = await rows<{ title: string; share_level: string | null }>(
      sqlTag`select title, share_level from nodes where id = ${folder.id}`,
    );
    expect(row).toEqual({ title: 'Shared', share_level: null });
    expect(await teamReads(folder.id)).toBe(false);
    // Renaming alone still works.
    await t.updateTreeFolder(brain, 'pages', folder.id, { name: 'Renamed' });
    const [after] = await rows<{ title: string }>(
      sqlTag`select title from nodes where id = ${folder.id}`,
    );
    expect(after?.title).toBe('Renamed');
  });

  it('a new app is made with its rows (the apps insert needs no head of its own)', async () => {
    const ap = await import('./apps');
    const app = await ap.createApp(brain, { title: 'An app' });
    expect((await grants(app.id)).Admin?.home).toBe(true);
  });

  it('a writer inside an open heads transaction runs on a savepoint of it', async () => {
    const c = await import('./pages/tree');
    const d = await import('./pages/draft');
    const page = await c.createPage(brain, { title: 'Savepoint page' });
    const f = await file('savepoint-image');
    await m.withHeads([page.id], 'update', async () => {
      await d.updatePage(brain, page.id, { doc: fileEmbedDoc(f) });
    });
    const [row] = await rows<{ n: number }>(sqlTag`select count(*)::int as n from node_embeds
      where from_id = ${page.id} and to_id = ${f}`);
    expect(row?.n).toBe(1);
  });

  it('a level column cannot change any more (55000)', async () => {
    const c = await import('./pages/tree');
    const page = await c.createPage(brain, { title: 'Frozen page' });
    for (const set of [
      sqlTag`audience = 'team'`,
      sqlTag`share_level = 'team'`,
      sqlTag`inherited_level = 'team'`,
      sqlTag`embedded_level = 'team'`,
    ]) {
      const err = await m
        .withHeads([page.id], 'update', (tx) =>
          tx.execute(sqlTag`update nodes set ${set} where id = ${page.id}`),
        )
        .then(
          () => null,
          // drizzle wraps the database's error as the cause.
          (e: unknown) => (e as { cause?: unknown }).cause ?? e,
        );
      expect(err, 'refused').toMatchObject({ code: '55000' });
    }
    // The same value is no change: a write that names the column passes.
    await m.withHeads([page.id], 'update', (tx) =>
      tx.execute(sqlTag`update nodes set audience = audience where id = ${page.id}`),
    );
  });

  // In 'on' mode a miss raises (40001) and fails its writer: the tests above
  // passing is the check; the log must be empty as well.
  it('logged no miss', async () => {
    expect(await misses()).toBe(0);
  });
});
