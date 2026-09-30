/**
 * Folder sharing in the database (folder plan phase 4, migration 0204): a
 * folder's share reaches every row below it through `inherited_level`, kept
 * by triggers, and the viewer roles read through it. Reads run inside
 * withViewer, as the real team and client roles.
 *
 * Brain rows belong to the shared test anchor (mantle_brain_id()), under a
 * folder of this run's own, removed after.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/tree/tree-share.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('sharing a folder', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let tree: typeof import('./index');
  let sqlTag: typeof import('drizzle-orm').sql;
  let brain = '';
  const label = `share_${randomUUID().slice(0, 8)}`;
  const top = `notes.${label}`;
  const ids = {
    top: randomUUID(),
    sub: randomUUID(),
    inTop: randomUUID(),
    inSub: randomUUID(),
    outside: randomUUID(),
  };
  const member = randomUUID();
  let space = '';

  const insert = async (id: string, type: string, path: string, title = id) => {
    await m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, data, tags)
      values (${id}, ${brain}, ${type}::node_type, ${title}, ${path}::ltree, '{}'::jsonb, '{}')`);
  };
  const inherited = async (id: string) => {
    const [row] = (await m.systemDb.execute(
      sqlTag`select inherited_level from nodes where id = ${id}`,
    )) as unknown as Array<{ inherited_level: string | null }>;
    return row?.inherited_level ?? null;
  };
  const share = (id: string, level: string | null) =>
    m.systemDb.execute(sqlTag`update nodes set share_level = ${level} where id = ${id}`);
  /** Which of `ids` the role reads. */
  const reads = async (level: 'team' | 'client' | 'public', want: string[]) =>
    m.withViewer(level, async () => {
      const rows = (await m.db.execute(sqlTag`
        select id::text as id from nodes where id in (${sqlTag.join(
          want.map((id) => sqlTag`${id}::uuid`),
          sqlTag`, `,
        )})`)) as unknown as Array<{ id: string }>;
      return rows.map((r) => r.id).sort();
    });
  const items = () => [ids.inTop, ids.inSub, ids.outside];

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    tree = await import('./index');
    sqlTag = (await import('drizzle-orm')).sql;
    const { ensureTestAnchor } = await import('@mantle/db/test-support');
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    brain = await ensureTestAnchor(admin);
    await tree.ensureKindRoot(brain, 'notes');
    await insert(ids.top, 'branch', top, 'Shared');
    await insert(ids.sub, 'branch', `${top}.sub`, 'Sub');
    await insert(ids.inTop, 'note', top);
    await insert(ids.inSub, 'note', `${top}.sub`);
    await insert(ids.outside, 'note', 'notes');
    // A member with a space of their own, for the draft case.
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role)
      values (${member}, ${`${label}@example.invalid`}, 'x', 'member')`);
    // A member login gets its personal space on insert.
    const [row] = (await m.systemDb.execute(sqlTag`
      select id::text as id from spaces where login_id = ${member} and kind = 'personal'`)) as unknown as Array<{
      id: string;
    }>;
    space = row!.id;
  });

  afterAll(async () => {
    if (space) await m.systemDb.execute(sqlTag`delete from nodes where owner_id = ${space}`);
    await m.systemDb.execute(
      sqlTag`delete from nodes where owner_id = ${brain} and (path <@ ${top}::ltree or id in (${sqlTag.join(
        Object.values(ids).map((id) => sqlTag`${id}::uuid`),
        sqlTag`, `,
      )}) or path <@ ${`notes.${label}_moved`}::ltree)`,
    );
    if (space) await m.systemDb.execute(sqlTag`delete from spaces where id = ${space}`);
    await m.systemDb.execute(sqlTag`delete from auth.users where id = ${member}`);
  });

  it('changes nobody’s access until a folder is shared', async () => {
    expect(await inherited(ids.inTop)).toBeNull();
    expect(await reads('team', items())).toEqual([]);
  });

  it('a team share reaches everything below, including what lands there later', async () => {
    await share(ids.top, 'team');
    expect(await inherited(ids.top)).toBeNull();
    expect(await inherited(ids.sub)).toBe('team');
    expect(await inherited(ids.inTop)).toBe('team');
    expect(await inherited(ids.inSub)).toBe('team');
    expect(await inherited(ids.outside)).toBeNull();
    expect(await reads('team', items())).toEqual([ids.inSub, ids.inTop].sort());
    expect(await reads('client', items())).toEqual([]);
    expect(await reads('public', items())).toEqual([]);

    const later = randomUUID();
    await insert(later, 'note', `${top}.sub`);
    expect(await inherited(later)).toBe('team');
    await m.systemDb.execute(sqlTag`delete from nodes where id = ${later}`);
  });

  it('moving an item out drops the share, and moving it in picks it up', async () => {
    await tree.moveTreeItems(brain, 'notes', [ids.inSub], null, { confirm: true });
    expect(await inherited(ids.inSub)).toBeNull();
    expect(await reads('team', [ids.inSub])).toEqual([]);
    await tree.moveTreeItems(brain, 'notes', [ids.inSub], ids.sub, { confirm: true });
    expect(await inherited(ids.inSub)).toBe('team');
  });

  it('the nearest shared folder wins: a client share inside a team folder', async () => {
    await share(ids.sub, 'client');
    expect(await inherited(ids.inSub)).toBe('client');
    expect(await inherited(ids.inTop)).toBe('team');
    expect(await reads('client', items())).toEqual([ids.inSub]);
    expect(await reads('team', items())).toEqual([ids.inSub, ids.inTop].sort());
    await share(ids.sub, null);
    expect(await inherited(ids.inSub)).toBe('team');
  });

  it('a rename or move of the shared folder keeps the whole subtree right', async () => {
    await tree.updateTreeFolder(brain, 'notes', ids.top, { name: `${label}_moved` });
    expect(await inherited(ids.sub)).toBe('team');
    expect(await inherited(ids.inSub)).toBe('team');
    // Moved under an unshared folder, the subtree keeps its own share.
    const holder = await tree.createTreeFolder(brain, 'notes', {
      parentId: null,
      name: `${label}_holder`,
    });
    await tree.updateTreeFolder(brain, 'notes', ids.top, { parentId: holder.id });
    expect(await inherited(ids.inSub)).toBe('team');
    await tree.updateTreeFolder(brain, 'notes', ids.top, { parentId: null });
    await tree.deleteTreeFolder(brain, 'notes', holder.id);
    // Put back where the other cases expect it.
    await tree.updateTreeFolder(brain, 'notes', ids.top, { name: label });
    expect(await inherited(ids.inTop)).toBe('team');
  });

  it('unsharing takes it all back', async () => {
    await share(ids.top, null);
    for (const id of [ids.sub, ids.inTop, ids.inSub]) expect(await inherited(id)).toBeNull();
    expect(await reads('team', items())).toEqual([]);
  });

  it('a member draft in a shared folder never inherits', async () => {
    await share(ids.top, 'team');
    const draft = randomUUID();
    await m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, data, tags)
      values (${draft}, ${space}, 'note', 'draft', ${top}::ltree, '{}'::jsonb, '{}')`);
    expect(await inherited(draft)).toBeNull();
    await share(ids.top, null);
  });

  it('holds the type ceiling and the share rules in the database', async () => {
    await share(ids.top, 'team');
    // A task (never a workspace kind) filed under a shared folder stays unshared.
    const task = randomUUID();
    await insert(task, 'task', top);
    expect(await inherited(task)).toBeNull();
    await m.systemDb.execute(sqlTag`delete from nodes where id = ${task}`);
    await share(ids.top, null);

    // drizzle wraps the Postgres error; the check violation is its cause.
    const refuse = (q: Promise<unknown>) =>
      expect(q).rejects.toMatchObject({ cause: expect.objectContaining({ code: '23514' }) });
    await refuse(share(ids.top, 'public'));
    await refuse(share(ids.inTop, 'team'));
    const tasksFolder = randomUUID();
    await tree.ensureKindRoot(brain, 'tasks');
    await insert(tasksFolder, 'branch', `tasks.${label}`);
    await refuse(share(tasksFolder, 'team'));
    await m.systemDb.execute(sqlTag`delete from nodes where id = ${tasksFolder}`);
  });

  describe('through the tree writes', () => {
    const audience = async (id: string) => {
      const [row] = (await m.systemDb.execute(
        sqlTag`select audience from nodes where id = ${id}`,
      )) as unknown as Array<{ audience: string }>;
      return row?.audience;
    };
    const refusal = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (err) {
        if (err instanceof tree.TreeVisibilityError) return err.diff;
        throw err;
      }
      throw new Error('expected a visibility refusal');
    };

    it('asks before a share, and a confirmed share reaches the subtree', async () => {
      const diff = await refusal(tree.updateTreeFolder(brain, 'notes', ids.top, { share: 'team' }));
      expect(diff.total).toBe(3); // the subfolder and the two notes
      expect(diff.changes.find((c) => c.id === ids.inTop)).toMatchObject({
        from: 'admin',
        to: 'team',
      });
      expect(await inherited(ids.inTop)).toBeNull(); // nothing written
      const folder = await tree.updateTreeFolder(
        brain,
        'notes',
        ids.top,
        { share: 'team' },
        { confirm: true },
      );
      expect(folder.share).toBe('team');
      expect(await inherited(ids.inTop)).toBe('team');
      const page = await tree.loadTreeFolder(brain, 'notes', { folderId: ids.top });
      expect(page!.items.find((i) => i.id === ids.inTop)).toMatchObject({
        level: 'team',
        inherited: 'team',
      });
    });

    it('asks before a move in or out, and before lifting a shared folder’s contents', async () => {
      const shown = await refusal(tree.moveTreeItems(brain, 'notes', [ids.outside], ids.top));
      expect(await inherited(ids.outside)).toBeNull();
      // A confirm for another list (it changed while the dialog was open) is
      // refused again with the list as it is now.
      const again = await refusal(
        tree.moveTreeItems(brain, 'notes', [ids.outside], ids.top, {
          confirm: true,
          seen: shown.total + 1,
        }),
      );
      expect(again.total).toBe(shown.total);
      expect(await inherited(ids.outside)).toBeNull();
      await tree.moveTreeItems(brain, 'notes', [ids.outside], ids.top, {
        confirm: true,
        seen: shown.total,
      });
      expect(await inherited(ids.outside)).toBe('team');
      await refusal(tree.moveTreeItems(brain, 'notes', [ids.outside], null));
      await tree.moveTreeItems(brain, 'notes', [ids.outside], null, { confirm: true });
      expect(await inherited(ids.outside)).toBeNull();
      // Deleting the shared folder would lift its contents out of the share.
      await refusal(tree.deleteTreeFolder(brain, 'notes', ids.top));
      // A rename changes nobody's access: no question.
      await tree.updateTreeFolder(brain, 'notes', ids.sub, { name: 'Sub two' });
      expect(await inherited(ids.inSub)).toBe('team');
    });

    it('takes what a shared note embeds to the level it is read at, never raising it', async () => {
      const file = randomUUID();
      const note = randomUUID();
      await m.systemDb.execute(sqlTag`
        insert into nodes (id, owner_id, type, title, path, data, tags)
        values (${file}, ${brain}, 'file', 'pic.png', 'files', '{}'::jsonb, '{}')`);
      await m.systemDb.execute(sqlTag`
        insert into nodes (id, owner_id, type, title, path, data, tags)
        values (${note}, ${brain}, 'note', 'with pic', 'notes',
                ${JSON.stringify({ content: `![pic](media:${file})` })}::jsonb, '{}')`);
      // The refusal lists the image too: it would go down with the note.
      const diff = await refusal(tree.moveTreeItems(brain, 'notes', [note], ids.top));
      expect(diff.changes.map((c) => c.id)).toEqual([note]);
      expect(diff.alsoLowered).toEqual([{ id: file, title: 'pic.png', from: 'admin', to: 'team' }]);
      expect(await audience(file)).toBe('admin');
      await tree.moveTreeItems(brain, 'notes', [note], ids.top, { confirm: true });
      expect(await audience(file)).toBe('team');
      // Out again: the note is admin once more, the image keeps its level.
      await tree.moveTreeItems(brain, 'notes', [note], null, { confirm: true });
      expect(await audience(file)).toBe('team');
      await m.systemDb.execute(sqlTag`delete from nodes where id in (${file}, ${note})`);
    });

    it('a shared folder deleted by any writer leaves no share behind (0207)', async () => {
      const f = randomUUID();
      const inF = randomUUID();
      await m.systemDb.execute(sqlTag`
        insert into nodes (id, owner_id, type, title, slug, path, data, tags)
        values (${f}, ${brain}, 'branch', 'Gone', 'gone', ${`notes.${label}_gone`}::ltree, '{}'::jsonb, '{}')`);
      await m.systemDb.execute(sqlTag`update nodes set share_level = 'client' where id = ${f}`);
      await m.systemDb.execute(sqlTag`
        insert into nodes (id, owner_id, type, title, path, data, tags)
        values (${inF}, ${brain}, 'note', 'left', ${`notes.${label}_gone`}::ltree,
                ${JSON.stringify({ content: 'x' })}::jsonb, '{}')`);
      expect(await inherited(inF)).toBe('client');
      // A raw delete of the folder row, its note left where it was.
      await m.systemDb.execute(sqlTag`delete from nodes where id = ${f}`);
      expect(await inherited(inF)).toBeNull();
      await m.systemDb.execute(sqlTag`delete from nodes where id = ${inF}`);
    });

    it('refuses what cannot be shared', async () => {
      await tree.ensureKindRoot(brain, 'tasks');
      const tasksFolder = await tree.createTreeFolder(brain, 'tasks', {
        parentId: null,
        name: `${label}_tasks`,
      });
      await expect(
        tree.updateTreeFolder(brain, 'tasks', tasksFolder.id, { share: 'team' }, { confirm: true }),
      ).rejects.toMatchObject({ code: 'invalid' });
      await tree.deleteTreeFolder(brain, 'tasks', tasksFolder.id);
      const autoFiled = (await tree.listTreeFolders(brain, 'notes')).find((f) => f.system);
      if (autoFiled) {
        await expect(
          tree.updateTreeFolder(brain, 'notes', autoFiled.id, { share: 'team' }, { confirm: true }),
        ).rejects.toMatchObject({ code: 'invalid' });
      }
      await tree.updateTreeFolder(brain, 'notes', ids.top, { share: null }, { confirm: true });
      expect(await inherited(ids.inTop)).toBeNull();
    });
  });
});
