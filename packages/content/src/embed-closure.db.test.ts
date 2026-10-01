/**
 * Embedding means sharing (audit F19 follow-up), against a real, migrated
 * Postgres: lowering a page takes its images, drawings (and their images)
 * and child pages (and theirs) down with it, never an embed already lower,
 * never raising anything, never below the type ceiling; a later embed saved
 * into a page, note or drawing below admin follows it; a share link lowers
 * the same way; the boot reconcile closes the older gaps once and is a no-op
 * after; and nothing of it announces an item to the extractor. Seeds its own
 * owner and rows and removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/embed-closure.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { notifyBarrier } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('embeds follow their item down on Postgres', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let a: typeof import('./access');
  let ec: typeof import('./embed-closure');
  let s: typeof import('./shares');
  let sqlTag: typeof import('drizzle-orm').sql;
  let unlisten: () => Promise<void>;
  const announced: string[] = [];
  const owner = randomUUID();
  const tag = `embeds-${owner.slice(0, 8)}`;
  const id = {
    page: randomUUID(),
    img: randomUUID(), // file, admin
    draw: randomUUID(), // draw, admin, places drawImg
    drawImg: randomUUID(),
    child: randomUUID(), // child page, admin, embeds childImg
    childImg: randomUUID(),
    low: randomUUID(), // file already public
    journal: randomUUID(), // can never go below admin
    newFile: randomUUID(), // added to the page later
    note: randomUUID(),
    noteImg: randomUUID(),
    draw2: randomUUID(),
    draw2Img: randomUUID(),
    draw3: randomUUID(),
    draw3Img: randomUUID(),
    gapPage: randomUUID(),
    gapImg: randomUUID(),
    gapChild: randomUUID(),
    gapChildImg: randomUUID(),
  };
  const embedIds = () =>
    [
      id.img,
      id.draw,
      id.drawImg,
      id.child,
      id.childImg,
      id.low,
      id.newFile,
      id.noteImg,
      id.draw2Img,
      id.draw3Img,
      id.gapImg,
      id.gapChild,
      id.gapChildImg,
    ] as string[];

  const pageDoc = (extra: unknown[] = []) => ({
    type: 'doc',
    content: [
      { type: 'image', attrs: { nodeId: id.img } },
      { type: 'image', attrs: { drawId: id.draw } },
      { type: 'childPage', attrs: { pageId: id.child, title: 'Child' } },
      { type: 'image', attrs: { nodeId: id.low } },
      { type: 'fileEmbed', attrs: { nodeId: id.journal } },
      ...extra,
    ],
  });
  const imgDoc = (fileId: string) => ({
    type: 'doc',
    content: [{ type: 'image', attrs: { nodeId: fileId } }],
  });
  const scene = (fileId: string) => ({ elements: [{ type: 'image', id: 'e1', fileId }] });

  const audienceOf = async (nodeId: string) =>
    (
      (await m.db.execute(sqlTag`select audience from nodes where id = ${nodeId}`)) as unknown as {
        audience: string;
      }[]
    )[0]!.audience;
  /** The admin pool's own postgres-js client (LISTEN needs it). */
  const adminSql = () =>
    (m.systemDb as unknown as { $client: Parameters<typeof notifyBarrier>[0] }).$client;
  const setRaw = (nodeId: string, level: string) =>
    m.db.execute(sqlTag`update nodes set audience = ${level} where id = ${nodeId}`);

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    a = await import('./access');
    ec = await import('./embed-closure');
    s = await import('./shares');
    sqlTag = (await import('drizzle-orm')).sql;
    const sub = await adminSql().listen('node_ingested', (p: string) => announced.push(p));
    unlisten = () => sub.unlisten();

    await m.db.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role) values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`);
    const rows: Array<[string, string, string, string]> = [
      [id.page, 'page', 'Parent', 'pages'],
      [id.img, 'file', 'img.png', 'files'],
      [id.draw, 'draw', 'Sketch', 'draw'],
      [id.drawImg, 'file', 'draw-img.png', 'files'],
      [id.child, 'page', 'Child', 'pages'],
      [id.childImg, 'file', 'child-img.png', 'files'],
      [id.low, 'file', 'low.png', 'files'],
      [id.journal, 'journal', 'j', 'journal'],
      [id.newFile, 'file', 'new.png', 'files'],
      [id.note, 'note', 'A note', 'notes'],
      [id.noteImg, 'file', 'note-img.png', 'files'],
      [id.draw2, 'draw', 'Board', 'draw'],
      [id.draw2Img, 'file', 'board-img.png', 'files'],
      [id.draw3, 'draw', 'Diagram', 'draw'],
      [id.draw3Img, 'file', 'diagram-img.png', 'files'],
      [id.gapPage, 'page', 'Old public page', 'pages'],
      [id.gapImg, 'file', 'old-img.png', 'files'],
      [id.gapChild, 'page', 'Old child', 'pages'],
      [id.gapChildImg, 'file', 'old-child-img.png', 'files'],
    ];
    for (const [nid, type, title, path] of rows) {
      await m.db.execute(sqlTag`
        insert into nodes (id, owner_id, type, title, path) values
          (${nid}, ${owner}, ${type}, ${title}, ${path}::ltree)`);
    }
    await setRaw(id.low, 'public');
    const page = (nid: string, doc: unknown) =>
      m.db.execute(
        sqlTag`insert into pages (node_id, doc, doc_text) values (${nid}, ${JSON.stringify(doc)}::jsonb, '')`,
      );
    await page(id.page, pageDoc());
    await page(id.child, imgDoc(id.childImg));
    await page(id.gapPage, {
      type: 'doc',
      content: [
        { type: 'image', attrs: { nodeId: id.gapImg } },
        { type: 'childPage', attrs: { pageId: id.gapChild } },
      ],
    });
    await page(id.gapChild, imgDoc(id.gapChildImg));
    const draw = (nid: string, fileId: string, refs: Record<string, string>) =>
      m.db.execute(sqlTag`
        insert into draws (node_id, scene, file_refs) values
          (${nid}, ${JSON.stringify(scene(fileId))}::jsonb, ${JSON.stringify(refs)}::jsonb)`);
    await draw(id.draw, 'f1', { f1: id.drawImg });
    await draw(id.draw2, 'none', {});
    await draw(id.draw3, 'f3', { f3: id.draw3Img });
    // Seeding inserted rows, and an insert announces itself (0018): start the
    // record after them.
    await notifyBarrier(adminSql(), 'node_ingested', { seen: (x) => announced.includes(x) });
    announced.length = 0;
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

  it('lowering a page lowers its image, drawing, child page and theirs, not an already-lower one', async () => {
    const res = await a.setItemLevel(owner, id.page, 'client');
    expect(await audienceOf(id.page)).toBe('client');
    for (const e of [id.img, id.draw, id.drawImg, id.child, id.childImg]) {
      expect(await audienceOf(e), e).toBe('client');
    }
    expect(await audienceOf(id.low), 'a public embed is never raised').toBe('public');
    expect(res.alsoLowered.map((l) => l.id).sort()).toEqual(
      [id.img, id.draw, id.drawImg, id.child, id.childImg].sort(),
    );
    expect(res.alsoLowered.every((l) => l.from === 'admin' && l.to === 'client')).toBe(true);
    // The old field clients read carries the same items at their new level.
    expect(res.lowered.map((l) => [l.id, l.audience]).sort()).toEqual(
      res.alsoLowered.map((l) => [l.id, 'client']).sort(),
    );
    // Embeds get the level, never a link of their own; client takes no link
    // at all (client logins C1).
    expect(res.share).toBeNull();
    expect(await s.getActiveShareForNode(owner, id.img)).toBeNull();
  });

  it('respects the type ceiling: an embed that can never go below admin stays admin, reported', async () => {
    expect(await audienceOf(id.journal)).toBe('admin');
    const res = await a.setItemLevel(owner, id.page, 'client');
    expect(res.stillAbove.map((i) => i.id)).toEqual([id.journal]);
  });

  it('never raises: taking the page back to admin leaves its embeds where they are', async () => {
    const res = await a.setItemLevel(owner, id.page, 'admin');
    expect(res.alsoLowered).toEqual([]);
    expect(await audienceOf(id.img)).toBe('client');
    expect(res.stillBelow.map((i) => i.id)).toContain(id.img);
    // Lowering again to public takes them further down, the public one stays.
    await a.setItemLevel(owner, id.page, 'public');
    for (const e of [id.img, id.draw, id.drawImg, id.child, id.childImg, id.low]) {
      expect(await audienceOf(e), e).toBe('public');
    }
  });

  it('a new embed saved into a public page becomes public; one an admin raised stays raised', async () => {
    const { commitPage } = await import('./pages/draft');
    // An admin raises one embed on purpose.
    await a.setItemAudience(owner, id.img, 'admin');
    const added = { type: 'image', attrs: { nodeId: id.newFile } };
    const res = await commitPage(owner, id.page, pageDoc([added]));
    expect(res.ok).toBe(true);
    expect(await audienceOf(id.newFile)).toBe('public');
    expect(await audienceOf(id.img), 'an embed the page already had keeps its level').toBe('admin');
    // The programmatic doc write follows the same rule.
    const { updatePage } = await import('./pages/draft');
    await setRaw(id.newFile, 'admin');
    await updatePage(owner, id.page, { doc: pageDoc() }, { reindex: false });
    await updatePage(owner, id.page, { doc: pageDoc([added]) }, { reindex: false });
    expect(await audienceOf(id.newFile)).toBe('public');
  });

  it('a note below admin takes a new image to its level; a drawing commit does too', async () => {
    const notes = await import('./notes');
    await setRaw(id.note, 'team');
    await notes.updateNote(owner, id.note, { content: `![x](media:${id.noteImg})` });
    expect(await audienceOf(id.noteImg)).toBe('team');

    const draws = await import('./draws');
    await setRaw(id.draw2, 'public');
    const res = await draws.commitDraw(owner, id.draw2, scene('y'), {
      fileRefs: { y: id.draw2Img },
    });
    expect(res.ok).toBe(true);
    expect(await audienceOf(id.draw2Img)).toBe('public');
  });

  it('a share link lowers the same way, and reports what went down', async () => {
    const alsoLowered: import('./embed-closure').LoweredItem[] = [];
    await s.createShare(owner, id.draw3, { alsoLowered });
    expect(await audienceOf(id.draw3)).toBe('public');
    expect(await audienceOf(id.draw3Img)).toBe('public');
    expect(alsoLowered.map((l) => [l.id, l.from, l.to])).toEqual([
      [id.draw3Img, 'admin', 'public'],
    ]);
  });

  it('the boot reconcile closes older gaps once, and is a no-op after', async () => {
    // A page lowered before embeds followed: public, its embeds still admin.
    await setRaw(id.gapPage, 'public');
    const before = await ec.findEmbedClosureGaps(owner);
    const gap = before.find((g) => g.id === id.gapPage);
    expect(gap?.above.map((i) => i.id).sort()).toEqual(
      [id.gapImg, id.gapChild, id.gapChildImg].sort(),
    );

    const lines: string[] = [];
    const first = await ec.reconcileEmbedClosuresOnce(owner, (l) => lines.push(l));
    expect(first?.map((l) => l.id)).toEqual(
      expect.arrayContaining([id.gapImg, id.gapChild, id.gapChildImg, id.img]),
    );
    for (const e of [id.gapImg, id.gapChild, id.gapChildImg]) {
      expect(await audienceOf(e), e).toBe('public');
    }
    expect(lines.some((l) => l.includes(id.gapImg))).toBe(true);
    expect(await ec.findEmbedClosureGaps(owner)).toEqual([]);
    // Run again: nothing is left to change.
    expect(await ec.reconcileEmbedClosures(owner)).toEqual([]);

    // After it, an admin raises one embed on purpose: the next boot leaves it.
    await a.setItemAudience(owner, id.gapImg, 'admin');
    expect(await ec.reconcileEmbedClosuresOnce(owner)).toBeNull();
    expect(await audienceOf(id.gapImg)).toBe('admin');
  });

  it('nothing of it announces an embed to the extractor', async () => {
    await notifyBarrier(adminSql(), 'node_ingested', { seen: (x) => announced.includes(x) });
    expect(announced.filter((x) => embedIds().includes(x))).toEqual([]);
  });
});
