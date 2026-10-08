/**
 * An open link shows a page or note only as the public may read it (access
 * matrix M7), against a real, migrated Postgres. A public page that mentions
 * an admin item, holds a child page card of an admin page and embeds an
 * admin file gave the anonymous visitor the label, the title and the file
 * name, though the bytes were refused. Now those say "Private item" (the
 * embed is left out), the same rule a client page and the indexed text use;
 * public items keep theirs. A contact share reads the item as it is. Seeds
 * its own owner and rows and removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run shares-public-redact.db.test
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Share } from '@mantle/db';
import { renderPageDoc } from './render-page-doc';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('open links redact what the public may not read', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let shares: typeof import('./shares');
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const tag = `public-redact-${owner.slice(0, 8)}`;
  const id = {
    page: randomUUID(),
    note: randomUUID(),
    secretPage: randomUUID(),
    secretFile: randomUUID(),
    openPage: randomUUID(),
  };
  const SECRET = 'Acquisition plan';
  const SECRET_FILE = 'board-minutes.pdf';

  const shareOf = (nodeId: string, nodeType: string, contactId: string | null = null) =>
    ({
      id: randomUUID(),
      ownerId: owner,
      nodeId,
      nodeType,
      token: 't',
      contactId,
    }) as unknown as Share;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    shares = await import('./shares');
    sqlTag = (await import('drizzle-orm')).sql;
    await m.db.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role) values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`);
    const rows: Array<[string, string, string, string]> = [
      [id.page, 'page', 'Shared page', 'pages'],
      [id.note, 'note', 'Shared note', 'notes'],
      [id.secretPage, 'page', SECRET, 'pages'],
      [id.secretFile, 'file', SECRET_FILE, 'files'],
      [id.openPage, 'page', 'Open page', 'pages'],
    ];
    for (const [nid, type, title, path] of rows) {
      await m.db.execute(sqlTag`
        insert into nodes (id, owner_id, type, title, path) values
          (${nid}, ${owner}, ${type}, ${title}, ${path}::ltree)`);
    }
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'See ' },
            {
              type: 'mention',
              attrs: { id: id.secretPage, label: SECRET, ref: 'node', kind: 'page' },
            },
            { type: 'text', text: ' and ' },
            {
              type: 'mention',
              attrs: { id: id.openPage, label: 'Open page', ref: 'node', kind: 'page' },
            },
          ],
        },
        { type: 'childPage', attrs: { pageId: id.secretPage, title: SECRET } },
        { type: 'fileEmbed', attrs: { nodeId: id.secretFile, filename: SECRET_FILE } },
      ],
    };
    for (const p of [id.page, id.secretPage, id.openPage]) {
      await m.db.execute(
        sqlTag`insert into pages (node_id, doc, doc_text) values (${p}, ${JSON.stringify(p === id.page ? doc : { type: 'doc', content: [] })}::jsonb, '')`,
      );
    }
    const note = `Read [${SECRET}](mention:node:${id.secretPage}) and [Open page](mention:node:${id.openPage}).`;
    await m.db.execute(
      sqlTag`update nodes set data = ${JSON.stringify({ content: note })}::jsonb where id = ${id.note}`,
    );
    // Straight to public, by the row only: the embeds stay admin, as when an
    // admin raised them back above the page on purpose.
    await m.db.execute(
      sqlTag`update nodes set audience = 'public' where id in (${id.page}, ${id.note}, ${id.openPage})`,
    );
  }, 60_000);

  afterAll(async () => {
    await m.db.execute(sqlTag`delete from shares where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
    await m.closeDb();
  });

  const html = async (share: Share) => {
    const view = await shares.loadShareView(share);
    if (view?.kind !== 'page') throw new Error('not a page');
    return renderPageDoc(view.doc, { assetUrl: (f) => `/a/${f}` });
  };

  it('an open page link hides the titles and file names of admin items', async () => {
    const out = await html(shareOf(id.page, 'page'));
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(SECRET_FILE);
    expect(out).not.toContain(id.secretFile);
    expect(out).toContain('Private item');
    expect(out).toContain('Open page');
  });

  it('an open note link hides them too', async () => {
    const view = await shares.loadShareView(shareOf(id.note, 'note'));
    if (view?.kind !== 'note') throw new Error('not a note');
    expect(view.content).not.toContain(SECRET);
    expect(view.content).toContain('Private item');
    expect(view.content).toContain('Open page');
  });

  it('a contact share reads the item as it is', async () => {
    const out = await html(shareOf(id.page, 'page', randomUUID()));
    expect(out).toContain(SECRET);
    expect(out).toContain(SECRET_FILE);
  });
});
