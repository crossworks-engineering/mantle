/**
 * An import table and the images from a file take the file's home and grants,
 * once, when they are made. After that they are ordinary items. A real member's
 * login reads and manages them in a workspace scope; a workspace with no grant,
 * Admin included, does not. Against a real, migrated Postgres; the byte load
 * is stubbed with a small CSV.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/api/src/agent/extract/auto-table-home.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureTestAnchor } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

/** Runs right after a part's create, before its copy; the created ids and the
 *  image saves, for the tests that look at them. */
const h = vi.hoisted(() => ({
  afterCreate: null as null | (() => Promise<void>),
  tables: [] as string[],
  saves: [] as { id: string; loginId?: string | null; diskPath?: string }[],
}));
vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return {
    ...actual,
    createTable: async (...args: Parameters<typeof actual.createTable>) => {
      const t = await actual.createTable(...args);
      h.tables.push(t.id);
      await h.afterCreate?.();
      return t;
    },
  };
});
vi.mock('@mantle/files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/files')>();
  return {
    ...actual,
    upsertFile: async (...args: Parameters<typeof actual.upsertFile>) => {
      const f = await actual.upsertFile(...args);
      h.saves.push({
        id: f.id,
        loginId: args[0].loginId,
        diskPath: actual.diskPathForFile(args[0].parentPath, args[0].filename) ?? undefined,
      });
      await h.afterCreate?.();
      return f;
    },
  };
});
vi.mock('./trace', () => ({
  stepInOwnTrace: async (_o: unknown, _n: unknown, _s: unknown, fn: (h: unknown) => unknown) =>
    fn({ setMeta: () => undefined, setError: () => undefined }),
}));
vi.mock('@mantle/files/embedded-images', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/files/embedded-images')>()),
  extractEmbeddedImages: async () => ({
    images: [{ bytes: Buffer.from('png'), ordinal: 1, ext: 'png', mime: 'image/png' }],
    candidates: 1,
    rejected: {},
  }),
}));

vi.mock('./file-bytes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./file-bytes')>();
  return {
    ...actual,
    loadFileBytes: async (node: { title: string }) => ({
      bytes: Buffer.from('tag,size\nP-101,50\nP-102,80\n'),
      filename: node.title,
      ext: 'csv',
      mime: 'text/csv',
    }),
  };
});

