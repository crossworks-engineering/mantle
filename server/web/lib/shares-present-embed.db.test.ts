/**
 * A shared page shows the snapshot of a Present canvas it embeds only where
 * the link serves that canvas (isEmbeddedPresentAllowed), against a real,
 * migrated Postgres: a canvas on the served list with a snapshot is shown;
 * one off the list, one with no snapshot yet, and one the page does not
 * embed are not; a contact share serves what its page names. Never the
 * canvas itself: the share route answers the picture only.
 *
 * Seeds its own owner and rows and removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run shares-present-embed.db.test
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Share } from '@mantle/db';
import { asSuperuser } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('a shared page shows the canvases its link serves', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let shares: typeof import('./shares');
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const tag = `prs-${owner.slice(0, 8)}`;
  const id = {
    page: randomUUID(),
    served: randomUUID(), // on the list, with a snapshot
    offList: randomUUID(), // with a snapshot, not on the list
    noPoster: randomUUID(), // on the list, no snapshot yet
    notEmbedded: randomUUID(), // on the list, not in the page
  };
  const token = `${tag}-p`;
  const link = async () => (await shares.resolveActiveShareByToken(token)) as Share;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    shares = await import('./shares');
    sqlTag = (await import('drizzle-orm')).sql;
    await asSuperuser()(sqlTag`
      insert into auth.users (id, email, password_hash, role) values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`);
    await m.db.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience, data)
      values (${id.page}, ${owner}, 'page', 'Shared page', 'pages'::ltree, 'admin', '{}'::jsonb)`);
    for (const c of [id.served, id.offList, id.noPoster, id.notEmbedded]) {
      await m.db.execute(sqlTag`
        insert into nodes (id, owner_id, type, title, path, audience, data)
        values (${c}, ${owner}, 'present', 'Deck', 'present'::ltree, 'admin', '{}'::jsonb)`);
      const poster = c === id.noPoster ? null : Buffer.from('PNG');
      await m.db.execute(sqlTag`
        insert into presents (node_id, source, meta, poster_png, poster_rev, rev)
        values (${c}, '<html></html>', '{}'::jsonb, ${poster}, ${poster ? 1 : null}, 1)`);
    }
    const doc = {
      type: 'doc',
      content: [id.served, id.offList, id.noPoster].map((p) => ({
        type: 'image',
        attrs: { presentId: p, alt: 'Deck' },
      })),
    };
    await m.db.execute(
      sqlTag`insert into pages (node_id, doc, doc_text) values (${id.page}, ${JSON.stringify(doc)}::jsonb, '')`,
    );
    await m.db.execute(sqlTag`
      insert into shares (owner_id, node_id, node_type, token) values
        (${owner}, ${id.page}, 'page', ${token})`);
    const p = await link();
    await shares.setShareServed(owner, p.id, [id.page, id.served, id.noPoster, id.notEmbedded]);
  }, 60_000);

  afterAll(async () => {
    await m.db.execute(sqlTag`delete from shares where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
    await m.closeDb();
  });

  it('shows a served canvas with a snapshot, and no other', async () => {
    const p = await link();
    expect(await shares.isEmbeddedPresentAllowed(p, id.served)).toBe(true);
    expect(await shares.isEmbeddedPresentAllowed(p, id.offList)).toBe(false);
    expect(await shares.isEmbeddedPresentAllowed(p, id.noPoster)).toBe(false);
    expect(await shares.isEmbeddedPresentAllowed(p, id.notEmbedded)).toBe(false);
    expect(await shares.isEmbeddedPresentAllowed(p, 'not-a-uuid')).toBe(false);
    const shown = await shares.sharePresentsShown(p, [
      id.served,
      id.offList.toUpperCase(),
      id.noPoster,
    ]);
    expect([...shown]).toEqual([id.served.toLowerCase()]);
  });

  it('a contact share holds no list: it shows what its page names', async () => {
    const contact = { ...(await link()), contactId: randomUUID(), settings: {} } as Share;
    expect(await shares.isEmbeddedPresentAllowed(contact, id.offList)).toBe(true);
    expect(await shares.isEmbeddedPresentAllowed(contact, id.notEmbedded)).toBe(false);
  });

  it('a link to the canvas itself is no page: it shows no embedded picture', async () => {
    const self = { ...(await link()), nodeId: id.served, nodeType: 'present' } as Share;
    expect(await shares.isEmbeddedPresentAllowed(self, id.served)).toBe(false);
  });
});
