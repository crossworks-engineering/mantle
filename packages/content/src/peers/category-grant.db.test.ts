/**
 * A peer's standing category grant on a real Postgres (access matrix H1). A
 * Notes grant covers the owner's notes, never the conversation digests and
 * chat archives Mantle writes about the owner's own chats; a Files grant
 * covers the owner's files, never email attachments (a file in the
 * attachments folder under a mail; a Files document that came by mail too
 * stays an ordinary file). A per-node grant still
 * reaches one of them when the owner picks it. Every peer read is checked:
 * the list, the ranked search and the single-node read.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/peers/category-grant.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('peer category grants on Postgres', () => {
  type Db = typeof import('@mantle/db');
  type Query = typeof import('./query');
  type Grants = typeof import('./grants');
  let m: Db;
  let q: Query;
  let g: Grants;
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const peer = randomUUID();
  const account = randomUUID();
  const ids = {
    peerNode: randomUUID(),
    note: randomUUID(),
    digest: randomUUID(),
    legacyDigest: randomUUID(),
    archive: randomUUID(),
    file: randomUUID(),
    taggedDigest: randomUUID(),
    oldPathNote: randomUUID(),
    emailedDoc: randomUUID(),
    emailNode: randomUUID(),
    attachment: randomUUID(),
    email: randomUUID(),
  };
  const tag = `peer-cat-${owner.slice(0, 8)}`;
  const word = `zebrafish${owner.slice(0, 6)}`;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    q = await import('./query');
    g = await import('./grants');
    sqlTag = (await import('drizzle-orm')).sql;
    const inbox = `inbox.${tag.replace(/-/g, '_')}`;
    await m.db.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role) values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`);
    await m.db.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, data) values
        (${ids.peerNode}, ${owner}, 'mantle_peer', 'A peer', 'peers', '{}'::jsonb),
        (${ids.note}, ${owner}, 'note', ${`My note ${word}`}, 'notes', '{"summary":"mine"}'::jsonb),
        (${ids.digest}, ${owner}, 'note', ${`Digest ${word}`}, 'notes.auto_filed.assistant',
          '{"kind":"conversation_digest","summary":"private chat"}'::jsonb),
        (${ids.legacyDigest}, ${owner}, 'note', ${`Old digest ${word}`}, 'assistant',
          '{"kind":"conversation_digest","summary":"private chat"}'::jsonb),
        (${ids.archive}, ${owner}, 'note', ${`Chat ${word}`}, 'notes.auto_filed.assistant',
          '{"kind":"chat_archive","summary":"private chat"}'::jsonb),
        (${ids.file}, ${owner}, 'file', ${`plan-${word}.pdf`}, 'files', '{}'::jsonb),
        (${ids.emailedDoc}, ${owner}, 'file', ${`contract-${word}.pdf`}, 'files', '{}'::jsonb),
        (${ids.oldPathNote}, ${owner}, 'note', ${`Old ${word}`}, 'assistant', '{}'::jsonb),
        (${ids.emailNode}, ${owner}, 'email', 'A mail', ${inbox}, '{}'::jsonb),
        (${ids.attachment}, ${owner}, 'file', ${`invoice-${word}.pdf`}, ${`${inbox}.attachments`}, '{}'::jsonb)`);
    await m.db.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, tags) values
        (${ids.taggedDigest}, ${owner}, 'note', ${`Tagged ${word}`}, 'notes',
         ARRAY['conversation-digest']::text[])`);
    await m.db.execute(sqlTag`
      insert into email_accounts (id, user_id, provider, address, branch_path)
      values (${account}, ${owner}, 'imap', ${`${tag}-mail@example.invalid`}, ${inbox})`);
    await m.db.execute(sqlTag`
      insert into emails (id, node_id, account_id, provider_msg_id, from_addr, internal_date)
      values (${ids.email}, ${ids.emailNode}, ${account}, ${`${tag}-1`}, 'a@example.invalid', now())`);
    await m.db.execute(sqlTag`
      insert into email_attachments (email_id, file_node_id, filename, sha256, storage_key)
      values (${ids.email}, ${ids.attachment}, 'invoice.pdf', 'abc', 'k'),
             (${ids.email}, ${ids.emailedDoc}, 'contract.pdf', 'def', 'k2')`);
    await m.db.execute(sqlTag`
      insert into mantle_peers (id, owner_id, node_id, display_name, base_url, inbound_token_hash)
      values (${peer}, ${owner}, ${ids.peerNode}, 'Peer', 'https://peer.example.invalid', ${`${tag}-hash`})`);
    expect(await g.grantPeerTypeShare(owner, peer, 'note')).not.toBeNull();
    expect(await g.grantPeerTypeShare(owner, peer, 'file')).not.toBeNull();
  }, 60_000);

  afterAll(async () => {
    await m.db.execute(sqlTag`delete from peer_shares where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from peer_share_scopes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from mantle_peers where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from email_attachments where email_id = ${ids.email}`);
    await m.db.execute(sqlTag`delete from emails where account_id = ${account}`);
    await m.db.execute(sqlTag`delete from email_accounts where id = ${account}`);
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
  });

  const hidden = [
    ids.digest,
    ids.legacyDigest,
    ids.archive,
    ids.attachment,
    ids.taggedDigest,
    ids.oldPathNote,
  ];

  it('the list gives the notes and files, not digests, archives or attachments', async () => {
    const got = (await q.queryForPeer(peer, { limit: 100 })).map((h) => h.id);
    // A Files document that also came by mail (sync reuses the node by its
    // bytes) is still an ordinary file.
    expect(got).toEqual(expect.arrayContaining([ids.note, ids.file, ids.emailedDoc]));
    for (const id of hidden) expect(got).not.toContain(id);
  });

  it('the ranked search leaves them out too', async () => {
    const got = (await q.queryForPeer(peer, { query: word, limit: 100 })).map((h) => h.id);
    expect(got).toContain(ids.note);
    for (const id of hidden) expect(got).not.toContain(id);
  });

  it('the single read refuses them as not found', async () => {
    expect((await q.getNodeForPeer(peer, ids.note))?.id).toBe(ids.note);
    expect((await q.getNodeForPeer(peer, ids.file))?.id).toBe(ids.file);
    for (const id of hidden) expect(await q.getNodeForPeer(peer, id)).toBeNull();
  });

  it('a per-node grant still reaches one the owner picks', async () => {
    expect(await g.grantPeerShare(owner, peer, ids.digest)).not.toBeNull();
    expect((await q.getNodeForPeer(peer, ids.digest))?.id).toBe(ids.digest);
    const got = (await q.queryForPeer(peer, { limit: 100 })).map((h) => h.id);
    expect(got).toContain(ids.digest);
    expect(got).not.toContain(ids.archive);
    await g.revokePeerShare(owner, peer, ids.digest);
    expect(await q.getNodeForPeer(peer, ids.digest)).toBeNull();
  });
});
