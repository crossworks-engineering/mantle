/**
 * Best-effort writes on read paths, on a database that refuses writes (a
 * read-only replica, a role with SELECT only such as the public demo's
 * reader). A peer's last-seen stamp and a share's view counter are notes
 * beside a read: with `bestEffortWrite` (@mantle/db) a refusal skips them
 * and the read is served. On a normal role both are still written.
 *
 * The tree's own reads are in tree/tree-readonly.db.test.ts.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/read-only-writes.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import type { SQL } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('best-effort writes on a database that refuses writes', () => {
  type Db = typeof import('@mantle/db');
  type Admin = Parameters<Db['ensureViewerRoles']>[0];
  let m: Db;
  let peers: typeof import('./peers/index');
  let shares: typeof import('./shares');
  let sqlTag: typeof import('drizzle-orm').sql;
  let reader: { name: string; url: string } | null = null;
  const owner = randomUUID();
  const tag = `ro-writes-${owner.slice(0, 8)}`;
  const note = randomUUID();
  const share = randomUUID();
  let peerId = '';
  let token = '';

  const adminClient = () => (m.systemDb as unknown as { $client: Admin }).$client;
  const rows = async <T>(q: SQL) => (await m.db.execute(q)) as unknown as T[];
  const lastSeen = async () =>
    (
      await rows<{ at: string | null }>(
        sqlTag`select last_seen_at::text as at from mantle_peers where id = ${peerId}`,
      )
    )[0]!.at;
  const views = async () =>
    (await rows<{ n: number }>(sqlTag`select view_count as n from shares where id = ${share}`))[0]!
      .n;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    peers = await import('./peers/index');
    shares = await import('./shares');
    sqlTag = (await import('drizzle-orm')).sql;
    await m.db.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role)
      values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`);
    const made = await peers.createPeer(owner, {
      displayName: 'A peer',
      baseUrl: 'https://peer.example.invalid',
    });
    peerId = made.peer.id;
    token = made.inboundToken;
    await m.db.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, data, tags)
      values (${note}, ${owner}, 'note', 'Shared', 'notes', '{"content":"x"}'::jsonb, '{}')`);
    await m.db.execute(sqlTag`
      insert into shares (id, token, owner_id, node_id, node_type)
      values (${share}, ${`${tag}-token`}, ${owner}, ${note}, 'note')`);
  });

  afterAll(async () => {
    if (!m) return;
    await m.closeDb();
    process.env.DATABASE_URL = URL;
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
    if (reader) {
      const { dropReadOnlyRole } = await import('@mantle/db/test-support');
      await dropReadOnlyRole(adminClient(), reader.name);
    }
    await m.closeDb();
  });

  it('on a normal role, stamps the peer and counts the view', async () => {
    expect(await lastSeen()).toBeNull();
    expect((await peers.verifyInboundToken(token))?.id).toBe(peerId);
    expect(await lastSeen()).not.toBeNull();
    await shares.recordShareView(share);
    expect(await views()).toBe(1);
  });

  describe('as a role with SELECT only', () => {
    let seenBefore: string | null = null;

    beforeAll(async () => {
      seenBefore = await lastSeen();
      const { createReadOnlyRole } = await import('@mantle/db/test-support');
      reader = await createReadOnlyRole(adminClient(), URL!);
      await m.closeDb();
      process.env.DATABASE_URL = reader.url;
    });

    it('verifies a peer token without the last-seen stamp', async () => {
      expect((await peers.verifyInboundToken(token))?.id).toBe(peerId);
      expect(await peers.verifyInboundToken(`${token}x`)).toBeNull();
      expect(await lastSeen()).toBe(seenBefore);
    });

    it('serves a share view without counting it, and without a rejection', async () => {
      await expect(shares.recordShareView(share)).resolves.toBeUndefined();
      expect(await views()).toBe(1);
    });
  });
});
