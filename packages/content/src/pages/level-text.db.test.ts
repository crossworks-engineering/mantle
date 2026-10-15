/**
 * A page's indexed text by its holders (workspaces plan 5.3, W5b2), on a
 * scratch brain the workspaces migration made live. `doc_text` holds the
 * page's own words: an embed is a plain marker, and a mention or link of
 * another item carries that item's title only when every workspace that
 * holds the page also holds the item, else "Private item" (an entity
 * mention chip always keeps its label: the author's own words). After a grant change
 * `refoldPageTexts` rewrites the text, and nothing else happens: no summary,
 * version or updated_at change, no announcement to the extractor.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/pages/level-text.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { teamWorkspaceSql } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('page text by its holders', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let ts: Ts;
  let pages: typeof import('./index');
  const owner = randomUUID();
  let team = '';
  let admin = '';
  const announced: string[] = [];
  let unlisten: () => Promise<void> = async () => {};
  const id = {
    teamPage: randomUUID(),
    adminPage: randomUUID(),
    shared: randomUUID(),
    adminNote: randomUUID(),
    adminOnly: randomUUID(),
    file: randomUUID(),
  };
  const para = (...content: unknown[]) => ({ type: 'paragraph', content });
  const mention = (to: string, label: string, ref = 'node') => ({
    type: 'mention',
    attrs: { id: to, label, ref },
  });
  const linked = (text: string, href: string, more: unknown[] = []) => ({
    type: 'text',
    text,
    marks: [...more, { type: 'link', attrs: { href } }],
  });
  const body = () => ({
    type: 'doc',
    content: [
      para(
        { type: 'text', text: 'Intro ' },
        mention(id.shared, 'STALELABEL'),
        mention(id.adminNote, 'ADMINLABEL'),
        // One link over two runs reads "Private item" once.
        linked(' ADMINLINK', `/n/${id.adminNote}`),
        linked(' ADMINLINKBOLD', `/n/${id.adminNote}`, [{ type: 'bold' }]),
        linked(' ADMINABS', `https://brain.example.invalid/n/${id.adminNote}`),
        mention(randomUUID(), 'ENTITYLABEL', 'entity'),
        linked(' the wiki', 'https://example.invalid/wiki'),
      ),
      { type: 'image', attrs: { nodeId: id.file, alt: 'FILEALT' } },
      { type: 'childPage', attrs: { pageId: id.adminPage, title: 'ADMINCHILD' } },
    ],
  });

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const client = () =>
    (m.systemDb as unknown as { $client: Parameters<Ts['notifyBarrier']>[0] }).$client;
  const settle = () =>
    ts.notifyBarrier(client(), 'node_ingested', { seen: (p) => announced.includes(p) });
  const node = (nid: string, type: string, title: string, path: string) =>
    x(sql`insert into nodes (id, owner_id, type, title, path)
          values (${nid}, ${owner}, ${type}::node_type, ${title}, ${path}::ltree)`);
  const grant = (nid: string, ws: string) =>
    m.withHeads([nid], 'update', (tx) =>
      tx.execute(sql`insert into item_grants (node_id, workspace_id) values (${nid}, ${ws})
                     on conflict do nothing`),
    );
  const row = async (nid: string) =>
    (
      await x<{ doc_text: string; version: number; summary: string | null; updated_at: unknown }>(
        sql`select p.doc_text, p.version, n.data->>'summary' as summary, n.updated_at::text
              from pages p join nodes n on n.id = p.node_id where p.node_id = ${nid}`,
      )
    )[0]!;
  const count = (text: string, w: string) => text.split(w).length - 1;

  beforeAll(async () => {
    ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    pages = await import('./index');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role) values
      (${owner}, ${`lvltext-${owner.slice(0, 8)}@example.invalid`}, 'x', true, 'admin')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await (await import('@mantle/db/test-support')).runWorkspacesSwitch();
    // A Team as a brain switched before 0286 has it (a new brain has none).
    await x(sql.raw(teamWorkspaceSql(owner)));
    const ws = await x<{ id: string; key: string }>(sql`
      select id::text as id, (case when is_admin then 'admin' when name = 'Team' then 'team' end) as key from workspaces where owner_id = ${owner}`);
    team = ws.find((w) => w.key === 'team')!.id;
    admin = ws.find((w) => w.key === 'admin')!.id;

    // Every new brain item is homed in Admin; the Team page and the shared
    // note are Team's too.
    await node(id.teamPage, 'page', 'Team page', 'pages');
    await node(id.adminPage, 'page', 'Admin page ADMINTITLE', 'pages');
    await node(id.shared, 'note', 'Shared note today', 'notes');
    await node(id.adminNote, 'note', 'Admin note ADMINNOTETITLE', 'notes');
    await node(id.file, 'file', 'FILETITLE.png', 'files');
    const empty = JSON.stringify({ type: 'doc', content: [] });
    await x(sql`insert into pages (node_id, doc, doc_text) values
      (${id.teamPage}, ${empty}::jsonb, ''), (${id.adminPage}, ${empty}::jsonb, '')`);
    await grant(id.teamPage, team);
    await grant(id.shared, team);

    const sub = await client().listen('node_ingested', (p: string) => announced.push(p));
    unlisten = () => sub.unlisten();
  }, 180_000);

  afterAll(async () => {
    await unlisten();
    await m?.closeDb();
    await scratch?.drop();
  });

  it('a page Team and Admin hold names only what both hold', async () => {
    expect((await pages.commitPage(owner, id.teamPage, body())).ok).toBe(true);
    const text = (await row(id.teamPage)).doc_text;
    expect(text).toContain('Intro');
    // Held by both: today's title, not the stored label.
    expect(text).toContain('Shared note today');
    expect(text).not.toContain('STALELABEL');
    // Admin only (a note, an absolute link to it): "Private item".
    for (const w of ['ADMINLABEL', 'ADMINLINK', 'ADMINABS', 'ADMINNOTETITLE']) {
      expect(text, w).not.toContain(w);
    }
    // The mention, the link (two runs, once), the absolute link.
    expect(count(text, 'Private item')).toBe(3);
    // An entity mention is the author's own words: always kept.
    expect(text).toContain('ENTITYLABEL');
    // An external link names no item: it stays.
    expect(text).toContain('the wiki');
    // Every embed is a marker, held or not, never its words.
    expect(text).toContain('[embedded file]');
    expect(text).toContain('[embedded page]');
    for (const w of ['FILEALT', 'FILETITLE', 'ADMINCHILD', 'ADMINTITLE']) {
      expect(text, w).not.toContain(w);
    }
  });

  it('a page Admin alone holds names everything Admin holds', async () => {
    expect((await pages.commitPage(owner, id.adminPage, body())).ok).toBe(true);
    const text = (await row(id.adminPage)).doc_text;
    expect(text).toContain('Shared note today');
    expect(text).toContain('Admin note ADMINNOTETITLE');
    for (const w of ['ADMINLINK', 'ADMINLINKBOLD', 'ADMINABS', 'ENTITYLABEL']) {
      expect(text, w).toContain(w);
    }
    expect(text).not.toContain('Private item');
    expect(text).toContain('[embedded file]');
  });

  it('a programmatic write (updatePage) folds the same way', async () => {
    const doc = { type: 'doc', content: [para(mention(id.adminNote, 'UPDLABEL'))] };
    await pages.updatePage(owner, id.teamPage, { doc });
    const text = (await row(id.teamPage)).doc_text;
    expect(text).not.toContain('UPDLABEL');
    expect(text).toContain('Private item');
    // Back to the full body for the refold below.
    expect((await pages.commitPage(owner, id.teamPage, body())).ok).toBe(true);
  });

  it('a page made in the brain folds by the holders its insert gave it', async () => {
    const made = await pages.createPage(owner, {
      title: 'Made here',
      doc: { type: 'doc', content: [para(mention(id.adminNote, 'MADELABEL'))] },
    });
    const text = (await row(made.id)).doc_text;
    // Admin alone holds a new page (its home): the note's title.
    expect(text).toContain('Admin note ADMINNOTETITLE');
    expect(await pages.pageHolders(made.id)).toEqual([admin]);
  });

  it('a grant change re-folds the text, and nothing else happens', async () => {
    await x(sql`update nodes set data = data || '{"summary":"SUMMARYKEEP"}'::jsonb
                 where id = ${id.teamPage}`);
    const before = await row(id.teamPage);
    await settle();
    announced.length = 0;

    // Team now holds the Admin note too: the Team page may name it.
    await grant(id.adminNote, team);
    expect(await pages.refoldPageTexts(owner, [id.adminNote])).toBeGreaterThanOrEqual(1);
    const after = await row(id.teamPage);
    expect(after.doc_text).toContain('Admin note ADMINNOTETITLE');
    expect(after.doc_text).toContain('ADMINLINK');
    expect(after.doc_text).toContain('ENTITYLABEL');
    expect(after.doc_text).not.toContain('Private item');
    // Text only: summary, version and updated_at as they were, and the
    // extractor heard nothing.
    expect(after.summary).toBe('SUMMARYKEEP');
    expect(after.version).toBe(before.version);
    expect(String(after.updated_at)).toBe(String(before.updated_at));
    await settle();
    expect(announced).not.toContain(id.teamPage);
  });

  it("the page's own holders: Team joins the Admin page, an Admin-only item goes private", async () => {
    await node(id.adminOnly, 'note', 'Still ADMINONLYTITLE', 'notes');
    const doc = {
      type: 'doc',
      content: [para(mention(id.adminOnly, 'X'), mention(randomUUID(), 'ENTITY2', 'entity'))],
    };
    expect((await pages.commitPage(owner, id.adminPage, doc)).ok).toBe(true);
    expect((await row(id.adminPage)).doc_text).toContain('Still ADMINONLYTITLE');
    await grant(id.adminPage, team);
    await pages.refoldPageTexts(owner, [id.adminPage]);
    const text = (await row(id.adminPage)).doc_text;
    expect(text).not.toContain('ADMINONLYTITLE');
    expect(text).toContain('ENTITY2');
    expect(count(text, 'Private item')).toBe(1);
  });

  it('a page no workspace holds is not filtered (no database read)', async () => {
    const t = await pages.pageDocText(owner, [], body());
    expect(t).toContain('ENTITYLABEL');
    expect(t).toContain('STALELABEL');
    expect(t).not.toContain('Private item');
  });
});