describe.skipIf(!URL)('the home and the grants of an import table', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let sqlTag: typeof import('drizzle-orm').sql;
  let maybeAutoTableSpreadsheet: typeof import('./auto-table').maybeAutoTableSpreadsheet;
  let maybeExtractEmbeddedImages: typeof import('./images').maybeExtractEmbeddedImages;
  let anchor: string;
  let adminWs: string;
  const tag = `import-home-${randomUUID().slice(0, 8)}`;
  const team = randomUUID();
  const other = randomUUID();
  const member = randomUUID();
  const outsider = randomUUID();
  const adminUser = randomUUID();
  const tableRoot = mkdtempSync(path.join(tmpdir(), 'mantle-import-home-'));

  let scratch: { url: string; drop: () => Promise<void> } | undefined;
  const su = async (q: ReturnType<typeof sqlTag>) =>
    (await import('@mantle/db/test-support')).superuserExec(scratch!.url, q);

  /** A file homed in `home`, as an upload by a Moderator of it leaves it. */
  const fileIn = async (home: string, name: string, path = 'files') => {
    const id = randomUUID();
    await m.withCreateHome({ createWs: home, privateWs: null }, () =>
      m.withNodeInsertHeads(anchor, [{ type: 'file', path }], (tx) =>
        tx.execute(sqlTag`
          insert into nodes (id, owner_id, type, title, path, data) values
            (${id}, ${anchor}, 'file', ${`${tag} ${name}`}, ${path}::ltree,
             ${JSON.stringify({ filename: `${tag} ${name}` })}::jsonb)`),
      ),
    );
    return id;
  };

  const nodeRowOrNull = async (id: string) =>
    (
      (await m.systemDb.execute(sqlTag`select id from nodes where id = ${id}`)) as unknown as {
        id: string;
      }[]
    )[0] ?? null;

  const nodeRow = async (id: string) =>
    (
      (await m.systemDb.execute(
        sqlTag`select * from nodes where id = ${id}`,
      )) as unknown as (typeof m.nodes.$inferSelect)[]
    )[0]!;

  /** The import table of file `id`, by the worker's pass. */
  const imported = async (id: string) => {
    const row = await nodeRow(id);
    await maybeAutoTableSpreadsheet(
      {
        id: row.id,
        ownerId: anchor,
        type: 'file',
        title: row.title,
        path: 'files',
        data: row.data,
      } as typeof m.nodes.$inferSelect,
      anchor,
    );
    const rows = (await m.systemDb.execute(sqlTag`
      select id, home_ws::text as home, read_ws::text[] as read from nodes
       where type = 'table' and data->>'sourceFileId' = ${id}`)) as unknown as {
      id: string;
      home: string;
      read: string[];
    }[];
    expect(rows).toHaveLength(1);
    return rows[0]!;
  };

  const reads = async (login: string, id: string) => {
    const rows = await m.withViewer({ login }, () =>
      m.db.execute(sqlTag`select id from nodes where id = ${id}`),
    );
    return (rows as unknown as unknown[]).length > 0;
  };

  beforeAll(async () => {
    // Its own database: it makes the Admin workspace and logins of a brain.
    scratch = await (await import('@mantle/db/test-support')).createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = tableRoot;
    process.env.MANTLE_FILES_ROOT = path.join(tableRoot, 'files');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    sqlTag = (await import('drizzle-orm')).sql;
    ({ maybeAutoTableSpreadsheet } = await import('./auto-table'));
    ({ maybeExtractEmbeddedImages } = await import('./images'));
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    anchor = await ensureTestAnchor(admin);
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role) values
        (${member}, ${`${tag}-m@example.invalid`}, 'x', 'member'),
        (${outsider}, ${`${tag}-o@example.invalid`}, 'x', 'member'),
        (${adminUser}, ${`${tag}-a@example.invalid`}, 'x', 'member')`);
    await su(sqlTag`
      insert into workspaces (id, owner_id, name) values
        (${team}, ${anchor}, ${`${tag} project team`}), (${other}, ${anchor}, ${`${tag} other`})`);
    await su(sqlTag`
      insert into workspace_users (workspace_id, login_id, moderator) values
        (${team}, ${member}, true), (${other}, ${outsider}, false)`);
    // As the superuser, as above: the runtime role only reads the workspace tables.
    await su(sqlTag`insert into workspaces (owner_id, name, is_admin)
                    select ${anchor}::uuid, 'Admin', true
                     where mantle_ws_admin_id(${anchor}::uuid) is null`);
    const [w] = (await m.systemDb.execute(
      sqlTag`select mantle_ws_admin_id(${anchor}::uuid)::text as id`,
    )) as unknown as { id: string }[];
    adminWs = w!.id;
    await su(sqlTag`insert into workspace_users (workspace_id, login_id, moderator)
                    values (${adminWs}, ${anchor}, true), (${adminWs}, ${adminUser}, true)
                    on conflict do nothing`);
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
    rmSync(tableRoot, { recursive: true, force: true });
  });

  it('a member reads and manages the table of a file in their workspace', async () => {
    const file = await fileIn(team, 'gap.csv');
    expect(await reads(member, file)).toBe(true);
    const t = await imported(file);
    expect({ home: t.home, read: t.read }).toEqual({ home: team, read: [team] });
    expect(await reads(member, t.id)).toBe(true);
    const verdict = await m.withViewer({ login: member }, () =>
      m.itemWriteVerdicts([t.id], 'manage'),
    );
    expect(verdict.get(t.id)).toBe('ok');
  });

  it('a file Admin cannot read puts no copy of its content in Admin', async () => {
    const file = await fileIn(team, 'leak.csv');
    expect(await reads(adminUser, file)).toBe(false);
    const t = await imported(file);
    expect(await reads(adminUser, t.id)).toBe(false);
    expect(t.read).not.toContain(adminWs);
  });

  it('a workspace with no grant reads neither', async () => {
    const file = await fileIn(team, 'other.csv');
    const t = await imported(file);
    expect(t.read).toEqual([team]);
    expect(await reads(outsider, file)).toBe(false);
    expect(await reads(outsider, t.id)).toBe(false);
  });

  it('a file deleted during the extract: its table is refused, nothing lands in Admin', async () => {
    const file = await fileIn(team, 'gone.csv');
    const row = await nodeRow(file);
    await m.withNodeDeleteHeads([file], (tx) =>
      tx.execute(sqlTag`delete from nodes where id = ${file}`),
    );
    await expect(
      maybeAutoTableSpreadsheet(
        {
          id: row.id,
          ownerId: anchor,
          type: 'file',
          title: row.title,
          path: 'files',
          data: row.data,
        } as typeof m.nodes.$inferSelect,
        anchor,
      ),
    ).rejects.toThrow(/live home/);
    // The images too: the pass records the error, and no image lands.
    await maybeExtractEmbeddedImages(
      {
        id: row.id,
        ownerId: anchor,
        type: 'file',
        title: `${tag} gone.pdf`,
        path: 'files',
        data: { filename: `${tag} gone.pdf` },
      } as unknown as typeof m.nodes.$inferSelect,
      anchor,
    );
    const left = (await m.systemDb.execute(sqlTag`
      select id from nodes where data->>'sourceFileId' = ${file}`)) as unknown as unknown[];
    expect(left).toEqual([]);
  });

  it('a file shared with a second workspace gives its table that grant too', async () => {
    const file = await fileIn(team, 'shared.csv');
    await m.withSubtreeHeads(file, [], (tx) =>
      tx.execute(
        sqlTag`insert into item_grants (node_id, workspace_id, write) values (${file}, ${other}, true)`,
      ),
    );
    const t = await imported(file);
    expect(t.home).toBe(team);
    expect([...t.read].sort()).toEqual([team, other].sort());
    expect(await reads(outsider, t.id)).toBe(true);
    // The Write switch came with it.
    const [row] = (await m.systemDb.execute(sqlTag`
      select write from item_grants where node_id = ${t.id} and workspace_id = ${other}`)) as unknown as {
      write: boolean;
    }[];
    expect(row!.write).toBe(true);
    const verdict = await m.withViewer({ login: outsider }, () =>
      m.itemWriteVerdicts([t.id], 'edit'),
    );
    expect(verdict.get(t.id)).toBe('ok');
  });

  it('a hand grant, a hand move and "Removed here" stay after a re-ingest', async () => {
    const grantRows = (id: string) =>
      m.systemDb.execute(sqlTag`
        select workspace_id::text as ws, write, is_home, excluded, granted_by::text as who
          from item_grants where node_id = ${id} order by workspace_id`);
    const handGrant = await imported(await fileIn(team, 'hand-grant.csv'));
    const removed = await imported(await fileIn(team, 'removed.csv'));
    const moved = await fileIn(team, 'moved.csv');
    const movedTable = await imported(moved);
    for (const t of [handGrant, removed, movedTable]) expect(t.home).toBe(team);
    await m.withHeads([handGrant.id, removed.id, movedTable.id], 'update', async (tx) => {
      await tx.execute(sqlTag`insert into item_grants (node_id, workspace_id, write, granted_by)
        values (${handGrant.id}, ${other}, true, ${member})`);
      await tx.execute(sqlTag`insert into item_grants (node_id, workspace_id, excluded, granted_by)
        values (${removed.id}, ${other}, true, ${member})`);
      await tx.execute(sqlTag`delete from item_grants where node_id = ${movedTable.id}`);
      await tx.execute(sqlTag`insert into item_grants (node_id, workspace_id, is_home, granted_by)
        values (${movedTable.id}, ${other}, true, ${member})`);
    });
    const before = [
      await grantRows(handGrant.id),
      await grantRows(removed.id),
      await grantRows(movedTable.id),
    ];
    const handFile = (await m.systemDb.execute(sqlTag`
      select data->>'sourceFileId' as f from nodes where id in (${handGrant.id}, ${removed.id})`)) as unknown as {
      f: string;
    }[];
    for (const f of [handFile[0]!.f, handFile[1]!.f, moved]) await imported(f);
    expect([
      await grantRows(handGrant.id),
      await grantRows(removed.id),
      await grantRows(movedTable.id),
    ]).toEqual(before);
    expect(before[0]).toHaveLength(2);
    expect(await reads(outsider, movedTable.id)).toBe(true);
    expect(await reads(member, movedTable.id)).toBe(false);
  });

  it('a file whose home is archived gets no part', async () => {
    const dead = randomUUID();
    await su(sqlTag`insert into workspaces (id, owner_id, name) values
      (${dead}, ${anchor}, ${`${tag} dead`})`);
    const file = await fileIn(dead, 'archived.csv');
    await su(sqlTag`update workspaces set archived_at = now() where id = ${dead}`);
    const row = await nodeRow(file);
    await expect(
      maybeAutoTableSpreadsheet(
        {
          id: row.id,
          ownerId: anchor,
          type: 'file',
          title: row.title,
          path: 'files',
          data: row.data,
        } as typeof m.nodes.$inferSelect,
        anchor,
      ),
    ).rejects.toThrow(/live home/);
    const left = (await m.systemDb.execute(sqlTag`
      select id from nodes where data->>'sourceFileId' = ${file}`)) as unknown as unknown[];
    expect(left).toEqual([]);
    await m.systemDb.execute(sqlTag`delete from nodes where id = ${file}`);
    await su(sqlTag`delete from workspaces where id = ${dead}`);
  });

  it('an image from a file takes the file, not the Admin folder it sits in', async () => {
    const file = await fileIn(team, 'manual.pdf');
    const row = await nodeRow(file);
    await maybeExtractEmbeddedImages(
      {
        id: row.id,
        ownerId: anchor,
        type: 'file',
        title: row.title,
        path: 'files',
        data: row.data,
      } as typeof m.nodes.$inferSelect,
      anchor,
    );
    const [img] = (await m.systemDb.execute(sqlTag`
      select id, home_ws::text as home, read_ws::text[] as read from nodes
       where type = 'file' and data->>'sourceFileId' = ${file}`)) as unknown as {
      id: string;
      home: string;
      read: string[];
    }[];
    expect(img).toBeDefined();
    expect({ home: img!.home, read: img!.read }).toEqual({ home: team, read: [team] });
    expect(await reads(member, img!.id)).toBe(true);
    expect(await reads(adminUser, img!.id)).toBe(false);
    // The Auto-filed folder is Admin's, and does not name the file.
    const folders = (await m.systemDb.execute(sqlTag`
      select f.title, f.path::text as path, f.data->>'description' as about from nodes f, nodes i
       where i.id = ${img!.id} and f.type = 'branch' and f.path = i.path`)) as unknown as {
      title: string;
      path: string;
      about: string | null;
    }[];
    expect(JSON.stringify(folders)).not.toContain('manual');
    expect(folders[0]!.title).toContain(file.slice(0, 8));
  });

  it('two files of one name each keep their own images and readers, and a re-ingest makes none', async () => {
    const name = `${tag} revision.pdf`;
    await m.withCreateHome({ createWs: other, privateWs: null }, () =>
      m.withNodeInsertHeads(anchor, [{ type: 'branch', path: 'files.rev_old' }], (tx) =>
        tx.execute(sqlTag`
          insert into nodes (id, owner_id, type, title, path) values
            (${randomUUID()}, ${anchor}, 'branch', ${`${tag} old`}, 'files.rev_old')`),
      ),
    );
    const { upsertFile } = await import('@mantle/files');
    const old = await m.withCreateHome({ createWs: other, privateWs: null }, () =>
      upsertFile({
        ownerId: anchor,
        parentPath: 'files.rev_old',
        filename: name,
        bytes: Buffer.from('old'),
      }),
    );
    // The member's own upload, in the login's request scope.
    const scope = await m.loginScopeFor(member);
    const fresh = await m.runInRequestSlot(async () => {
      m.enterRequestScope(scope, { writes: true, drafts: false });
      return m.withCreateHome({ createWs: team, privateWs: null }, () =>
        upsertFile({
          ownerId: anchor,
          parentPath: 'files',
          filename: name,
          bytes: Buffer.from('new'),
        }),
      );
    });
    const pass = async (id: string) => {
      const row = await nodeRow(id);
      await maybeExtractEmbeddedImages(
        {
          id: row.id,
          ownerId: anchor,
          type: 'file',
          title: name,
          path: row.path,
          data: row.data,
        } as typeof m.nodes.$inferSelect,
        anchor,
      );
    };
    const images = async (id: string) =>
      (await m.systemDb.execute(sqlTag`
        select id, path::text as path, read_ws::text[] as read from nodes
         where type = 'file' and data->>'sourceFileId' = ${id}`)) as unknown as {
        id: string;
        path: string;
        read: string[];
      }[];
    await pass(old.id);
    await pass(fresh.id);
    const [oldImg, ...oldMore] = await images(old.id);
    const [newImg, ...newMore] = await images(fresh.id);
    expect(oldMore).toEqual([]);
    expect(newMore).toEqual([]);
    // One name each, in a folder of its own, named by the file's id.
    expect(oldImg!.path).not.toBe(newImg!.path);
    expect(oldImg!.path).toContain(old.id.slice(0, 8));
    expect(newImg!.path).toContain(fresh.id.slice(0, 8));
    expect(oldImg!.read).toEqual([other]);
    expect(newImg!.read).toEqual([team]);
    expect(await reads(member, newImg!.id)).toBe(true);
    expect(await reads(member, oldImg!.id)).toBe(false);
    expect(await reads(outsider, oldImg!.id)).toBe(true);
    expect(await reads(outsider, newImg!.id)).toBe(false);
    // The same file again: its images stay, none is added.
    await pass(fresh.id);
    expect((await images(fresh.id)).map((i) => i.id)).toEqual([newImg!.id]);
  });

  it('a part of a file private to a login is private to it too', async () => {
    const adminB = randomUUID();
    await m.systemDb.execute(sqlTag`insert into auth.users (id, email, password_hash, role)
      values (${adminB}, ${`${tag}-b@example.invalid`}, 'x', 'member')`);
    await su(sqlTag`insert into workspace_users (workspace_id, login_id, moderator)
      values (${adminWs}, ${adminB}, true)`);
    const file = await fileIn(adminWs, 'telegram.csv');
    await m.withHeads([file], 'update', (tx) =>
      tx.execute(sqlTag`update nodes set login_id = ${adminUser} where id = ${file}`),
    );
    const t = await imported(file);
    expect(t.home).toBe(adminWs);
    expect(await reads(adminUser, t.id)).toBe(true);
    expect(await reads(adminB, t.id)).toBe(false);
    await su(sqlTag`delete from workspace_users where login_id = ${adminB}`);
  });

  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
    );
  const deleteFile = async (file: string) => {
    await m.withNodeDeleteHeads([file], (tx) =>
      tx.execute(sqlTag`delete from nodes where id = ${file}`),
    );
  };

  it('a failed copy leaves no table: the row and the workbook go', async () => {
    const file = await fileIn(team, 'failed-copy.csv');
    const row = await nodeRow(file);
    h.tables.length = 0;
    h.afterCreate = () => deleteFile(file);
    try {
      await expect(
        maybeAutoTableSpreadsheet(
          {
            id: row.id,
            ownerId: anchor,
            type: 'file',
            title: row.title,
            path: 'files',
            data: row.data,
          } as typeof m.nodes.$inferSelect,
          anchor,
        ),
      ).rejects.toThrow(/live home/);
    } finally {
      h.afterCreate = null;
    }
    const id = h.tables[0]!;
    expect(id).toBeDefined();
    expect(await nodeRowOrNull(id)).toBeNull();
    expect(walk(tableRoot).filter((f) => f.includes(id))).toEqual([]);
  });

  it('a failed copy leaves no image: the row and the bytes go', async () => {
    const file = await fileIn(team, 'failed-copy.pdf');
    const row = await nodeRow(file);
    h.saves.length = 0;
    h.afterCreate = () => deleteFile(file);
    try {
      await maybeExtractEmbeddedImages(
        {
          id: row.id,
          ownerId: anchor,
          type: 'file',
          title: row.title,
          path: 'files',
          data: row.data,
        } as typeof m.nodes.$inferSelect,
        anchor,
      );
    } finally {
      h.afterCreate = null;
    }
    const saved = h.saves[0]!;
    expect(saved).toBeDefined();
    expect(await nodeRowOrNull(saved.id)).toBeNull();
    expect(saved.diskPath).toBeTruthy();
    expect(existsSync(saved.diskPath!)).toBe(false);
  });

  it('a first error is the one thrown when the part cannot be removed', async () => {
    const file = await fileIn(team, 'stays.csv');
    const made = randomUUID();
    const seen = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      m.createPartOfFile(
        file,
        async () => {
          await deleteFile(file);
          return { id: made };
        },
        async () => {
          throw new Error('remove failed');
        },
      ),
    ).rejects.toThrow(/live home/);
    expect(seen.mock.calls.flat().join(' ')).toContain(made);
    seen.mockRestore();
  });

  it("a private file's image is private from its insert", async () => {
    const file = await fileIn(team, 'private.pdf');
    const row = await nodeRow(file);
    h.saves.length = 0;
    await maybeExtractEmbeddedImages(
      {
        id: row.id,
        ownerId: anchor,
        type: 'file',
        title: row.title,
        path: 'files',
        data: row.data,
        loginId: member,
      } as typeof m.nodes.$inferSelect,
      anchor,
    );
    expect(h.saves[0]!.loginId).toBe(member);
  });

  it("the file's excluded rows stay out, and its folder's rows come as plain rows", async () => {
    const folder = randomUUID();
    await m.withCreateHome({ createWs: team, privateWs: null }, () =>
      m.withNodeInsertHeads(anchor, [{ type: 'branch', path: 'files.grp' }], (tx) =>
        tx.execute(sqlTag`insert into nodes (id, owner_id, type, title, path)
          values (${folder}, ${anchor}, 'branch', ${`${tag} grp`}, 'files.grp')`),
      ),
    );
    await m.withSubtreeHeads(folder, [], (tx) =>
      tx.execute(sqlTag`insert into item_grants (node_id, workspace_id, write)
        values (${folder}, ${other}, true)`),
    );
    const passed = await fileIn(team, 'in-folder.csv', 'files.grp');
    const fromFolder = await imported(passed);
    const rowsOf = (id: string) =>
      m.systemDb.execute(sqlTag`select workspace_id::text as ws, write, via_folder_id::text as via
        from item_grants where node_id = ${id} and not is_home`) as unknown as Promise<
        { ws: string; write: boolean; via: string | null }[]
      >;
    expect(await rowsOf(fromFolder.id)).toEqual([{ ws: other, write: true, via: null }]);
    // Excluded on the file: not on the part.
    const excluded = await fileIn(team, 'excluded.csv', 'files.grp');
    await m.withHeads([excluded], 'update', (tx) =>
      tx.execute(sqlTag`update item_grants set excluded = true, via_folder_id = null, write = false
        where node_id = ${excluded} and workspace_id = ${other}`),
    );
    const t = await imported(excluded);
    expect(t.read).toEqual([team]);
    expect(await reads(outsider, t.id)).toBe(false);
  });

  it("the Write switch on the file's home row comes with it", async () => {
    const file = await fileIn(team, 'home-write.csv');
    await m.withHeads([file], 'update', (tx) =>
      tx.execute(sqlTag`update item_grants set write = true where node_id = ${file} and is_home`),
    );
    const t = await imported(file);
    const [row] = (await m.systemDb.execute(sqlTag`
      select write from item_grants where node_id = ${t.id} and is_home`)) as unknown as {
      write: boolean;
    }[];
    expect(row!.write).toBe(true);
  });

  it('an image of a file that holds Admin reads in Admin', async () => {
    const file = await fileIn(team, 'admin-too.pdf');
    await m.withHeads([file], 'update', (tx) =>
      tx.execute(
        sqlTag`insert into item_grants (node_id, workspace_id) values (${file}, ${adminWs})`,
      ),
    );
    const row = await nodeRow(file);
    await maybeExtractEmbeddedImages(
      {
        id: row.id,
        ownerId: anchor,
        type: 'file',
        title: row.title,
        path: 'files',
        data: row.data,
      } as typeof m.nodes.$inferSelect,
      anchor,
    );
    const [img] = (await m.systemDb.execute(sqlTag`
      select id, home_ws::text as home, read_ws::text[] as read from nodes
       where type = 'file' and data->>'sourceFileId' = ${file}`)) as unknown as {
      id: string;
      home: string;
      read: string[];
    }[];
    expect(img!.home).toBe(team);
    expect([...img!.read].sort()).toEqual([team, adminWs].sort());
    expect(await reads(adminUser, img!.id)).toBe(true);
  });
});
