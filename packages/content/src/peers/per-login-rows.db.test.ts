/**
 * A per-login row (`nodes.login_id` set: a chat, a fact learned from one,
 * a file sent in a chat) and the federation surface, on a real Postgres. Row security keeps such a row to its login, but
 * every peer read runs on the system pool, which binds no login, so the
 * grant predicate itself leaves the row out (`peerPerLoginRow`, inside
 * `grantUnionFilter`). A peer with a standing grant on every category it
 * may hold finds, reads and gets passages of none of a member's or an Admin
 * user's per-login rows: not by the list, the ranked search, the single
 * read or the passage search, and the category counts do not count them. A
 * per-node grant on one is refused (grantPeerShare answers null, as for a
 * node not found) and one made before the refusal reaches nothing and is
 * not listed. The controls: the owner's shared note and file of the same
 * types are found, read and searched by the same peer.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/peers/per-login-rows.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asSuperuser } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('per-login rows and a peer, on Postgres (H1)', () => {
  type Db = typeof import('@mantle/db');
  type Query = typeof import('./query');
  type Grants = typeof import('./grants');
  let m: Db;
  let q: Query;
  let g: Grants;
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  /** A member's login and an Admin user's (neither the owner). */
  const member = randomUUID();
  const adminX = randomUUID();
  const peer = randomUUID();
  const ids = {
    peerNode: randomUUID(),
    note: randomUUID(),
    file: randomUUID(),
    memberPhoto: randomUUID(),
    memberNote: randomUUID(),
    adminPhoto: randomUUID(),
    adminNote: randomUUID(),
  };
  const tag = `peer-login-${owner.slice(0, 8)}`;
  const word = `marmoset${owner.slice(0, 6)}`;
  /** The question's vector, and every passage's: distance 0 for all. */
  const VEC = `[${Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0)).join(',')}]`;
  const QUESTION = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
  const perLogin = [ids.memberPhoto, ids.memberNote, ids.adminPhoto, ids.adminNote];

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    q = await import('./query');
    g = await import('./grants');
    sqlTag = (await import('drizzle-orm')).sql;
    await asSuperuser()(sqlTag`
      insert into auth.users (id, email, password_hash, role) values
        (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin'),
        (${member}, ${`${tag}-m@example.invalid`}, 'x', 'member'),
        (${adminX}, ${`${tag}-x@example.invalid`}, 'x', 'admin')`);
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`);
    await m.db.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, data) values
        (${ids.peerNode}, ${owner}, 'mantle_peer', 'A peer', 'peers', '{}'::jsonb),
        (${ids.note}, ${owner}, 'note', ${`Shared note ${word}`}, 'notes', '{"summary":"shared"}'::jsonb),
        (${ids.file}, ${owner}, 'file', ${`shared-${word}.png`}, 'files', '{}'::jsonb)`);
    await m.db.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, tags, data, login_id) values
        (${ids.memberPhoto}, ${owner}, 'file', ${`photo-member-${word}.png`}, 'files.work',
          ARRAY['file']::text[],
          ${JSON.stringify({ text: `vision ${word}`, summary: word })}::jsonb,
          ${member}),
        (${ids.memberNote}, ${owner}, 'note', ${`Member chat ${word}`}, 'notes',
          ARRAY[]::text[], '{"summary":"private"}'::jsonb, ${member}),
        (${ids.adminPhoto}, ${owner}, 'file', ${`photo-admin-${word}.png`},
          'files.work', ARRAY['file']::text[],
          ${JSON.stringify({ text: `vision ${word}`, summary: word })}::jsonb,
          ${adminX}),
        (${ids.adminNote}, ${owner}, 'note', ${`Admin chat ${word}`}, 'notes',
          ARRAY[]::text[], '{"summary":"private"}'::jsonb, ${adminX})`);
    // As the system: under the actor check a write that names no actor is
    // refused.
    await m.runAsSystem('test:peer-login-rows', async () => {
      for (const id of [ids.note, ids.file, ...perLogin]) {
        await m.db.execute(sqlTag`
          insert into content_chunks (owner_id, node_id, ordinal, text, embedding)
          values (${owner}, ${id}, 0, ${`${word} passage of ${id}`}, ${VEC}::vector)`);
      }
    });
    await m.db.execute(sqlTag`
      insert into mantle_peers (id, owner_id, node_id, display_name, base_url, inbound_token_hash)
      values (${peer}, ${owner}, ${ids.peerNode}, 'Peer', 'https://peer.example.invalid', ${`${tag}-hash`})`);
    // Every category a peer may hold: the full scope.
    for (const t of g.PEER_SHAREABLE_TYPES) {
      expect(await g.grantPeerTypeShare(owner, peer, t), t).not.toBeNull();
    }
  }, 60_000);

  afterAll(async () => {
    await m.db.execute(sqlTag`delete from peer_shares where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from peer_share_scopes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from mantle_peers where owner_id = ${owner}`);
    await m.runAsSystem('test:peer-login-rows', () =>
      m.db.execute(sqlTag`delete from content_chunks where owner_id = ${owner}`),
    );
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await asSuperuser()(
      sqlTag`delete from auth.users where id in (${owner}, ${member}, ${adminX})`,
    );
  });

  it('the list gives the shared note and file, no per-login row', async () => {
    const got = (await q.queryForPeer(peer, { limit: 100 })).map((h) => h.id);
    expect(got).toEqual(expect.arrayContaining([ids.note, ids.file]));
    for (const id of perLogin) expect(got).not.toContain(id);
    const files = (await q.queryForPeer(peer, { types: ['file'], limit: 100 })).map((h) => h.id);
    expect(files).toContain(ids.file);
    for (const id of perLogin) expect(files).not.toContain(id);
  });

  it('the ranked search finds none of them, by title, vision text or summary', async () => {
    const got = (await q.queryForPeer(peer, { query: word, limit: 100 })).map((h) => h.id);
    expect(got).toContain(ids.note);
    for (const id of perLogin) expect(got).not.toContain(id);
    const vision = (await q.queryForPeer(peer, { query: `vision ${word}`, limit: 100 })).map(
      (h) => h.id,
    );
    for (const id of perLogin) expect(vision).not.toContain(id);
  });

  it('the single read refuses them as not found; the shared ones read', async () => {
    expect((await q.getNodeForPeer(peer, ids.note))?.id).toBe(ids.note);
    expect((await q.getNodeForPeer(peer, ids.file))?.id).toBe(ids.file);
    for (const id of perLogin) expect(await q.getNodeForPeer(peer, id)).toBeNull();
  });

  it('the passage search gives none of their passages', async () => {
    const got = (await q.searchChunksForPeer(peer, QUESTION, 50)).map((c) => c.nodeId);
    expect(got).toEqual(expect.arrayContaining([ids.note, ids.file]));
    for (const id of perLogin) expect(got).not.toContain(id);
  });

  it('the category counts do not count them', async () => {
    const counts = await g.peerShareableTypeCounts(owner);
    expect(counts.file).toBe(1);
    expect(counts.note).toBe(1);
  });

  it('a per-node grant on one is refused, as a node not found; a shared one is granted', async () => {
    for (const id of perLogin) expect(await g.grantPeerShare(owner, peer, id), id).toBeNull();
    const rows = (await m.db.execute(sqlTag`
      select node_id::text as id from peer_shares where peer_id = ${peer}`)) as unknown as Array<{
      id: string;
    }>;
    for (const id of perLogin) expect(rows.map((r) => r.id)).not.toContain(id);
    expect(await g.grantPeerShare(owner, peer, ids.peerNode)).not.toBeNull();
    expect((await q.getNodeForPeer(peer, ids.peerNode))?.id).toBe(ids.peerNode);
  });

  it('a per-node grant made before the refusal reaches nothing and is not listed', async () => {
    await m.runAsSystem('test:peer-login-rows', () =>
      m.db.execute(sqlTag`
        insert into peer_shares (owner_id, peer_id, node_id, node_type)
        values (${owner}, ${peer}, ${ids.adminPhoto}, 'file'),
               (${owner}, ${peer}, ${ids.memberNote}, 'note')`),
    );
    for (const id of [ids.adminPhoto, ids.memberNote]) {
      expect(await q.getNodeForPeer(peer, id)).toBeNull();
    }
    const listed = (await q.queryForPeer(peer, { limit: 100 })).map((h) => h.id);
    expect(listed).not.toContain(ids.adminPhoto);
    expect(listed).not.toContain(ids.memberNote);
    const passages = (await q.searchChunksForPeer(peer, QUESTION, 50)).map((c) => c.nodeId);
    expect(passages).not.toContain(ids.adminPhoto);
    const shares = (await g.listPeerShares(owner, peer)).map((s) => s.nodeId);
    expect(shares).toContain(ids.peerNode);
    expect(shares).not.toContain(ids.adminPhoto);
    expect(shares).not.toContain(ids.memberNote);
  });
});
