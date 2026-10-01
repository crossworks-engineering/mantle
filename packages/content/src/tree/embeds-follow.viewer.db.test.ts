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
  let admin: Parameters<Db['ensureViewerRoles']>[0];
  let support: typeof import('@mantle/db/test-support');
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
    // The published scene places every image in the map.
    const scene = {
      elements: Object.keys(fileRefs).map((fileId) => ({ type: 'image', fileId })),
    };
    await m.systemDb.execute(sqlTag`
      insert into draws (node_id, scene, file_refs)
      values (${id}, ${JSON.stringify(scene)}::jsonb, ${JSON.stringify(fileRefs)}::jsonb)`);
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
  /** Lose a row's edges, as a bypassed trigger would. The triggers go off and
   *  on again in one transaction, so no other session ever writes without
   *  them (theirs wait for the lock meanwhile). */
  const loseEdges = (from: string) =>
    admin.begin(async (tx) => {
      await tx`alter table node_embeds disable trigger user`;
      await tx`delete from node_embeds where from_id = ${from}`;
      await tx`alter table node_embeds enable trigger user`;
    });
  /** The repair is brain-wide: a file that forges drift and one that repairs
   *  it would undo each other's forgery mid-test, so both take this lock
   *  (tree-share.viewer.db.test.ts too). */
  const driftLock = <T>(fn: () => Promise<T>) => support.withTestLock(URL!, 'share-drift', fn);
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
    support = await import('@mantle/db/test-support');
    admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] }).$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    brain = await support.ensureTestAnchor(admin);
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
    // A draft autosave that pastes a picture opens nothing: only what the
    // published scene places counts (review F4).
    const pasted = await node('file', 'files', 'pasted.png');
    await m.systemDb.execute(sqlTag`
      update draws set file_refs = file_refs || jsonb_build_object('p', ${pasted}::text),
                       draft_scene = '{"elements":[{"type":"image","fileId":"p"}]}'::jsonb
       where node_id = ${D}`);
    expect(await reads('client', [pasted])).toEqual([]);
    // A drawing whose published scene drops its image: the image goes too.
    await m.systemDb.execute(
      sqlTag`update draws set scene = '{"elements":[]}'::jsonb where node_id = ${D}`,
    );
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

  it('an unshare closes a loop of embeds (a embeds b embeds a)', async () => {
    const loop = { id: randomUUID(), path: `notes.${label}_loop` };
    await folder(loop, 'Loop');
    const a = await note(loop.path, 'loop a', '');
    const b = await note('notes', 'loop b', `![a](media:${a})`);
    await m.systemDb.execute(sqlTag`
      update nodes set data = jsonb_build_object('content', ${`![b](media:${b})`}::text)
       where id = ${a}`);
    await setShare(loop, 'client');
    expect(await reads('client', [a, b])).toEqual(sorted(a, b));
    expect((await own(a))!.embedded_level).toBe('client'); // back to itself through b
    await setShare(loop, null);
    expect(await reads('client', [a, b])).toEqual([]);
    expect((await own(a))!.embedded_level).toBeNull();
    expect((await own(b))!.embedded_level).toBeNull();
  });

  it('an embed opens an app for reading only, never to run it (review F5)', async () => {
    await setShare(folderF, 'client');
    const app = async (title: string, audience: string) => {
      const id = await node('app', 'apps', title, {}, audience);
      await m.systemDb.execute(sqlTag`
        insert into apps (node_id, manifest, published_build)
        values (${id}, '{}'::jsonb, '{"ok": true}'::jsonb)`);
      return id;
    };
    const named = await app('named by an embed', 'admin');
    const ownApp = await app('client by its own level', 'client');
    await note(folderF.path, 'names an app', `![x](media:${named})`);
    expect((await own(named))!.embedded_level).toBe('client');
    expect(await reads('client', [named])).toEqual([named]);
    const { getClientRunnableApp, listClientApps } = await import('../client-apps');
    expect(await getClientRunnableApp(brain, named)).toBeNull();
    expect(await getClientRunnableApp(brain, ownApp)).not.toBeNull();
    const listed = (await listClientApps(brain)).map((a) => a.id);
    expect(listed).toContain(ownApp);
    expect(listed).not.toContain(named);
  });

  it('asks even when only embeds change, and counts them in seen (review F6)', async () => {
    await setShare(folderF, 'client');
    const img = await node('file', 'files', 'only-embed.png');
    // Client in its own right: moving it into the client folder changes
    // nothing about the note, but its image would open.
    const n = await node(
      'note',
      'notes',
      'already client',
      { content: `![i](media:${img})` },
      'client',
    );
    const refusal = await tree
      .moveTreeItems(brain, 'notes', [n], folderF.id)
      .then(() => null)
      .catch((e: unknown) => e as InstanceType<typeof tree.TreeVisibilityError>);
    expect(refusal).toBeInstanceOf(tree.TreeVisibilityError);
    expect(refusal!.diff.total).toBe(0);
    expect(refusal!.diff.embedsTotal).toBe(1);
    expect(refusal!.diff.alsoEmbeds).toEqual([
      { id: img, title: 'only-embed.png', from: 'admin', to: 'client', type: 'file' },
    ]);
    expect(await reads('client', [img])).toEqual([]);
    // `seen` is items plus embeds: a stale count asks again.
    await expect(
      tree.moveTreeItems(brain, 'notes', [n], folderF.id, { confirm: true, seen: 0 }),
    ).rejects.toBeInstanceOf(tree.TreeVisibilityError);
    await tree.moveTreeItems(brain, 'notes', [n], folderF.id, { confirm: true, seen: 1 });
    expect(await reads('client', [img])).toEqual([img]);
  });

  it('counts the embeds of every item, past the first hundred listed (review F6)', async () => {
    const big = { id: randomUUID(), path: `notes.${label}_big` };
    await folder(big, 'Big');
    for (let i = 0; i < 105; i++) {
      const img = await node('file', 'files', `big-${String(i).padStart(3, '0')}.png`);
      await note(big.path, `big note ${String(i).padStart(3, '0')}`, `![i](media:${img})`);
    }
    const refusal = await tree
      .updateTreeFolder(brain, 'notes', big.id, { share: 'team' })
      .then(() => null)
      .catch((e: unknown) => e as InstanceType<typeof tree.TreeVisibilityError>);
    expect(refusal!.diff.total).toBe(105);
    expect(refusal!.diff.changes).toHaveLength(100);
    expect(refusal!.diff.embedsTotal).toBe(105);
    expect(refusal!.diff.alsoEmbeds).toHaveLength(100);
  });

  it('the Access control and the rows say what an item is read through (review F2)', async () => {
    await setShare(folderF, 'client');
    const contract = await node('file', 'files', 'contract.pdf');
    const inner = await node('note', 'notes', 'inner note');
    const n = await note(
      folderF.path,
      'Kickoff',
      `![c](media:${contract})\n\n![n](media:${inner})`,
    );
    const { readThroughEmbeds } = await import('../shared-via');
    expect(await readThroughEmbeds(brain, contract)).toEqual({
      level: 'client',
      via: [{ id: n, title: 'Kickoff', type: 'note', level: 'client', through: 'folder' }],
    });
    // Nothing reaches the note itself through an embed: its share is its folder's.
    expect(await readThroughEmbeds(brain, n)).toBeNull();
    const files = await import('@mantle/files');
    expect(await files.fileById({ ownerId: brain, fileId: contract })).toMatchObject({
      audience: 'admin',
      embedded: 'client',
    });
    const { getNote } = await import('../notes');
    expect(await getNote(brain, inner)).toMatchObject({ audience: 'admin', embedded: 'client' });
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
    // Shared in the database directly (as the tree's share write does).
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
    await driftLock(async () => {
      // An edge lost and a level left behind, as a bypassed trigger would.
      await loseEdges(n);
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
  });

  it('a row deleted while the repair writes its edges drops out, the sweep goes on', async () => {
    // The nightly sweep runs against a live brain: a delete can commit
    // between the repair reading an edge and writing it. The delete here
    // holds both ends until the repair waits on them, then commits.
    const img = await node('file', 'files', 'gone.png');
    const n = await note(folderF.path, 'gone note', `![x](media:${img})`);
    await driftLock(async () => {
      await loseEdges(n);
      let repair: Promise<unknown> | undefined;
      await admin.begin(async (tx) => {
        const [me] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
        await tx`delete from nodes where id in (${n}, ${img})`;
        repair = tree.repairShareDrift().catch((err: unknown) => err);
        await support.pollUntil(
          async () => {
            const [w] = await admin<{ n: number }[]>`
              select count(*)::int as n from pg_stat_activity
               where ${me!.pid}::int = any (pg_blocking_pids(pid))
                 and query ilike '%insert into node_embeds%'`;
            return (w?.n ?? 0) > 0;
          },
          { what: 'the repair to wait on the deleted rows' },
        );
      });
      const out = await repair;
      // The database's own error (drizzle wraps it as the cause), not the SQL.
      const cause = out instanceof Error ? ((out.cause as Error | undefined) ?? out) : null;
      expect(cause?.message ?? null).toBeNull();
      expect(out).toMatchObject({ edgesDrifted: expect.any(Number) });
    });
    const left = await admin`select 1 from node_embeds where from_id = ${n} or to_id = ${img}`;
    expect(left).toHaveLength(0);
  });

  it('keeps a same-row policy: no sub-query in nodes_viewer_read', async () => {
    const [p] = (await m.systemDb.execute(sqlTag`
      select pg_get_expr(polqual, polrelid) as q from pg_policy
       where polname = 'nodes_viewer_read'`)) as unknown as Array<{ q: string }>;
    expect(p!.q).toMatch(/embedded_level/);
    expect(p!.q).not.toMatch(/node_embeds/);
  });
});
