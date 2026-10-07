/**
 * Tree reads never need write rights (docs/folder-tree.md, "Reading").
 *
 * Reading a kind's tree first makes sure its root row exists and moves in
 * what older brains kept elsewhere. Those were unconditional writes, and
 * Postgres checks a table's privilege when a statement starts, before it
 * looks at a row: so a brain served through a role with SELECT only (the
 * public demo's reader) answered 500 to every tree read, for a root that was
 * there all along.
 *
 * Here the same reads run as such a role (LOGIN, BYPASSRLS, SELECT on every
 * table, no INSERT, UPDATE or DELETE): each returns its page, and nothing is
 * written. A brain whose roots are missing reads as empty kinds. On a normal
 * role the first read still makes the root.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/tree/tree-readonly.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import type { SQL } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('tree reads on a database that refuses writes', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let tree: typeof import('./index');
  let appNav: typeof import('../app-nav');
  let files: typeof import('@mantle/files');
  let sqlTag: typeof import('drizzle-orm').sql;
  let reader: { name: string; url: string } | null = null;
  type Admin = Parameters<Db['ensureViewerRoles']>[0];
  /** The admin pool's own client (only while DATABASE_URL is the admin's). */
  const adminClient = () => (m.systemDb as unknown as { $client: Admin }).$client;

  /** A brain in use: roots, folders and items, and once-only moves still to do. */
  const owner = randomUUID();
  /** A brain nothing was ever made in: no root row of any kind. */
  const fresh = randomUUID();
  const tag = `tree-ro-${owner.slice(0, 8)}`;
  const ids = {
    pagesFolder: randomUUID(),
    page: randomUUID(),
    note: randomUUID(),
    digest: randomUUID(),
    app: randomUUID(),
    navFolder: randomUUID(),
  };

  const rows = async <T>(q: SQL) => (await m.db.execute(q)) as unknown as T[];

  /** Everything the reads could have written, as one comparable value. */
  const fingerprint = async () => {
    const [row] = await rows<{ nodes: string; marks: number; profiles: number }>(sqlTag`
      select
        (select coalesce(md5(string_agg(
                  n.id::text || '|' || n.path::text || '|' || n.title || '|' ||
                  n.data::text || '|' || n.updated_at::text, ',' order by n.id)), '')
           from nodes n where n.owner_id in (${owner}, ${fresh})) as nodes,
        (select count(*)::int from item_marks where actor_id in (${owner}, ${fresh})) as marks,
        (select count(*)::int from profiles where user_id in (${owner}, ${fresh})) as profiles`);
    return row!;
  };

  const node = async (id: string, type: string, path: string, title: string) => {
    await m.db.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, data, tags)
      values (${id}, ${owner}, ${type}::node_type, ${title}, ${path}::ltree,
              ${type === 'note' ? JSON.stringify({ content: 'x' }) : '{}'}::jsonb, '{}')`);
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    tree = await import('./index');
    appNav = await import('../app-nav');
    files = await import('@mantle/files');
    sqlTag = (await import('drizzle-orm')).sql;
    for (const id of [owner, fresh]) {
      await m.db.execute(sqlTag`
        insert into auth.users (id, email, password_hash, role)
        values (${id}, ${`${tag}-${id.slice(0, 4)}@example.invalid`}, 'x', 'admin')`);
      await m.db.execute(sqlTag`
        insert into spaces (id, kind, login_id) values (${id}, 'brain', ${id})`);
    }
  }, 60_000);

  afterAll(async () => {
    if (!m) return;
    // Back on the admin role, whatever state a failed test left.
    await m.closeDb();
    process.env.DATABASE_URL = URL;
    for (const id of [owner, fresh]) {
      await m.db.execute(sqlTag`delete from item_marks where actor_id = ${id}`);
      await m.db.execute(sqlTag`delete from nodes where owner_id = ${id}`);
      await m.db.execute(sqlTag`delete from profiles where user_id = ${id}`);
      await m.db.execute(sqlTag`delete from spaces where id = ${id} or login_id = ${id}`);
      await m.db.execute(sqlTag`delete from auth.users where id = ${id}`);
    }
    if (reader) {
      const { dropReadOnlyRole } = await import('@mantle/db/test-support');
      await dropReadOnlyRole(adminClient(), reader.name);
    }
    await m.closeDb();
  });

  describe('on a normal role', () => {
    it('the first read makes a missing root, once', async () => {
      for (const kind of ['pages', 'notes', 'apps'] as const) {
        expect(await tree.ensureKindRoot(owner, kind)).toBe(true);
        expect(await tree.ensureKindRoot(owner, kind)).toBe(true);
      }
      const roots = await rows<{ path: string }>(sqlTag`
        select path::text as path from nodes
         where owner_id = ${owner} and type = 'branch' order by path`);
      expect(roots.map((r) => r.path)).toEqual(['apps', 'notes', 'pages']);
    });
  });

  describe('as a role with SELECT only', () => {
    let before: Awaited<ReturnType<typeof fingerprint>>;

    beforeAll(async () => {
      await node(ids.pagesFolder, 'branch', 'pages.plans', 'Plans');
      await node(ids.page, 'page', 'pages.plans', 'Roadmap');
      await node(ids.note, 'note', 'notes', 'A note');
      // A digest from before Notes / Auto-filed: a move still to do.
      await node(ids.digest, 'note', 'assistant', 'An old digest');
      await node(ids.app, 'app', 'apps', 'Timer');
      // The old Apps layout document and pins: two more moves still to do.
      const prefs = {
        appNav: {
          rev: 1,
          entries: [
            {
              kind: 'folder',
              id: ids.navFolder,
              name: 'Work',
              children: [{ kind: 'app', id: ids.app }],
            },
          ],
        },
        appPins: [ids.app],
        appOpens: { [ids.app]: { n: 2, at: '2026-09-01T10:00:00.000Z' } },
      };
      await m.db.execute(sqlTag`
        insert into profiles (user_id, preferences)
        values (${owner}, ${JSON.stringify(prefs)}::jsonb)`);

      const { createReadOnlyRole } = await import('@mantle/db/test-support');
      reader = await createReadOnlyRole(adminClient(), URL!);
      // From here `db` is the reader, as the demo's API is.
      await m.closeDb();
      process.env.DATABASE_URL = reader.url;
      before = await fingerprint();
    }, 60_000);

    // Each test meets the database's refusal itself, not the memory of one.
    beforeEach(() => m.forgetWriteRefusals());

    it('is refused every write, even one that would change nothing', async () => {
      // The root is there, so this insert would do nothing: Postgres refuses
      // it all the same, which is why selecting first is part of the fix.
      const insert = m.db.execute(sqlTag`
        insert into nodes (owner_id, type, title, slug, path, data, tags)
        values (${owner}, 'branch', 'Pages', 'pages', 'pages', '{}'::jsonb, '{}')
        on conflict do nothing`);
      await expect(insert).rejects.toSatisfy(m.isWriteRefused);
      const update = m.db.execute(sqlTag`update nodes set title = title where false`);
      await expect(update).rejects.toSatisfy(m.isWriteRefused);
    });

    it('reads a kind whose root exists: its folders and its items', async () => {
      expect(await tree.ensureKindRoot(owner, 'pages')).toBe(true);
      const root = (await tree.loadTreeFolder(owner, 'pages'))!;
      expect(root.folders.map((f) => f.id)).toEqual([ids.pagesFolder]);
      const plans = (await tree.loadTreeFolder(owner, 'pages', { folderId: ids.pagesFolder }))!;
      expect(plans.items.map((i) => i.id)).toEqual([ids.page]);
    });

    it('reads Notes with a digest move still to do, and leaves the digest where it is', async () => {
      expect(await tree.ensureKindRoot(owner, 'notes')).toBe(true);
      expect(await tree.reconcileNotesAutoFiled(owner)).toBeNull();
      const root = (await tree.loadTreeFolder(owner, 'notes'))!;
      expect(root.items.map((i) => i.id)).toEqual([ids.note]);
      const [digest] = await rows<{ path: string }>(
        sqlTag`select path::text as path from nodes where id = ${ids.digest}`,
      );
      expect(digest!.path).toBe('assistant');
    });

    it('reads Apps with the layout and marks moves still to do', async () => {
      expect(await tree.reconcileAppNav(owner)).toBeNull();
      m.forgetWriteRefusals();
      expect(await tree.reconcileAppMarks(owner, owner)).toBeNull();
      const root = (await tree.loadTreeFolder(owner, 'apps'))!;
      expect(root.items.map((i) => i.id)).toEqual([ids.app]);
      expect(root.folders).toEqual([]);
      const pinned = await tree.listTreeMarks(owner, owner, 'apps', 'pinned');
      expect(pinned.items).toEqual([]);
    });

    it('answers /api/app-nav from the rows as they stand', async () => {
      const view = await appNav.loadAppNavView(owner, owner);
      expect(view.apps.map((a) => a.id)).toEqual([ids.app]);
      expect(view.nav.entries).toEqual([]);
      expect(view.pins).toEqual([]);
    });

    it('reads a brain with no root rows as empty kinds, never an error', async () => {
      for (const kind of tree.TREE_LIVE_KINDS) {
        m.forgetWriteRefusals();
        if (kind === 'files') expect(await files.ensureFilesRootBranch(fresh)).toBeNull();
        else expect(await tree.ensureKindRoot(fresh, kind)).toBe(false);
        const page = await tree.loadTreeFolder(fresh, kind);
        expect(page, kind).toMatchObject({ kind, folder: null, folders: [], items: [] });
      }
      m.forgetWriteRefusals();
      const view = await appNav.loadAppNavView(fresh, fresh);
      expect(view).toMatchObject({ apps: [], pins: [], nav: { entries: [] } });
    });

    it('wrote nothing', async () => {
      expect(await fingerprint()).toEqual(before);
      const made = await rows<{ n: number }>(
        sqlTag`select count(*)::int as n from nodes where owner_id = ${fresh}`,
      );
      expect(made[0]!.n).toBe(0);
    });
  });
});
