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

    it('makes what a shared note embeds readable through it, until it moves out', async () => {
      const file = randomUUID();
      const note = randomUUID();
      await m.systemDb.execute(sqlTag`
        insert into nodes (id, owner_id, type, title, path, data, tags)
        values (${file}, ${brain}, 'file', 'pic.png', 'files', '{}'::jsonb, '{}')`);
      await m.systemDb.execute(sqlTag`
        insert into nodes (id, owner_id, type, title, path, data, tags)
        values (${note}, ${brain}, 'note', 'with pic', 'notes',
                ${JSON.stringify({ content: `![pic](media:${file})` })}::jsonb, '{}')`);
      // The refusal lists the image too: it would be read through the note.
      const diff = await refusal(tree.moveTreeItems(brain, 'notes', [note], ids.top));
      expect(diff.changes.map((c) => c.id)).toEqual([note]);
      expect(diff.alsoEmbeds).toEqual([{ id: file, title: 'pic.png', from: 'admin', to: 'team' }]);
      expect(await reads('team', [file])).toEqual([]);
      await tree.moveTreeItems(brain, 'notes', [note], ids.top, { confirm: true });
      expect(await reads('team', [file])).toEqual([file]);
      expect(await audience(file)).toBe('admin'); // its own level never moved
      // Out again: the note is admin once more, and so is the image. The
      // refusal says so.
      const back = await refusal(tree.moveTreeItems(brain, 'notes', [note], null));
      expect(back.alsoEmbeds).toEqual([{ id: file, title: 'pic.png', from: 'team', to: 'admin' }]);
      await tree.moveTreeItems(brain, 'notes', [note], null, { confirm: true });
      expect(await reads('team', [file])).toEqual([]);
      expect(await audience(file)).toBe('admin');
      await m.systemDb.execute(sqlTag`delete from nodes where id in (${file}, ${note})`);
    });

    it('a delete that merges into a shared folder asks, listing what takes its share', async () => {
      const tgt = randomUUID();
      const del = randomUUID();
      const twin = randomUUID();
      const moved = randomUUID();
      const inTwin = randomUUID();
      const inMoved = randomUUID();
      const t = `${label}_mt`;
      await m.systemDb.execute(sqlTag`
        insert into nodes (id, owner_id, type, title, slug, path, data, tags) values
          (${tgt}, ${brain}, 'branch', 'Target', ${t}, ${`notes.${t}`}::ltree, '{}'::jsonb, '{}'),
          (${del}, ${brain}, 'branch', 'Del', 'del', ${`notes.${label}_md`}::ltree, '{}'::jsonb, '{}'),
          (${twin}, ${brain}, 'branch', 'Target', ${t}, ${`notes.${label}_md.${t}`}::ltree, '{}'::jsonb, '{}'),
          (${moved}, ${brain}, 'branch', 'Other', 'other', ${`notes.${label}_md.${label}_mo`}::ltree, '{}'::jsonb, '{}')`);
      await share(tgt, 'client');
      await insert(inTwin, 'note', `notes.${label}_md.${t}`, 'merges in');
      await insert(inMoved, 'note', `notes.${label}_md.${label}_mo`, 'moves up');
      try {
        // The merged note lands in the client-shared folder and takes its
        // share; the folder that moves up, and what it holds, stay admin;
        // the merged folder row goes and is not listed.
        const diff = await refusal(tree.deleteTreeFolder(brain, 'notes', del));
        expect(diff.changes).toEqual([
          { id: inTwin, title: 'merges in', from: 'admin', to: 'client' },
        ]);
        expect(diff.total).toBe(1);
        expect(await inherited(inTwin)).toBeNull(); // nothing written
        await tree.deleteTreeFolder(brain, 'notes', del, { confirm: true, seen: 1 });
        expect(await inherited(inTwin)).toBe('client');
        expect(await inherited(inMoved)).toBeNull();
        expect(await reads('client', [inTwin, inMoved])).toEqual([inTwin]);
        const [kept] = (await m.systemDb.execute(sqlTag`
          select share_level, title from nodes where id = ${tgt}`)) as unknown as Array<{
          share_level: string;
          title: string;
        }>;
        expect(kept).toEqual({ share_level: 'client', title: 'Target' });
      } finally {
        await m.systemDb.execute(sqlTag`
          delete from nodes where owner_id = ${brain}
             and (path <@ ${`notes.${t}`}::ltree or path <@ ${`notes.${label}_md`}::ltree
                  or path <@ ${`notes.${label}_mo`}::ltree)`);
      }
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

    it('an unshare waits for an insert into the folder still in flight (0207)', async () => {
      const f = await tree.createTreeFolder(brain, 'notes', {
        parentId: null,
        name: `${label}_race`,
      });
      await tree.updateTreeFolder(brain, 'notes', f.id, { share: 'client' }, { confirm: true });
      const note = randomUUID();
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let inserted!: () => void;
      const didInsert = new Promise<void>((r) => (inserted = r));
      // A write filing a note into the folder, its transaction still open.
      const inserting = m.systemDb.transaction(async (tx) => {
        await tx.execute(sqlTag`
          insert into nodes (id, owner_id, type, title, path, data, tags)
          values (${note}, ${brain}, 'note', 'racing', ${f.path}::ltree,
                  ${JSON.stringify({ content: 'x' })}::jsonb, '{}')`);
        inserted();
        await held;
      });
      await didInsert;
      // The unshare starts while that insert has computed 'client' and not
      // committed; it must wait, then refresh the committed row.
      const unsharing = tree.updateTreeFolder(
        brain,
        'notes',
        f.id,
        { share: null },
        { confirm: true },
      );
      await new Promise((r) => setTimeout(r, 300));
      release();
      await inserting;
      await unsharing;
      expect(await inherited(note)).toBeNull();
      await m.systemDb.execute(sqlTag`delete from nodes where id = ${note}`);
      await tree.deleteTreeFolder(brain, 'notes', f.id, { confirm: true });
    });

    it('an item move and a folder writer on the same row never deadlock (review F2)', async () => {
      const dest = await tree.createTreeFolder(brain, 'notes', {
        parentId: null,
        name: `${label}_dest`,
      });
      const note = randomUUID();
      await m.systemDb.execute(sqlTag`
        insert into nodes (id, owner_id, type, title, path, data, tags)
        values (${note}, ${brain}, 'note', 'contended', 'notes',
                ${JSON.stringify({ content: 'x' })}::jsonb, '{}')`);
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const didLock = new Promise<void>((r) => (locked = r));
      // A folder writer: the share lock exclusive first, then (later) the
      // same row, as a subtree rewrite or a refresh would.
      const writer = m.systemDb.transaction(async (tx) => {
        await tx.execute(sqlTag`select mantle_share_write_lock(${brain}::uuid)`);
        locked();
        await held;
        await tx.execute(sqlTag`update nodes set title = 'contended' where id = ${note}`);
      });
      await didLock;
      // The move must wait at the share lock holding NO row lock; had it
      // locked the row first, the writer's update would deadlock (40P01).
      const mover = tree.moveTreeItems(brain, 'notes', [note], dest.id, { confirm: true });
      await new Promise((r) => setTimeout(r, 300));
      release();
      await writer;
      expect(await mover).toEqual({ moved: 1, failed: [] });
      await m.systemDb.execute(sqlTag`delete from nodes where id = ${note}`);
      await tree.deleteTreeFolder(brain, 'notes', dest.id, { confirm: true });
    });

    it('repairs a row left at a share its folders no longer give (share drift)', async () => {
      const stray = randomUUID();
      await m.systemDb.execute(sqlTag`
        insert into nodes (id, owner_id, type, title, path, data, tags)
        values (${stray}, ${brain}, 'note', 'drifted', 'notes',
                ${JSON.stringify({ content: 'x' })}::jsonb, '{}')`);
      // Forged drift (what a race could leave): the trigger sets it on
      // insert and on path changes only.
      await m.systemDb.execute(
        sqlTag`update nodes set inherited_level = 'client' where id = ${stray}`,
      );
      const dry = await tree.repairShareDrift({ dryRun: true });
      expect(dry.drifted).toBeGreaterThanOrEqual(1);
      expect(dry.repaired).toBe(0);
      expect(await inherited(stray)).toBe('client');
      const done = await tree.repairShareDrift();
      expect(done.repaired).toBeGreaterThanOrEqual(1);
      expect(await inherited(stray)).toBeNull();
      await m.systemDb.execute(sqlTag`delete from nodes where id = ${stray}`);
    });

    it('checks a share before the rest of a combined update writes anything', async () => {
      const before = (await tree.loadTreeFolder(brain, 'notes', { folderId: ids.sub }))!.folder!;
      const diff = await refusal(
        tree.updateTreeFolder(brain, 'notes', ids.sub, { name: 'Renamed first', share: 'client' }),
      );
      expect(diff.total).toBeGreaterThan(0);
      const after = (await tree.loadTreeFolder(brain, 'notes', { folderId: ids.sub }))!.folder!;
      expect(after.name).toBe(before.name);
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
