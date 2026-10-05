/**
 * The submitted bundle and the admin-pool deletes, on a real, migrated
 * Postgres (final audit of member logins, 2026-09-28):
 *
 *  - F04: Submit refuses while an item shown inside has unsaved edits, and
 *    records the bundle; the whole bundle stays frozen until Recall, Return
 *    or Accept, and Accept moves exactly the recorded bundle.
 *  - F18: a left-behind item takes only what is itself shared or submitted,
 *    and its author's private embeds are never served to an admin; the purge
 *    keeps every item a shared or submitted item shows.
 *  - F21: a deleted login's space is purged 30 days after it lost its login.
 *  - F03: the purge and Discard never delete a row an Accept re-owned to the
 *    brain meanwhile (two connections, one holding the row lock).
 *  - F24: a Recall or Submit that loses a race answers an error, not a stale
 *    200.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/member-bundle.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the submitted bundle, the purge and the review deletes', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let sp: typeof import('./member-space');
  let sf: typeof import('./member-space-files');
  let rv: typeof import('./member-review');
  let pg: typeof import('./member-space-purge');
  let dr: typeof import('./draws');
  let fp: typeof import('@mantle/files');
  let sqlTag: typeof import('drizzle-orm').sql;
  /** The admin pool's own driver: a second connection for the lock holder. */
  type Sql = Parameters<Db['ensureViewerRoles']>[0];
  let other: Sql;
  const tag = `mbundle-${randomUUID().slice(0, 8)}`;
  const logins = {
    a: randomUUID(), // F04: submit, freeze, accept
    b: randomUUID(), // F18: a left-behind bundle
    c: randomUUID(), // F18: the purge keeps bundles
    d: randomUUID(), // F21: a deleted login's space
    e: randomUUID(), // F03: purge race
    f: randomUUID(), // F03: discard race
    g: randomUUID(), // F24: recall and submit races
  };
  const spaceOf: Record<string, string> = {};
  const anchor = randomUUID();
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-bundle-'));
  const moved: string[] = [];
  const reviewer = () => ({ loginId: anchor });

  const as = <T>(login: string, fn: () => Promise<T>) =>
    m.withSpace({ spaceId: spaceOf[login]!, loginId: login }, fn);
  const exec = async <T>(q: ReturnType<typeof sqlTag>) =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const ownerOf = async (id: string) =>
    (await exec<{ owner_id: string }>(sqlTag`select owner_id from nodes where id = ${id}`))[0]
      ?.owner_id;
  const bundleOf = async (rootId: string) =>
    (
      await exec<{ node_id: string }>(
        sqlTag`select node_id from space_item_bundles where root_id = ${rootId} order by position`,
      )
    ).map((r) => r.node_id);
  const spool = (text: string) =>
    fp.spoolUpload(Readable.from([Buffer.from(text)]), {
      maxBytes: sf.SPACE_FILE_MAX_BYTES,
      dir: fp.spaceSpoolDir(),
    });
  const scene = (n: number) => ({
    type: 'excalidraw',
    elements: [{ id: `el-${n}`, type: 'rectangle', x: n, y: n, width: 10, height: 10 }],
    appState: {},
  });
  const pageShowing = (...embeds: { draw?: string; image?: string }[]) => ({
    type: 'doc',
    content: embeds.map((e) =>
      e.draw
        ? { type: 'drawing', attrs: { drawId: e.draw } }
        : { type: 'image', attrs: { nodeId: e.image } },
    ),
  });

  /**
   * Hold a row lock on another connection while `during` runs: `lock` runs in
   * a transaction there first; once `during` is blocked on that lock, the
   * transaction commits. Returns what `during` settled with.
   */
  async function whileLocked<T>(
    lock: (tx: Sql) => Promise<unknown>,
    during: () => Promise<T>,
  ): Promise<PromiseSettledResult<T>> {
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let pidOf!: (pid: number) => void;
    const pid = new Promise<number>((r) => (pidOf = r));
    const holder = other.begin(async (tx) => {
      const [p] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await lock(tx as unknown as Sql);
      pidOf(p!.pid);
      await released;
    });
    const holderPid = await pid;
    const work = during();
    const settled = Promise.allSettled([work]).then((r) => r[0]!);
    // Wait until `during` waits on the holder, then let the holder commit.
    for (let i = 0; i < 100; i++) {
      const [w] = await exec<{ n: number }>(sqlTag`
        select count(*)::int as n from pg_stat_activity
         where ${holderPid}::int = any(pg_blocking_pids(pid))`);
      if ((w?.n ?? 0) > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    release();
    await holder;
    return settled;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.MANTLE_SPACES_ROOT = path.join(root, 'spaces');
    process.env.TABLE_DB_DIR = path.join(root, 'table-dbs');
    process.env.MANTLE_FILES_ROOT = path.join(root, 'files');
    m = await import('@mantle/db');
    sp = await import('./member-space');
    sf = await import('./member-space-files');
    rv = await import('./member-review');
    pg = await import('./member-space-purge');
    dr = await import('./draws');
    fp = await import('@mantle/files');
    sqlTag = (await import('drizzle-orm')).sql;
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    other = admin;

    // A brain of this test's own (test files run in parallel).
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role)
      values (${anchor}, ${`${tag}-admin@example.invalid`}, 'x', 'admin')`);
    await m.systemDb.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${anchor}, 'brain', ${anchor})`);
    for (const [k, id] of Object.entries(logins)) {
      await m.systemDb.execute(sqlTag`
        insert into auth.users (id, email, password_hash, role)
        values (${id}, ${`${tag}-${k}@example.invalid`}, 'x', 'member')`);
      const [s] = await exec<{ id: string }>(
        sqlTag`select id from spaces where kind = 'personal' and login_id = ${id}`,
      );
      spaceOf[id] = s!.id;
    }
  }, 60_000);

  afterAll(async () => {
    for (const id of moved) await m.systemDb.execute(sqlTag`delete from nodes where id = ${id}`);
    for (const s of Object.values(spaceOf)) {
      await m.systemDb.execute(sqlTag`delete from nodes where owner_id = ${s}`);
      await m.systemDb.execute(sqlTag`delete from spaces where id = ${s}`);
    }
    const ids = Object.values(logins);
    for (const id of ids) await m.systemDb.execute(sqlTag`delete from auth.users where id = ${id}`);
    await m.systemDb.execute(sqlTag`delete from nodes where owner_id = ${anchor}`);
    await m.systemDb.execute(sqlTag`delete from spaces where id = ${anchor}`);
    await m.systemDb.execute(sqlTag`delete from auth.users where id = ${anchor}`);
    await m.closeDb();
    rmSync(root, { recursive: true, force: true });
  });

  // ── F04 ────────────────────────────────────────────────────────────────────

  let pageA: string;
  let drawA: string;
  let laterA: string; // an image the page never showed at Submit

  it('Submit refuses while an item shown inside has unsaved edits (409 with the list)', async () => {
    const L = logins.a;
    const A = spaceOf[L]!;
    drawA = (await as(L, () => sp.createMineItem(A, { type: 'draw', title: `${tag} d` }))).id;
    pageA = (await as(L, () => sp.createMineItem(A, { type: 'page', title: `${tag} p` }))).id;
    laterA = await as(L, async () =>
      sf.createMineFile(A, { filename: 'later.png', spooled: await spool('LATER') }),
    );
    expect((await as(L, () => sp.saveMinePage(A, pageA, pageShowing({ draw: drawA })))).ok).toBe(
      true,
    );
    await as(L, () => dr.saveDrawDraft(A, drawA, scene(1)));
    await expect(as(L, () => sp.submitItem(A, pageA))).rejects.toMatchObject({
      reason: 'unsaved-draft',
      ids: [drawA],
    });
    // Nothing changed: still a draft, no bundle recorded.
    expect((await as(L, () => sp.getMineRow(A, pageA)))?.reviewState).toBe('draft');
    expect(await bundleOf(pageA)).toEqual([]);
  });

  it('Submit records the bundle; everything in it is frozen until Recall', async () => {
    const L = logins.a;
    const A = spaceOf[L]!;
    expect((await as(L, () => sp.saveMineDraw(A, drawA, scene(2)))).ok).toBe(true);
    await as(L, () => sp.submitItem(A, pageA));
    expect(await bundleOf(pageA)).toEqual([pageA, drawA]);

    // The embedded drawing: a clear 409 naming the item, and the row rules
    // refuse the write itself (the draft stays empty).
    await expect(as(L, () => sp.assertEditable(A, drawA))).rejects.toMatchObject({
      reason: 'frozen',
      ids: [pageA],
    });
    await expect(as(L, () => sp.deleteMineItem(A, drawA))).rejects.toMatchObject({
      reason: 'frozen',
    });
    const res = await as(L, () => dr.saveDrawDraft(A, drawA, scene(3)));
    expect(res.ok).toBe(false);
    const [d] = await exec<{ draft: unknown }>(
      sqlTag`select draft_scene as draft from draws where node_id = ${drawA}`,
    );
    expect(d?.draft).toBeNull();
    // Nor can it be submitted on its own while it is part of another.
    await expect(as(L, () => sp.submitItem(A, drawA))).rejects.toMatchObject({
      reason: 'frozen',
    });

    // Recall: the bundle is forgotten, the drawing is editable again.
    await as(L, () => sp.recallItem(A, pageA));
    expect(await bundleOf(pageA)).toEqual([]);
    await as(L, () => sp.assertEditable(A, drawA));
  });

  it('Return forgets the bundle too', async () => {
    const L = logins.a;
    const A = spaceOf[L]!;
    await as(L, () => sp.submitItem(A, pageA));
    expect(await bundleOf(pageA)).toEqual([pageA, drawA]);
    await rv.returnReviewItem(pageA, reviewer(), 'Once more.');
    expect(await bundleOf(pageA)).toEqual([]);
    await as(L, () => sp.assertEditable(A, drawA));
  });

  it('Accept moves exactly the recorded bundle, and forgets it', async () => {
    const L = logins.a;
    const A = spaceOf[L]!;
    await as(L, () => sp.submitItem(A, pageA));
    // The saved page changes behind the rules' back (the admin pool): what
    // moves is still what was reviewed.
    await m.systemDb.execute(sqlTag`
      update pages set doc = ${JSON.stringify(pageShowing({ draw: drawA }, { image: laterA }))}::jsonb
       where node_id = ${pageA}`);
    expect((await rv.previewAccept(pageA))?.items.map((b) => b.id)).toEqual([pageA, drawA]);
    const out = await rv.acceptReviewItem(anchor, pageA, reviewer());
    moved.push(pageA, drawA);
    expect(out.moved.map((b) => b.id)).toEqual([pageA, drawA]);
    expect(await ownerOf(drawA)).toBe(anchor);
    expect(await ownerOf(laterA)).toBe(A);
    expect(await bundleOf(pageA)).toEqual([]);
  });

  // ── F18 ────────────────────────────────────────────────────────────────────

  it('a left-behind bundle takes only shared or submitted items; private embeds stay unseen', async () => {
    const L = logins.b;
    const B = spaceOf[L]!;
    const privImg = await as(L, async () =>
      sf.createMineFile(B, { filename: 'private.png', spooled: await spool('PRIVATE') }),
    );
    const sharedImg = await as(L, async () =>
      sf.createMineFile(B, { filename: 'shared.png', spooled: await spool('SHARED') }),
    );
    const page = (await as(L, () => sp.createMineItem(B, { type: 'page', title: `${tag} bp` }))).id;
    await as(L, () =>
      sp.saveMinePage(B, page, pageShowing({ image: privImg }, { image: sharedImg })),
    );
    await as(L, () => sp.setSharing(B, page, 'team'));
    await as(L, () => sp.setSharing(B, sharedImg, 'team'));
    await m.systemDb.execute(sqlTag`update auth.users set disabled_at = now() where id = ${L}`);

    const preview = await rv.previewAccept(page);
    expect(preview?.items.map((b) => b.id)).toEqual([page, sharedImg]);
    expect(preview?.linksStayingBehind).toBe(1);
    expect(await rv.openReviewFile(page, privImg)).toBeNull();
    const shared = await rv.openReviewFile(page, sharedImg);
    expect(shared?.file.id).toBe(sharedImg);
    shared?.stream.destroy();

    const out = await rv.acceptReviewItem(anchor, page, reviewer());
    moved.push(page, sharedImg);
    expect(out.moved.map((b) => b.id)).toEqual([page, sharedImg]);
    expect(await ownerOf(privImg)).toBe(B);
  });

  it('the purge keeps what a shared or submitted item shows, deletes the rest', async () => {
    const L = logins.c;
    const C = spaceOf[L]!;
    const imgShared = await as(L, async () =>
      sf.createMineFile(C, { filename: 'in-shared.png', spooled: await spool('S') }),
    );
    const imgSubmitted = await as(L, async () =>
      sf.createMineFile(C, { filename: 'in-submitted.png', spooled: await spool('U') }),
    );
    const stray = (await as(L, () => sp.createMineItem(C, { type: 'note', title: `${tag} stray` })))
      .id;
    const sharedPage = (
      await as(L, () => sp.createMineItem(C, { type: 'page', title: `${tag} cs` }))
    ).id;
    await as(L, () => sp.saveMinePage(C, sharedPage, pageShowing({ image: imgShared })));
    await as(L, () => sp.setSharing(C, sharedPage, 'team'));
    const subPage = (await as(L, () => sp.createMineItem(C, { type: 'page', title: `${tag} cu` })))
      .id;
    await as(L, () => sp.saveMinePage(C, subPage, pageShowing({ image: imgSubmitted })));
    await as(L, () => sp.submitItem(C, subPage));

    await m.systemDb.execute(
      sqlTag`update auth.users set disabled_at = now() - interval '31 days' where id = ${L}`,
    );
    expect((await pg.findSpacePurge()).find((s) => s.spaceId === C)?.items).toBe(1);
    await pg.purgeDeactivatedSpaces();
    expect(await ownerOf(stray)).toBeUndefined();
    for (const id of [imgShared, imgSubmitted, sharedPage, subPage]) {
      expect(await ownerOf(id), id).toBe(C);
    }
  });

  // ── F21 ────────────────────────────────────────────────────────────────────

  it('a deleted login’s space is purged 30 days after it lost its login', async () => {
    const L = logins.d;
    const D = spaceOf[L]!;
    const priv = (await as(L, () => sp.createMineItem(D, { type: 'note', title: `${tag} dp` }))).id;
    const shared = (await as(L, () => sp.createMineItem(D, { type: 'note', title: `${tag} ds` })))
      .id;
    await as(L, () => sp.setSharing(D, shared, 'team'));
    await m.systemDb.execute(sqlTag`delete from auth.users where id = ${L}`);
    // Just deleted: not due yet.
    expect((await pg.findSpacePurge()).find((s) => s.spaceId === D)).toBeUndefined();
    await m.systemDb.execute(
      sqlTag`update spaces set orphaned_at = now() - interval '31 days' where id = ${D}`,
    );
    expect((await pg.findSpacePurge()).find((s) => s.spaceId === D)?.items).toBe(1);
    await pg.purgeDeactivatedSpaces();
    expect(await ownerOf(priv)).toBeUndefined();
    expect(await ownerOf(shared)).toBe(D);
  });

  // ── F03 ────────────────────────────────────────────────────────────────────

  it('the purge never deletes a row an Accept re-owned to the brain meanwhile', async () => {
    const L = logins.e;
    const E = spaceOf[L]!;
    const item = (await as(L, () => sp.createMineItem(E, { type: 'note', title: `${tag} e` }))).id;
    moved.push(item);
    await m.systemDb.execute(
      sqlTag`update auth.users set disabled_at = now() - interval '31 days' where id = ${L}`,
    );
    const r = await whileLocked(
      async (tx) => {
        await tx`select id from nodes where id = ${item} for update`;
        await tx`update nodes set owner_id = ${anchor} where id = ${item}`;
      },
      () => pg.purgeDeactivatedSpaces(),
    );
    expect(r.status).toBe('fulfilled');
    expect(await ownerOf(item)).toBe(anchor);
  });

  it('Discard never deletes a row an Accept re-owned to the brain meanwhile', async () => {
    const L = logins.f;
    const F = spaceOf[L]!;
    const item = (await as(L, () => sp.createMineItem(F, { type: 'note', title: `${tag} f` }))).id;
    moved.push(item);
    await as(L, () => sp.setSharing(F, item, 'team'));
    await m.systemDb.execute(sqlTag`update auth.users set disabled_at = now() where id = ${L}`);
    const r = await whileLocked(
      async (tx) => {
        await tx`select id from nodes where id = ${item} for update`;
        await tx`update nodes set owner_id = ${anchor} where id = ${item}`;
      },
      () => rv.discardLeftBehind(item),
    );
    expect(r.status).toBe('rejected');
    expect(r.status === 'rejected' && r.reason).toMatchObject({ reason: 'not-found' });
    expect(await ownerOf(item)).toBe(anchor);
  });

  // ── F24 ────────────────────────────────────────────────────────────────────

  it('a Recall that loses to a Return answers 409, not the returned item', async () => {
    const L = logins.g;
    const G = spaceOf[L]!;
    const item = (
      await as(L, () => sp.createMineItem(G, { type: 'note', title: `${tag} g`, content: 'x' }))
    ).id;
    await as(L, () => sp.submitItem(G, item));
    const r = await whileLocked(
      (tx) => tx`update space_items set review_state = 'returned' where node_id = ${item}`,
      () => as(L, () => sp.recallItem(G, item)),
    );
    expect(r.status).toBe('rejected');
    expect(r.status === 'rejected' && r.reason).toMatchObject({ reason: 'not-submitted' });
  });

  it('a Submit that loses to another Submit answers 409, not a second submission', async () => {
    const L = logins.g;
    const G = spaceOf[L]!;
    const item = (
      await as(L, () => sp.createMineItem(G, { type: 'note', title: `${tag} g2`, content: 'y' }))
    ).id;
    const r = await whileLocked(
      (tx) =>
        tx`update space_items set review_state = 'submitted', submitted_at = now() where node_id = ${item}`,
      () => as(L, () => sp.submitItem(G, item)),
    );
    expect(r.status).toBe('rejected');
    expect(r.status === 'rejected' && r.reason).toMatchObject({ reason: 'not-draft' });
    // The losing Submit recorded nothing.
    expect(await bundleOf(item)).toEqual([]);
  });
});
