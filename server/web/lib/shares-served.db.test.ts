/**
 * An open link serves its item and its served list (workspaces plan 8.1,
 * decision 12), against a real, migrated Postgres. Two halves:
 *
 *  - the 0262 fill: links made under the level rules (the levels written on
 *    insert, as frozen rows hold them) get the list
 *    mantle_link_served_by_levels computes, and then serve exactly what the
 *    level rules served: a folder link its public files and subfolders with
 *    no hidden folder between (audit F19), a page link its public embeds, a
 *    drawing's snapshot only when every image it places was public;
 *  - the list rules after it: a file uploaded later into a shared folder is
 *    not served until someone adds it; an item moved out of the folder is
 *    not served though it stays on the list; an id on the list the item
 *    does not embed is not served; the item itself always is.
 *
 * Seeds its own owner and rows and removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run shares-served.db.test
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Share } from '@mantle/db';
import { asSuperuser } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('open links serve their served list on Postgres', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let shares: typeof import('./shares');
  let presenter: typeof import('@/components/share/folder-presenter');
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const tag = `served-${owner.slice(0, 8)}`;
  // Unique ltree labels, so parallel runs never share a path.
  const root = `files.sv_${owner.slice(0, 8)}`;
  const elsewhere = `files.se_${owner.slice(0, 8)}`;
  const id = {
    root: randomUUID(),
    pub: randomUUID(),
    adm: randomUUID(), // a later upload: admin
    sub: randomUUID(), // admin subfolder
    subPub: randomUUID(), // public file under the admin subfolder
    open: randomUUID(), // public subfolder
    openPub: randomUUID(),
    openAdm: randomUUID(),
    away: randomUUID(), // a folder outside the shared one
    page: randomUUID(),
    img: randomUUID(), // public image on the page
    hidden: randomUUID(), // admin image on the page
    draw: randomUUID(), // public drawing on the page, its image public
    drawImg: randomUUID(),
    draw2: randomUUID(), // a drawing with one admin image
    draw2Img: randomUUID(),
  };
  const token = { folder: `${tag}-f`, page: `${tag}-p`, draw: `${tag}-d`, draw2: `${tag}-d2` };

  /** The live row as the /s routes resolve it. */
  const link = async (t: string) => (await shares.resolveActiveShareByToken(t)) as Share;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    shares = await import('./shares');
    presenter = await import('@/components/share/folder-presenter');
    sqlTag = (await import('drizzle-orm')).sql;
    await asSuperuser()(sqlTag`
      insert into auth.users (id, email, password_hash, role) values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`);
    const rows: Array<[string, string, string, string, string]> = [
      [id.root, 'branch', 'shared', root, 'public'],
      [id.pub, 'file', 'pub.txt', root, 'public'],
      [id.adm, 'file', 'later-upload.txt', root, 'admin'],
      [id.sub, 'branch', 'private', `${root}.private`, 'admin'],
      [id.subPub, 'file', 'deep.txt', `${root}.private`, 'public'],
      [id.open, 'branch', 'open', `${root}.open`, 'public'],
      [id.openPub, 'file', 'open-pub.txt', `${root}.open`, 'public'],
      [id.openAdm, 'file', 'open-adm.txt', `${root}.open`, 'admin'],
      [id.away, 'branch', 'away', elsewhere, 'public'],
      [id.page, 'page', 'Shared page', 'pages', 'public'],
      [id.img, 'file', 'img.png', 'files', 'public'],
      [id.hidden, 'file', 'hidden.png', 'files', 'admin'],
      [id.draw, 'draw', 'Sketch', 'draw', 'public'],
      [id.drawImg, 'file', 'draw-img.png', 'files', 'public'],
      [id.draw2, 'draw', 'Sketch two', 'draw', 'public'],
      [id.draw2Img, 'file', 'draw2-img.png', 'files', 'admin'],
    ];
    for (const [nid, type, title, path, audience] of rows) {
      const data =
        type === 'file' ? { filename: title, mime_type: 'text/plain', size_bytes: 1 } : {};
      await m.db.execute(sqlTag`
        insert into nodes (id, owner_id, type, title, path, audience, data)
        values (${nid}, ${owner}, ${type}, ${title}, ${path}::ltree, ${audience}, ${JSON.stringify(data)}::jsonb)`);
    }
    const doc = {
      type: 'doc',
      content: [
        { type: 'image', attrs: { nodeId: id.img } },
        { type: 'image', attrs: { nodeId: id.hidden } },
        { type: 'image', attrs: { drawId: id.draw } },
      ],
    };
    await m.db.execute(
      sqlTag`insert into pages (node_id, doc, doc_text) values (${id.page}, ${JSON.stringify(doc)}::jsonb, '')`,
    );
    const scene = { elements: [{ type: 'image', id: 'e1', fileId: 'f1' }] };
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
    for (const [d, img] of [
      [id.draw, id.drawImg],
      [id.draw2, id.draw2Img],
    ] as const) {
      await m.db.execute(sqlTag`
        insert into draws (node_id, scene, file_refs, scene_svg) values
          (${d}, ${JSON.stringify(scene)}::jsonb, ${JSON.stringify({ f1: img })}::jsonb, ${svg})`);
    }
    // Links as the level rules left them: no list yet.
    await m.db.execute(sqlTag`
      insert into shares (owner_id, node_id, node_type, token) values
        (${owner}, ${id.root}, 'branch', ${token.folder}),
        (${owner}, ${id.page}, 'page', ${token.page}),
        (${owner}, ${id.draw}, 'draw', ${token.draw}),
        (${owner}, ${id.draw2}, 'draw', ${token.draw2})`);
    // The 0262 fill, for this file's links only (others share the database).
    // As the superuser, as the migration ran it: the runtime role (arch A9)
    // may not run mantle_link_served_by_levels (the app never calls it).
    await (
      await import('@mantle/db/test-support')
    ).superuserExec(
      URL!,
      sqlTag`
      update shares set settings = settings || jsonb_build_object('served', to_jsonb(mantle_link_served_by_levels(id)))
       where owner_id = ${owner}`,
    );
  }, 60_000);

  afterAll(async () => {
    await m.db.execute(sqlTag`delete from shares where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
    await m.closeDb();
  });

  const listing = async (sub = '') => {
    const view = await shares.loadShareView(await link(token.folder));
    if (view?.kind !== 'folder') throw new Error('not a folder view');
    const l = await presenter.loadFolderListing(owner, view, sub);
    return {
      currentPath: l.currentPath,
      folders: l.folders.map((f) => [f.slug, f.fileCount]),
      files: l.files.map((f) => f.filename),
    };
  };

  describe('the 0262 fill serves what the level rules served', () => {
    it('fills each link with what it served', async () => {
      const served = async (t: string) => shares.servedIds((await link(t)) as Share);
      expect([...(await served(token.folder))].sort()).toEqual(
        [id.root, id.pub, id.open, id.openPub].sort(),
      );
      expect([...(await served(token.page))].sort()).toEqual(
        [id.page, id.img, id.draw, id.drawImg].sort(),
      );
      expect([...(await served(token.draw))].sort()).toEqual([id.draw, id.drawImg].sort());
      // The one image of the second drawing was admin: nothing besides it.
      expect([...(await served(token.draw2))]).toEqual([id.draw2]);
    });

    it('a folder link lists only what was public, and counts only that', async () => {
      const l = await listing();
      expect(l.files).toEqual(['pub.txt']);
      expect(l.folders).toEqual([['open', 1]]);
      expect(await listing('open')).toMatchObject({
        currentPath: `${root}.open`,
        files: ['open-pub.txt'],
      });
      // A ?p= into a hidden folder falls back to the shared root.
      expect((await listing('private')).currentPath).toBe(root);
    });

    it('a folder link serves only the files its listing shows', async () => {
      const f = await link(token.folder);
      expect(await shares.isAssetAllowed(f, id.pub)).toBe(true);
      expect(await shares.isAssetAllowed(f, id.openPub)).toBe(true);
      for (const x of [id.adm, id.openAdm, id.subPub, id.img]) {
        expect(await shares.isAssetAllowed(f, x)).toBe(false);
      }
    });

    it('a page link serves its public embeds, never the admin one', async () => {
      const p = await link(token.page);
      expect(await shares.isAssetAllowed(p, id.img)).toBe(true);
      expect(await shares.isAssetAllowed(p, id.hidden)).toBe(false);
      expect(await shares.isEmbeddedDrawAllowed(p, id.draw)).toBe(true);
    });

    it("a drawing's snapshot is served only when every image it places was public", async () => {
      expect(await shares.isDrawServable(await link(token.draw), id.draw, { self: false })).toBe(
        true,
      );
      expect(await shares.isDrawServable(await link(token.draw2), id.draw2, { self: false })).toBe(
        false,
      );
    });
  });

  describe('the list rules', () => {
    it('a later upload is served once it is on the list, and not before', async () => {
      const f = await link(token.folder);
      expect(await shares.isAssetAllowed(f, id.adm)).toBe(false);
      const list = [...shares.servedIds(f)].filter((x) => x !== id.root);
      await shares.setShareServed(owner, f.id, [...list, id.adm]);
      expect(await shares.isAssetAllowed(await link(token.folder), id.adm)).toBe(true);
      expect((await listing()).files).toEqual(['later-upload.txt', 'pub.txt']);
      await shares.setShareServed(owner, f.id, list);
      expect(await shares.isAssetAllowed(await link(token.folder), id.adm)).toBe(false);
    });

    it('an item moved out of the folder is not served, though it stays on the list', async () => {
      await m.db.execute(sqlTag`update nodes set path = ${elsewhere}::ltree where id = ${id.pub}`);
      try {
        const f = await link(token.folder);
        expect(shares.servedIds(f).has(id.pub)).toBe(true);
        expect(await shares.isServed(f, id.pub)).toBe(false);
        expect(await shares.isAssetAllowed(f, id.pub)).toBe(false);
      } finally {
        await m.db.execute(sqlTag`update nodes set path = ${root}::ltree where id = ${id.pub}`);
      }
      expect(await shares.isAssetAllowed(await link(token.folder), id.pub)).toBe(true);
    });

    it('an id on the list the item does not embed is not served; the item itself always is', async () => {
      const p = await link(token.page);
      await shares.setShareServed(owner, p.id, [...shares.servedIds(p), id.openPub]);
      expect(await shares.isAssetAllowed(await link(token.page), id.openPub)).toBe(false);
      // A single-item link is the item: a file link serves its file.
      const fileLink = { ...p, nodeId: id.hidden, nodeType: 'file', settings: {} } as Share;
      expect(await shares.isAssetAllowed(fileLink, id.hidden)).toBe(true);
      // A contact share holds no list: it serves what its item names.
      const contact = { ...p, contactId: randomUUID(), settings: {} } as Share;
      expect(await shares.isAssetAllowed(contact, id.hidden)).toBe(true);
    });

    it('a drawing image taken off the list keeps the snapshot off the link', async () => {
      const d = await link(token.draw);
      await shares.setShareServed(owner, d.id, []);
      expect(await shares.isDrawServable(await link(token.draw), id.draw, { self: false })).toBe(
        false,
      );
      await shares.setShareServed(owner, d.id, [id.drawImg]);
      expect(await shares.isDrawServable(await link(token.draw), id.draw, { self: false })).toBe(
        true,
      );
    });
  });
});
