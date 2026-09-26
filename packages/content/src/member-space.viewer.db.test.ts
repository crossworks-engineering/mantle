/**
 * A member's personal space end to end on a real, migrated Postgres (member
 * logins Phase 2): create, autosave, Save version, share, team drafts,
 * submit (frozen), recall, delete, all through the ordinary content
 * functions inside withSpace. Also proves nothing is announced to the
 * extractor (cost-safety: no save may start LLM work).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/member-space.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('member personal space', () => {
  type Db = typeof import('@mantle/db');
  type Space = typeof import('./member-space');
  type Draft = typeof import('./pages/draft');
  let m: Db;
  let sp: Space;
  let draft: Draft;
  let sqlTag: typeof import('drizzle-orm').sql;
  let unlisten: () => Promise<void>;
  const announced: string[] = [];
  const tag = `mspace-${randomUUID().slice(0, 8)}`;
  const loginA = randomUUID();
  const loginB = randomUUID();
  let spaceA: string;
  let spaceB: string;

  const asA = <T>(fn: () => Promise<T>) => m.withSpace({ spaceId: spaceA, loginId: loginA }, fn);
  const asB = <T>(fn: () => Promise<T>) => m.withSpace({ spaceId: spaceB, loginId: loginB }, fn);
  const doc = (text: string) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    sp = await import('./member-space');
    draft = await import('./pages/draft');
    sqlTag = (await import('drizzle-orm')).sql;
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);

    // LISTEN on the admin client's own dedicated connection.
    const sub = await admin.listen('node_ingested', (id: string) => announced.push(id));
    unlisten = () => sub.unlisten();

    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role) values
        (${loginA}, ${`${tag}-a@example.invalid`}, 'x', 'member'),
        (${loginB}, ${`${tag}-b@example.invalid`}, 'x', 'member')`);
    const rows = (await m.systemDb.execute(sqlTag`
      select id, login_id from spaces where kind = 'personal'
        and login_id in (${loginA}, ${loginB})`)) as unknown as {
      id: string;
      login_id: string;
    }[];
    spaceA = rows.find((r) => r.login_id === loginA)!.id;
    spaceB = rows.find((r) => r.login_id === loginB)!.id;
  });

  afterAll(async () => {
    await unlisten();
    await m.systemDb.execute(sqlTag`delete from spaces where login_id in (${loginA}, ${loginB})`);
    await m.systemDb.execute(sqlTag`delete from auth.users where id in (${loginA}, ${loginB})`);
    await m.closeDb();
  });

  let pageId: string;
  let noteId: string;
  let drawId: string;

  it('creates a page, a note and a drawing in the own space: private drafts', async () => {
    const page = await asA(() => sp.createMineItem(spaceA, { type: 'page', title: `${tag} plan` }));
    const note = await asA(() =>
      sp.createMineItem(spaceA, { type: 'note', title: `${tag} idea`, content: 'hello' }),
    );
    const draw = await asA(() =>
      sp.createMineItem(spaceA, { type: 'draw', title: `${tag} sketch` }),
    );
    pageId = page.id;
    noteId = note.id;
    drawId = draw.id;
    expect([page.sharing, page.reviewState, page.authorLoginId]).toEqual([
      'private',
      'draft',
      loginA,
    ]);
    const mine = await asA(() => sp.listMine(spaceA));
    expect(mine.items.map((i) => i.title).sort()).toEqual(
      [`${tag} idea`, `${tag} plan`, `${tag} sketch`].sort(),
    );
    // The space's own roots were made in the space, not in the brain.
    const owners = (await m.systemDb.execute(sqlTag`
      select distinct owner_id from nodes where id in (${pageId}, ${noteId}, ${drawId})`)) as unknown as {
      owner_id: string;
    }[];
    expect(owners.map((o) => o.owner_id)).toEqual([spaceA]);
  });

  it('autosave keeps a draft; Save version publishes it', async () => {
    const saved = await asA(() => draft.saveDraft(spaceA, pageId, doc('first draft')));
    expect(saved.ok).toBe(true);
    const got = await asA(() => sp.getMineItem(spaceA, pageId));
    expect(got?.body.type === 'page' && got.body.page.draft).toBeTruthy();
    const committed = await asA(() => draft.commitPage(spaceA, pageId, doc('version one')));
    expect(committed.ok).toBe(true);
  });

  it('another member cannot see a private item, even by id, nor change it', async () => {
    expect(await asB(() => sp.getMineItem(spaceB, pageId))).toBeNull();
    await expect(asB(() => sp.assertEditable(spaceB, pageId))).rejects.toMatchObject({
      reason: 'not-found',
    });
    await expect(asB(() => sp.submitItem(spaceB, pageId))).rejects.toMatchObject({
      reason: 'not-found',
    });
    const drafts = await m.withTeamDrafts(() => sp.listTeamDrafts(loginB, { q: tag }));
    expect(drafts.items).toEqual([]);
  });

  it('shared with the team: teammates read the saved version, never the draft', async () => {
    await asA(() => sp.setSharing(spaceA, pageId, 'team'));
    await asA(() => draft.saveDraft(spaceA, pageId, doc('unsaved secret')));
    const drafts = await m.withTeamDrafts(() => sp.listTeamDrafts(loginB, { q: tag }));
    expect(drafts.items.map((i) => i.id)).toEqual([pageId]);
    const item = await m.withTeamDrafts(() => sp.getTeamDraftItem(pageId));
    expect(item?.body.type).toBe('page');
    const text = JSON.stringify(item?.body.type === 'page' ? item.body.page : null);
    expect(text).toContain('version one');
    expect(text).not.toContain('unsaved secret');
    // Its author sees it in Mine, not in Team drafts.
    const own = await m.withTeamDrafts(() => sp.listTeamDrafts(loginA, { q: tag }));
    expect(own.items).toEqual([]);
  });

  it('submit refuses unsaved edits, then freezes the item', async () => {
    await expect(asA(() => sp.submitItem(spaceA, pageId))).rejects.toMatchObject({
      reason: 'unsaved-draft',
    });
    await asA(() => draft.commitPageDraft(spaceA, pageId));
    const submitted = await asA(() => sp.submitItem(spaceA, pageId));
    expect(submitted.reviewState).toBe('submitted');
    await expect(asA(() => sp.assertEditable(spaceA, pageId))).rejects.toMatchObject({
      reason: 'frozen',
    });
    // The row rules hold it even for a caller that skips the check.
    const res = await asA(() => draft.saveDraft(spaceA, pageId, doc('sneaky')));
    const row = (await m.systemDb.execute(
      sqlTag`select draft_doc from pages where node_id = ${pageId}`,
    )) as unknown as { draft_doc: unknown }[];
    expect(row[0]?.draft_doc).toBeNull();
    expect(res.ok === true && JSON.stringify(row[0]?.draft_doc).includes('sneaky')).toBe(false);
    await expect(asA(() => sp.deleteMineItem(spaceA, pageId))).rejects.toMatchObject({
      reason: 'frozen',
    });
  });

  it('recall returns it to draft; it edits and submits again', async () => {
    const recalled = await asA(() => sp.recallItem(spaceA, pageId));
    expect(recalled.reviewState).toBe('draft');
    expect((await asA(() => draft.saveDraft(spaceA, pageId, doc('fixed')))).ok).toBe(true);
    await asA(() => draft.commitPageDraft(spaceA, pageId));
    expect((await asA(() => sp.submitItem(spaceA, pageId))).reviewState).toBe('submitted');
    await expect(asA(() => sp.recallItem(spaceA, noteId))).rejects.toMatchObject({
      reason: 'not-submitted',
    });
  });

  it('deletes a draft page (the Recall clean-up must not touch the space transaction)', async () => {
    const extra = await asA(() =>
      sp.createMineItem(spaceA, { type: 'page', title: `${tag} scratch` }),
    );
    await asA(() => draft.commitPage(spaceA, extra.id, doc('to delete')));
    expect(await asA(() => sp.deleteMineItem(spaceA, extra.id))).toBe(true);
    expect(await asA(() => sp.getMineRow(spaceA, extra.id))).toBeNull();
  });

  it('deletes a draft item; a frozen one stays', async () => {
    expect(await asA(() => sp.deleteMineItem(spaceA, noteId))).toBe(true);
    expect(await asA(() => sp.deleteMineItem(spaceA, drawId))).toBe(true);
    const left = await asA(() => sp.listMine(spaceA));
    expect(left.items.map((i) => i.id)).toEqual([pageId]);
  });

  it('nothing in the space was ever announced to the extractor', async () => {
    await new Promise((r) => setTimeout(r, 300));
    expect(announced.filter((id) => [pageId, noteId, drawId].includes(id))).toEqual([]);
  });

  it('the brain does not see personal items: the anchor-scoped list is blind to them', async () => {
    const hits = (await m.systemDb.execute(sqlTag`
      select count(*)::int as n from nodes where owner_id = mantle_brain_id() and title like ${`${tag}%`}`)) as unknown as {
      n: number;
    }[];
    expect(hits[0]?.n).toBe(0);
    // Clean up the frozen page as the admin would (purge path).
    await m.systemDb.execute(sqlTag`delete from nodes where owner_id in (${spaceA}, ${spaceB})`);
  });
});
