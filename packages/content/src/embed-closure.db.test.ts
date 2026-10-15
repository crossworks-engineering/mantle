/**
 * Embeds change no one's access (workspaces W5b2), on a scratch brain the
 * workspaces migration made live: a page, a note and a drawing that gain an
 * embed in a save keep the embed's grants exactly as they were (the levels
 * are frozen, so a save that still lowered one would fail), the database
 * still records the edge (the Grant Access panel and the share pages read
 * it), and nothing of it announces the embed to the extractor. "Grant these
 * too" in the Grant Access panel is the only way an embed gains readers.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/embed-closure.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { teamWorkspaceSql } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)("embeds change no one's access", () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let ts: Ts;
  let pages: typeof import('./pages');
  let notes: typeof import('./notes');
  let draws: typeof import('./draws');
  const owner = randomUUID();
  let team = '';
  let admin = '';
  const announced: string[] = [];
  let unlisten: () => Promise<void> = async () => {};
  const id = {
    page: randomUUID(),
    note: randomUUID(),
    draw: randomUUID(),
    file: randomUUID(),
    file2: randomUUID(),
    child: randomUUID(),
  };

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const client = () =>
    (m.systemDb as unknown as { $client: Parameters<Ts['notifyBarrier']>[0] }).$client;
  const node = (nid: string, type: string, title: string, path: string, data = {}) =>
    x(sql`insert into nodes (id, owner_id, type, title, path, data)
          values (${nid}, ${owner}, ${type}::node_type, ${title}, ${path}::ltree,
                  ${JSON.stringify(data)}::jsonb)`);
  const grant = (nid: string, ws: string) =>
    m.withHeads([nid], 'update', (tx) =>
      tx.execute(sql`insert into item_grants (node_id, workspace_id) values (${nid}, ${ws})
                     on conflict do nothing`),
    );
  /** An item's grant rows and read_ws, to compare before and after. */
  const access = async (nid: string) => ({
    rows: await x<{ ws: string; write: boolean; home: boolean }>(
      sql`select workspace_id::text as ws, write, is_home as home from item_grants
           where node_id = ${nid} order by workspace_id`,
    ),
    read: (
      await x<{ r: string[] }>(sql`select read_ws::text[] as r from nodes where id = ${nid}`)
    )[0]!.r,
  });
  const edges = async (from: string) =>
    (
      await x<{ t: string }>(
        sql`select to_id::text as t from node_embeds where from_id = ${from} order by to_id`,
      )
    ).map((e) => e.t);

  beforeAll(async () => {
    ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    pages = await import('./pages');
    notes = await import('./notes');
    draws = await import('./draws');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role) values
      (${owner}, ${`embeds-${owner.slice(0, 8)}@example.invalid`}, 'x', true, 'admin')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await (await import('@mantle/db/test-support')).runWorkspacesSwitch();
    // A Team as a brain switched before 0286 has it (a new brain has none).
    await x(sql.raw(teamWorkspaceSql(owner)));
    const ws = await x<{ id: string; key: string }>(sql`
      select id::text as id, (case when is_admin then 'admin' when name = 'Team' then 'team' end) as key from workspaces where owner_id = ${owner}`);
    team = ws.find((w) => w.key === 'team')!.id;
    admin = ws.find((w) => w.key === 'admin')!.id;

    await node(id.page, 'page', 'Team page', 'pages');
    await node(id.child, 'page', 'Admin child page', 'pages');
    await node(id.note, 'note', 'Team note', 'notes', { content: 'Valve check.' });
    await node(id.draw, 'draw', 'Team sketch', 'draw');
    await node(id.file, 'file', 'admin-pic.png', 'files');
    await node(id.file2, 'file', 'admin-pic-2.png', 'files');
    const empty = JSON.stringify({ type: 'doc', content: [] });
    await x(sql`insert into pages (node_id, doc, doc_text) values
      (${id.page}, ${empty}::jsonb, ''), (${id.child}, ${empty}::jsonb, '')`);
    await x(sql`insert into draws (node_id, scene) values (${id.draw}, '{"elements":[]}'::jsonb)`);
    // The page, note and drawing are Team's; what they will embed is not.
    for (const nid of [id.page, id.note, id.draw]) await grant(nid, team);

    const sub = await client().listen('node_ingested', (p: string) => announced.push(p));
    unlisten = () => sub.unlisten();
  }, 180_000);

  afterAll(async () => {
    await unlisten();
    await m?.closeDb();
    await scratch?.drop();
  });

  it('the setup: the hosts are Team and Admin, the embeds Admin only', async () => {
    expect((await access(id.page)).read.sort()).toEqual([admin, team].sort());
    for (const nid of [id.file, id.file2, id.child]) {
      expect((await access(nid)).read).toEqual([admin]);
    }
  });

  it('a page commit that adds an image and a child page leaves their grants alone', async () => {
    const before = [await access(id.file), await access(id.child)];
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Pump overhaul.' }] },
        { type: 'image', attrs: { nodeId: id.file, alt: 'pic' } },
        { type: 'childPage', attrs: { pageId: id.child, title: 'Admin child page' } },
      ],
    };
    const res = await pages.commitPage(owner, id.page, doc);
    expect(res.ok).toBe(true);
    expect([await access(id.file), await access(id.child)]).toEqual(before);
    expect(await edges(id.page)).toEqual([id.file, id.child].sort());
    // updatePage (the programmatic write) the same.
    const res2 = await pages.updatePage(owner, id.page, {
      doc: { ...doc, content: [...doc.content, { type: 'image', attrs: { nodeId: id.file2 } }] },
    });
    expect(res2).not.toBeNull();
    expect(await access(id.file2)).toEqual({
      rows: [{ ws: admin, write: false, home: true }],
      read: [admin],
    });
  });

  it('a note that gains an image leaves its grants alone', async () => {
    const before = await access(id.file);
    const row = await notes.updateNote(owner, id.note, {
      content: `Valve check ![gauge](media:${id.file})`,
    });
    expect(row).not.toBeNull();
    expect(await access(id.file)).toEqual(before);
    expect(await edges(id.note)).toEqual([id.file]);
  });

  it('a drawing commit that places an image leaves its grants alone', async () => {
    const before = await access(id.file2);
    const res = await draws.commitDraw(
      owner,
      id.draw,
      { elements: [{ id: 'e1', type: 'image', fileId: 'f1' }] },
      { fileRefs: { f1: id.file2 } },
    );
    expect(res.ok).toBe(true);
    expect(await access(id.file2)).toEqual(before);
    expect(await edges(id.draw)).toEqual([id.file2]);
  });

  it('nothing of it announces an embed to the extractor', async () => {
    await ts.notifyBarrier(client(), 'node_ingested', {
      seen: (p) => announced.includes(p),
    });
    for (const nid of [id.file, id.file2, id.child]) expect(announced).not.toContain(nid);
  });
});
