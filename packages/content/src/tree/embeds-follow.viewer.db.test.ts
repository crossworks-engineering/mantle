/**
 * Embeds follow their embedder through a folder share (migration 0208,
 * folder audit S5): an item a shared page, drawing or note embeds is read
 * through it, wherever it lives, only while that embedder is read through
 * the share. Unshare, move out, delete, or take the embed out, and the
 * access goes; nobody's own level ever moves. Reads run inside withViewer,
 * as the real team and client roles.
 *
 * Brain rows belong to the shared test anchor (mantle_brain_id()), under
 * folders of this run's own, removed after.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/tree/embeds-follow.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('embeds follow their embedder', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let tree: typeof import('./index');
  let sqlTag: typeof import('drizzle-orm').sql;
  let brain = '';
  const label = `emb_${randomUUID().slice(0, 8)}`;
  const folderF = { id: randomUUID(), path: `notes.${label}_f` };
  const folderG = { id: randomUUID(), path: `notes.${label}_g` };
  const filesH = { id: randomUUID(), path: `files.${label}_h` };
  const made: string[] = [];

  const node = async (
    type: string,
    path: string,
    title: string,
    data: Record<string, unknown> = {},
    audience = 'admin',
  ) => {
    const id = randomUUID();
    made.push(id);
    await m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, data, tags, audience)
      values (${id}, ${brain}, ${type}::node_type, ${title}, ${path}::ltree,
              ${JSON.stringify(data)}::jsonb, '{}', ${audience})`);
    return id;
  };
  const note = (path: string, title: string, content: string) =>
    node('note', path, title, { content });
  const drawing = async (title: string, fileRefs: Record<string, string>) => {
    const id = await node('draw', 'draw', title);
    await m.systemDb.execute(sqlTag`
      insert into draws (node_id, scene, file_refs)
      values (${id}, '{}'::jsonb, ${JSON.stringify(fileRefs)}::jsonb)`);
    return id;
  };
  const page = async (path: string, title: string, doc: unknown, docText = '') => {
    const id = await node('page', path, title);
    await m.systemDb.execute(sqlTag`
      insert into pages (node_id, doc, doc_text)
      values (${id}, ${JSON.stringify(doc)}::jsonb, ${docText})`);
    return id;
  };
  const folder = async (f: { id: string; path: string }, title: string) => {
    made.push(f.id);
    await m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, slug, path, data, tags)
      values (${f.id}, ${brain}, 'branch', ${title}, ${f.path.split('.').at(-1)!.replace(/_/g, '-')},
              ${f.path}::ltree, '{}'::jsonb, '{}')`);
  };
  const setShare = (f: { id: string }, share: 'team' | 'client' | null) =>
    tree.updateTreeFolder(brain, 'notes', f.id, { share }, { confirm: true });
  /** Which of `want` the role reads. */
  const reads = async (level: 'team' | 'client', want: string[]) =>
    m.withViewer(level, async () => {
      const rows = (await m.db.execute(sqlTag`
        select id::text as id from nodes where id in (${sqlTag.join(
          want.map((id) => sqlTag`${id}::uuid`),
          sqlTag`, `,
        )})`)) as unknown as Array<{ id: string }>;
      return rows.map((r) => r.id).sort();
    });
  const sorted = (...ids: string[]) => [...ids].sort();
  const own = async (id: string) => {
    const [row] = (await m.systemDb.execute(sqlTag`
      select audience, embedded_level from nodes where id = ${id}`)) as unknown as Array<{
      audience: string;
      embedded_level: string | null;
    }>;
    return row;
  };

  // The graph: note N (in F) embeds drawing D and image I2; D embeds image
  // I1; I3 is client at its own level; I4 sits in a client-shared Files
  // folder. N2 (in G) embeds I2 too.
  let N = '';
  let N2 = '';
  let D = '';
  let I1 = '';
  let I2 = '';
  let I3 = '';
  let I4 = '';

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
    for (const kind of ['notes', 'files', 'draw', 'pages'] as const) {
      await tree.ensureKindRoot(brain, kind);
    }
    await folder(folderF, 'Shared F');
    await folder(folderG, 'Shared G');
    await folder(filesH, 'Files H');
    await m.systemDb.execute(
      sqlTag`update nodes set share_level = 'client' where id = ${filesH.id}`,
    );
    I1 = await node('file', 'files', 'i1.png');
    I2 = await node('file', 'files', 'i2.png');
    I3 = await node('file', 'files', 'i3.png', {}, 'client');
    I4 = await node('file', filesH.path, 'i4.png');
    D = await drawing('d', { a: I1 });
    N = await note(
      folderF.path,
      'n',
      `![d](draw:${D})\n\n![i2](media:${I2})\n\n![i3](media:${I3})\n\n![i4](media:${I4})`,
    );
    N2 = await note(folderG.path, 'n2', `![i2](media:${I2})`);
  });

  afterAll(async () => {
    await m.systemDb.execute(sqlTag`
      delete from nodes where id in (${sqlTag.join(
        made.map((id) => sqlTag`${id}::uuid`),
        sqlTag`, `,
      )})`);
  });

  it('keeps the edges from the stored note, drawing and page', async () => {
    const edges = (await m.systemDb.execute(sqlTag`
      select from_id::text as f, to_id::text as t from node_embeds
       where from_id in (${N}::uuid, ${D}::uuid)`)) as unknown as Array<{ f: string; t: string }>;
    expect(edges.map((e) => `${e.f === N ? 'N' : 'D'}>${e.t}`).sort()).toEqual(
      [`D>${I1}`, `N>${D}`, `N>${I2}`, `N>${I3}`, `N>${I4}`].sort(),
    );
  });

  it('a shared note makes what it embeds readable through it, transitively', async () => {
    expect(await reads('client', [N, D, I1, I2])).toEqual([]);
    await setShare(folderF, 'client');
    expect(await reads('client', [N, D, I1, I2, I3, I4])).toEqual(sorted(N, D, I1, I2, I3, I4));
    // Client level reads for the team too.
    expect(await reads('team', [D, I1])).toEqual(sorted(D, I1));
    // Nothing's own level moved.
    for (const id of [D, I1, I2]) expect((await own(id))!.audience).toBe('admin');
    expect((await own(I1))!.embedded_level).toBe('client');
  });

  it('two embedders: one unshared, the embed is still read through the other', async () => {
    await setShare(folderG, 'team');
    await setShare(folderF, null);
    // I2 is still embedded by N2 in the team-shared G; D and I1 only by N.
    expect(await reads('team', [N2, I2])).toEqual(sorted(N2, I2));
    expect(await reads('client', [I2])).toEqual([]);
    expect(await reads('client', [N, D, I1])).toEqual([]);
    expect(await reads('team', [D, I1])).toEqual([]);
    await setShare(folderG, null);
    expect(await reads('team', [I2])).toEqual([]);
  });

  it('an unshare leaves an embed its own level, and its own folder share', async () => {
    // I3 is client in its own right, I4 through its own folder: neither
    // depends on N.
    expect(await reads('client', [I3, I4])).toEqual(sorted(I3, I4));
    for (const id of [D, I1, I2]) expect((await own(id))!.audience).toBe('admin');
  });

  it('moving the embedder out of the shared folder takes the access away', async () => {
    await setShare(folderF, 'client');
    expect(await reads('client', [D, I1, I2])).toEqual(sorted(D, I1, I2));
    await tree.moveTreeItems(brain, 'notes', [N], null, { confirm: true });
    expect(await reads('client', [N, D, I1, I2])).toEqual([]);
    await tree.moveTreeItems(brain, 'notes', [N], folderF.id, { confirm: true });
    expect(await reads('client', [D, I1, I2])).toEqual(sorted(D, I1, I2));
  });

  it('taking the embed out of the note takes the access away', async () => {
    await m.systemDb.execute(sqlTag`
      update nodes set data = jsonb_set(data, '{content}', to_jsonb(${`![d](draw:${D})`}::text))
       where id = ${N}`);
    expect(await reads('client', [D, I1])).toEqual(sorted(D, I1));
    expect(await reads('client', [I2])).toEqual([]);
    // A drawing that drops its image: the image goes too.
    await m.systemDb.execute(sqlTag`update draws set file_refs = '{}'::jsonb where node_id = ${D}`);
    expect(await reads('client', [I1])).toEqual([]);
    expect(await reads('client', [D])).toEqual([D]);
  });

  it('deleting the shared folder takes the access away', async () => {
    const f = { id: randomUUID(), path: `notes.${label}_del` };
    await folder(f, 'Gone');
    const img = await node('file', 'files', 'del.png');
    const n = await note(f.path, 'in gone', `![x](media:${img})`);
    await setShare(f, 'client');
    expect(await reads('client', [img])).toEqual([img]);
    await tree.deleteTreeFolder(brain, 'notes', f.id, { confirm: true });
    expect(await reads('client', [n, img])).toEqual([]);
  });

  it('an embed opens any workspace item it names, and no admin-only kind', async () => {
    await setShare(folderF, 'client');
    // Jason, 2026-09-30: a shared folder shares what its items embed,
    // whatever kind. The type ceiling still holds: a task, a contact or a
    // secret never opens.
    const table = await node('table', 'tables', 'a table');
    const other = await node('note', 'notes', 'another note');
    const branch = { id: randomUUID(), path: `notes.${label}_named` };
    await folder(branch, 'A folder');
    const task = await node('task', 'tasks', 'a task');
    const contact = await node('contact', 'contacts', 'a contact');
    const refs = [table, other, branch.id, task, contact];
    const text = refs.map((r) => `![x](media:${r})`).join('\n\n');
    // The confirm names each and its kind before anything opens.
    const pending = await note('notes', 'names them', text);
    const diff = await tree
      .moveTreeItems(brain, 'notes', [pending], folderF.id)
      .then(() => null)
      .catch((e: unknown) => (e as { diff?: { alsoEmbeds?: unknown[] } }).diff ?? null);
    expect(
      (diff?.alsoEmbeds as Array<{ id: string; type: string }>)
        .map((c) => `${c.type}:${c.id}`)
        .sort(),
    ).toEqual([`branch:${branch.id}`, `note:${other}`, `table:${table}`].sort());
    await tree.moveTreeItems(brain, 'notes', [pending], folderF.id, { confirm: true });
    expect(await reads('client', [table, other, branch.id])).toEqual(
      sorted(table, other, branch.id),
    );
    expect(await reads('client', [task, contact])).toEqual([]);
    for (const id of [task, contact]) expect((await own(id))!.embedded_level).toBeNull();
    await tree.moveTreeItems(brain, 'notes', [pending], null, { confirm: true });
    expect(await reads('client', [table, other, branch.id])).toEqual([]);
  });

  it('a page save that adds a child page card reaches it, and folds its text', async () => {
    const secret = await node('note', 'notes', 'Secret plans');
    const child = await page(
      'pages',
      'child',
      {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'See ' },
              {
                type: 'mention',
                attrs: { id: secret, label: 'Secret plans', ref: 'node', kind: null },
              },
            ],
          },
        ],
      },
      'See Secret plans',
    );
    // Pages folders are not in the tree yet (phase 7): shared in the
    // database, as a later tree write will.
    const f = { id: randomUUID(), path: `pages.${label}_p` };
    await folder(f, 'Pages P');
    await m.systemDb.execute(sqlTag`update nodes set share_level = 'client' where id = ${f.id}`);
    const parent = await page(f.path, 'parent', { type: 'doc', content: [] });
    expect(await reads('client', [parent, child])).toEqual([parent]);
    const { commitPage } = await import('../pages/draft');
    const res = await commitPage(brain, parent, {
      type: 'doc',
      content: [{ type: 'childPage', attrs: { pageId: child, title: 'child', icon: null } }],
    });
    expect(res.ok).toBe(true);
    expect(await reads('client', [parent, child, secret])).toEqual(sorted(parent, child));
    const [row] = (await m.systemDb.execute(sqlTag`
      select doc_text from pages where node_id = ${child}`)) as unknown as Array<{
      doc_text: string;
    }>;
    // The child's indexed text no longer names what a client cannot read.
    expect(row!.doc_text).not.toMatch(/Secret plans/);
    await m.systemDb.execute(sqlTag`update nodes set share_level = null where id = ${f.id}`);
    expect(await reads('client', [parent, child])).toEqual([]);
  });

  it('a member draft that embeds a brain item passes no share on', async () => {
    const img = await node('file', 'files', 'draft.png');
    const member = randomUUID();
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role)
      values (${member}, ${`${label}-m@example.invalid`}, 'x', 'member')`);
    const [space] = (await m.systemDb.execute(sqlTag`
      select id::text as id from spaces where login_id = ${member} and kind = 'personal'`)) as unknown as Array<{
      id: string;
    }>;
    const draft = randomUUID();
    try {
      // A draft is another owner's row: even in a shared folder it never
      // inherits, and its edges open nothing.
      await m.systemDb.execute(sqlTag`
        insert into nodes (id, owner_id, type, title, path, data, tags)
        values (${draft}, ${space!.id}, 'note', 'draft', ${folderF.path}::ltree,
                ${JSON.stringify({ content: `![x](media:${img})` })}::jsonb, '{}')`);
      expect(await reads('client', [img])).toEqual([]);
    } finally {
      await m.systemDb.execute(sqlTag`delete from nodes where owner_id = ${space!.id}`);
      await m.systemDb.execute(sqlTag`delete from spaces where id = ${space!.id}`);
      await m.systemDb.execute(sqlTag`delete from auth.users where id = ${member}`);
    }
  });

  it('repairs a wrong embedded level and a missing edge (share drift)', async () => {
    await setShare(folderF, 'client');
    const img = await node('file', 'files', 'drift.png');
    const n = await note(folderF.path, 'drift note', `![x](media:${img})`);
    expect(await reads('client', [img])).toEqual([img]);
    // An edge lost and a level left behind, as a bypassed trigger would.
    await m.systemDb.execute(sqlTag`alter table node_embeds disable trigger user`);
    await m.systemDb.execute(sqlTag`delete from node_embeds where from_id = ${n}`);
    await m.systemDb.execute(sqlTag`alter table node_embeds enable trigger user`);
    await m.systemDb.execute(sqlTag`update nodes set embedded_level = 'client' where id = ${I1}`);
    const dry = await tree.repairShareDrift({ dryRun: true });
    expect(dry.edgesDrifted).toBeGreaterThanOrEqual(1);
    expect(dry.embeddedDrifted).toBeGreaterThanOrEqual(1);
    const fixed = await tree.repairShareDrift();
    expect(fixed.edgesDrifted).toBeGreaterThanOrEqual(1);
    expect(await reads('client', [img])).toEqual([img]);
    expect((await own(I1))!.embedded_level).toBeNull();
    const again = await tree.repairShareDrift({ dryRun: true });
    expect(again).toMatchObject({ edgesDrifted: 0, embeddedDrifted: 0 });
  });

  it('keeps a same-row policy: no sub-query in nodes_viewer_read', async () => {
    const [p] = (await m.systemDb.execute(sqlTag`
      select pg_get_expr(polqual, polrelid) as q from pg_policy
       where polname = 'nodes_viewer_read'`)) as unknown as Array<{ q: string }>;
    expect(p!.q).toMatch(/embedded_level/);
    expect(p!.q).not.toMatch(/node_embeds/);
  });
});
