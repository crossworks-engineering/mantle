/**
 * A page's indexed text at its level (client logins plan 3.3 point 4, N13;
 * audit B1) on a real, migrated Postgres. A client or public page's
 * `doc_text` names no item its level cannot read (a mention, a link, a child
 * page card: "Private item") and folds in only the files and drawings its
 * level reads; a team page's text is unchanged. When a level moves (an
 * embedded file raised or lowered, the page's own level), the text is
 * re-folded, and nothing else happens: no summary, version or updated_at
 * change, and no announcement to the extractor. Seeds its own owner and
 * rows and removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/pages/level-text.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { notifyBarrier } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('page text at its level', () => {
  let m: typeof import('@mantle/db');
  let a: typeof import('../access');
  let draft: typeof import('./draft');
  let sqlTag: typeof import('drizzle-orm').sql;
  let unlisten: () => Promise<void>;
  const announced: string[] = [];
  const owner = randomUUID();
  const tag = `lvltext-${owner.slice(0, 8)}`;
  const id = {
    clientPage: randomUUID(),
    teamSame: randomUUID(),
    publicPage: randomUUID(),
    editedPage: randomUUID(),
    teamTitle: randomUUID(),
    shared: randomUUID(),
    clientFile: randomUUID(),
    teamFile: randomUUID(),
    teamDraw: randomUUID(),
    adminPage: randomUUID(),
    publicNote: randomUUID(),
  };
  const para = (...content: unknown[]) => ({ type: 'paragraph', content });
  const mention = (to: string, label: string) => ({
    type: 'mention',
    attrs: { id: to, label, ref: 'node' },
  });
  const linked = (text: string, href: string) => ({
    type: 'text',
    text,
    marks: [{ type: 'link', attrs: { href } }],
  });
  const body = {
    type: 'doc',
    content: [
      para(
        { type: 'text', text: 'Intro ' },
        mention(id.teamTitle, 'TEAMLABEL'),
        linked(' TEAMLINK', `/n/${id.teamTitle}`),
        mention(id.shared, 'STALELABEL'),
        linked(' ADMINABS', `https://brain.example.invalid/n/${id.adminPage}`),
        mention(id.publicNote, 'PUBLICLABEL'),
      ),
      { type: 'image', attrs: { nodeId: id.clientFile, alt: 'client pic' } },
      { type: 'image', attrs: { nodeId: id.teamFile, alt: 'TEAMALT' } },
      { type: 'image', attrs: { drawId: id.teamDraw } },
      { type: 'childPage', attrs: { pageId: id.teamTitle, title: 'TEAMCHILD' } },
      { type: 'childPage', attrs: { pageId: id.shared, title: 'STALECHILD' } },
    ],
  };
  const TEAM_WORDS = [
    'TEAMLABEL',
    'TEAMLINK',
    'TEAMTITLE',
    'TEAMCHILD',
    'TEAMALT',
    'TEAMFILETEXT',
    'TEAMDRAWTEXT',
    'ADMINABS',
    'ADMINTITLE',
    'PUBLICLABEL',
    'STALE',
  ];

  const adminSql = () =>
    (m.systemDb as unknown as { $client: Parameters<typeof notifyBarrier>[0] }).$client;
  const row = async (nodeId: string) =>
    (
      (await m.db.execute(sqlTag`
        select p.doc_text, p.version, n.data->>'summary' as summary, n.updated_at
          from pages p join nodes n on n.id = p.node_id where p.node_id = ${nodeId}`)) as unknown as {
        doc_text: string;
        version: number;
        summary: string | null;
        updated_at: unknown;
      }[]
    )[0]!;
  const settle = async () => {
    await notifyBarrier(adminSql(), 'node_ingested', { seen: (x) => announced.includes(x) });
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    a = await import('../access');
    draft = await import('./draft');
    sqlTag = (await import('drizzle-orm')).sql;
    const sub = await adminSql().listen('node_ingested', (p: string) => announced.push(p));
    unlisten = () => sub.unlisten();

    await m.db.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role) values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`);
    const rows: Array<[string, string, string, string, string, Record<string, unknown>]> = [
      [id.clientPage, 'page', 'Client page', 'pages', 'client', {}],
      [id.teamSame, 'page', 'Team page', 'pages', 'team', {}],
      [id.publicPage, 'page', 'Public page', 'pages', 'public', {}],
      [id.editedPage, 'page', 'Edited page', 'pages', 'client', {}],
      [id.teamTitle, 'page', 'Price floor TEAMTITLE', 'pages', 'team', {}],
      [id.shared, 'page', 'Shared plan today', 'pages', 'client', {}],
      [id.clientFile, 'file', 'client.png', 'files', 'client', { text: 'CLIENTFILETEXT' }],
      [id.teamFile, 'file', 'team.png', 'files', 'team', { text: 'TEAMFILETEXT' }],
      [id.teamDraw, 'draw', 'Team sketch', 'draw', 'team', {}],
      [id.adminPage, 'page', 'ADMINTITLE', 'pages', 'admin', {}],
      [id.publicNote, 'note', 'Public note today', 'notes', 'public', {}],
    ];
    for (const [nid, type, title, path, level, data] of rows) {
      await m.db.execute(sqlTag`
        insert into nodes (id, owner_id, type, title, path, audience, data) values
          (${nid}, ${owner}, ${type}, ${title}, ${path}::ltree, ${level}, ${JSON.stringify(data)}::jsonb)`);
    }
    // The published doc is already the body, so a commit adds no embed and
    // lowers nothing (embedding means sharing only follows NEW embeds).
    for (const p of [id.clientPage, id.teamSame]) {
      await m.db.execute(sqlTag`
        insert into pages (node_id, doc, doc_text) values (${p}, ${JSON.stringify(body)}::jsonb, '')`);
    }
    const empty = JSON.stringify({ type: 'doc', content: [] });
    for (const p of [id.publicPage, id.editedPage, id.teamTitle, id.shared, id.adminPage]) {
      await m.db.execute(sqlTag`
        insert into pages (node_id, doc, doc_text) values (${p}, ${empty}::jsonb, '')`);
    }
    await m.db.execute(sqlTag`
      insert into draws (node_id, scene, scene_text) values
        (${id.teamDraw}, '{"elements":[]}'::jsonb, 'TEAMDRAWTEXT')`);
  });

  afterAll(async () => {
    await unlisten();
    await m.db.execute(sqlTag`delete from shares where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from profiles where user_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
    await m.closeDb();
  });

  it('a client page commits a text that names no team, admin or public item', async () => {
    const res = await draft.commitPage(owner, id.clientPage, body);
    expect(res.ok).toBe(true);
    const text = (await row(id.clientPage)).doc_text;
    for (const w of TEAM_WORDS) expect(text, w).not.toContain(w);
    expect(text).toContain('Intro');
    expect(text).toContain('Private item');
    expect(text).toContain('client pic');
    expect(text).toContain('CLIENTFILETEXT');
    // A readable chip and child page card carry today's title.
    expect(text.split('Shared plan today').length - 1).toBe(2);
  });

  it("a team page's text is unchanged: every label and every embed's text", async () => {
    const res = await draft.commitPage(owner, id.teamSame, body);
    expect(res.ok).toBe(true);
    const text = (await row(id.teamSame)).doc_text;
    for (const w of ['TEAMLABEL', 'TEAMLINK', 'TEAMCHILD', 'TEAMFILETEXT', 'TEAMDRAWTEXT']) {
      expect(text, w).toContain(w);
    }
    expect(text).toContain('ADMINABS');
    expect(text).not.toContain('Private item');
  });

  it('a public page reads public items only: a client item is "Private item"', async () => {
    const doc = {
      type: 'doc',
      content: [
        para(mention(id.shared, 'CLIENTLABEL'), { type: 'text', text: ' and ' }),
        para(mention(id.publicNote, 'old public label')),
      ],
    };
    await m.db.execute(
      sqlTag`update pages set doc = ${JSON.stringify(doc)}::jsonb where node_id = ${id.publicPage}`,
    );
    expect((await draft.commitPage(owner, id.publicPage, doc)).ok).toBe(true);
    const text = (await row(id.publicPage)).doc_text;
    expect(text).not.toContain('CLIENTLABEL');
    expect(text).not.toContain('Shared plan today');
    expect(text).toContain('Private item');
    expect(text).toContain('Public note today');
  });

  it("a programmatic write (updatePage) filters a client page's text too", async () => {
    const doc = { type: 'doc', content: [para(mention(id.teamTitle, 'UPDTEAM'))] };
    await draft.updatePage(owner, id.editedPage, { doc }, { reindex: false });
    const text = (await row(id.editedPage)).doc_text;
    expect(text).not.toContain('UPDTEAM');
    expect(text).toContain('Private item');
  });

  it('raising an embedded file re-folds the text, and nothing else happens', async () => {
    await m.db.execute(sqlTag`
      update nodes set data = data || '{"summary":"SUMMARYKEEP"}'::jsonb where id = ${id.clientPage}`);
    const before = await row(id.clientPage);
    await settle();
    announced.length = 0;

    await a.setItemLevel(owner, id.clientFile, 'team');
    const after = await row(id.clientPage);
    expect(after.doc_text).not.toContain('CLIENTFILETEXT');
    expect(after.doc_text).not.toContain('client pic');
    // Text only: the summary, version and updated_at are as they were, and
    // the extractor heard nothing.
    expect(after.summary).toBe('SUMMARYKEEP');
    expect(after.version).toBe(before.version);
    expect(String(after.updated_at)).toBe(String(before.updated_at));
    await settle();
    expect(announced).not.toContain(id.clientPage);
    // The team page is not filtered, so raising changed nothing there.
    expect((await row(id.teamSame)).doc_text).toContain('CLIENTFILETEXT');
  });

  it('lowering an embedded file to client folds its text in', async () => {
    await a.setItemLevel(owner, id.teamFile, 'client');
    const text = (await row(id.clientPage)).doc_text;
    expect(text).toContain('TEAMFILETEXT');
    expect(text).toContain('TEAMALT');
    expect(text).not.toContain('TEAMLABEL');
  });

  it("the page's own level: raised to team, its text is the whole doc again", async () => {
    await a.setItemLevel(owner, id.clientPage, 'team');
    const text = (await row(id.clientPage)).doc_text;
    for (const w of ['TEAMLABEL', 'TEAMLINK', 'TEAMCHILD', 'TEAMDRAWTEXT']) {
      expect(text, w).toContain(w);
    }
    await settle();
    expect(announced).not.toContain(id.clientPage);
  });
});
