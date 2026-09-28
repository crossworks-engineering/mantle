/**
 * Page and drawing links serve an embed only at the link's level (embedding
 * means sharing, audit F19 follow-up), against a real, migrated Postgres.
 * Lowering a page takes its embeds with it, so a normal link serves them all;
 * an admin who RAISES one embed back above the page on purpose takes it off
 * the link. A drawing's snapshot carries its images, so one raised image
 * keeps the whole snapshot off. Single-item links are not filtered. Seeds its
 * own owner and rows and removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run shares-embed-levels.db.test
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Share } from '@mantle/db';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('page and drawing links serve embeds by level on Postgres', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let shares: typeof import('./shares');
  let access: typeof import('@mantle/content');
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const tag = `embed-levels-${owner.slice(0, 8)}`;
  const id = {
    page: randomUUID(),
    img: randomUUID(),
    draw: randomUUID(),
    drawImg: randomUUID(),
  };

  const shareOf = (nodeId: string, nodeType: string) =>
    ({ id: randomUUID(), ownerId: owner, nodeId, nodeType, token: 't' }) as unknown as Share;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    shares = await import('./shares');
    access = await import('@mantle/content');
    sqlTag = (await import('drizzle-orm')).sql;
    await m.db.execute(sqlTag`
      insert into auth.users (id, email, password_hash) values (${owner}, ${`${tag}@example.invalid`}, 'x')`);
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`);
    const rows: Array<[string, string, string, string]> = [
      [id.page, 'page', 'Shared page', 'pages'],
      [id.img, 'file', 'img.png', 'files'],
      [id.draw, 'draw', 'Sketch', 'draw'],
      [id.drawImg, 'file', 'draw-img.png', 'files'],
    ];
    for (const [nid, type, title, path] of rows) {
      await m.db.execute(sqlTag`
        insert into nodes (id, owner_id, type, title, path) values
          (${nid}, ${owner}, ${type}, ${title}, ${path}::ltree)`);
    }
    const doc = {
      type: 'doc',
      content: [
        { type: 'image', attrs: { nodeId: id.img } },
        { type: 'image', attrs: { drawId: id.draw } },
      ],
    };
    await m.db.execute(
      sqlTag`insert into pages (node_id, doc, doc_text) values (${id.page}, ${JSON.stringify(doc)}::jsonb, '')`,
    );
    const scene = { elements: [{ type: 'image', id: 'e1', fileId: 'f1' }] };
    await m.db.execute(sqlTag`
      insert into draws (node_id, scene, file_refs) values
        (${id.draw}, ${JSON.stringify(scene)}::jsonb, ${JSON.stringify({ f1: id.drawImg })}::jsonb)`);
    // The admin makes the page public: its embeds go down with it.
    await access.setItemLevel(owner, id.page, 'public');
  });

  afterAll(async () => {
    await m.db.execute(sqlTag`delete from shares where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
    await m.closeDb();
  });

  const pageLink = () => shareOf(id.page, 'page');
  const publicLevels = () => shares.linkLevels('public');

  it('a public page link serves its embeds once they followed it down', async () => {
    expect(await shares.isAssetAllowed(pageLink(), id.img)).toBe(true);
    expect(await shares.isDrawServable(owner, id.draw, publicLevels(), { self: true })).toBe(true);
  });

  it('does not serve an embed an admin raised back above the link', async () => {
    await access.setItemAudience(owner, id.img, 'admin');
    expect(await shares.isAssetAllowed(pageLink(), id.img)).toBe(false);
    // A client raise is still above a public link.
    await access.setItemAudience(owner, id.img, 'client');
    expect(await shares.isAssetAllowed(pageLink(), id.img)).toBe(false);
    // A single-item link on the file is the file itself: not filtered.
    expect(await shares.isAssetAllowed(shareOf(id.img, 'file'), id.img)).toBe(true);
  });

  it("keeps a drawing's snapshot off the link when one of its images was raised", async () => {
    await access.setItemAudience(owner, id.drawImg, 'admin');
    expect(await shares.isDrawServable(owner, id.draw, publicLevels(), { self: true })).toBe(false);
    // Also when the drawing itself is the shared item: its snapshot carries the image.
    expect(await shares.isDrawServable(owner, id.draw, publicLevels(), { self: false })).toBe(
      false,
    );
    await access.setItemAudience(owner, id.drawImg, 'public');
    expect(await shares.isDrawServable(owner, id.draw, publicLevels(), { self: false })).toBe(true);
    // An embedded drawing raised above the page is not served through it.
    await access.setItemAudience(owner, id.draw, 'admin');
    expect(await shares.isDrawServable(owner, id.draw, publicLevels(), { self: true })).toBe(false);
  });
});
