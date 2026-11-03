/**
 * A status peer's token runs as the brain's owner (mcp-auth.ts
 * statusPeerCaller), so the HTTP changes that mint or arm it are the
 * owner's, as for a peer bound to the owner (peer-access.ts
 * peerBoundToOwner, 0353): an Admin user who is not the owner gets 403 for
 * a new token (POST /api/peers/:id/rotate) and for turning it back on
 * (PATCH enabled: true), and nothing changes; turning it off stays open to
 * them. The owner may do both. A `full` peer bound to nobody is as before.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/peer-status-owner.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureTestAnchor } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const who = vi.hoisted(() => ({ anchor: '', actor: '', isOwner: false }));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ownerCaller: vi.fn(() => ({
    id: who.anchor,
    actor: { id: who.actor, email: 'a@example.invalid', isOwner: who.isOwner },
  })),
}));

describe.skipIf(!URL)('a status peer is the owner’s to re-key and re-arm over HTTP', () => {
  let m: typeof import('@mantle/db');
  let sql: Parameters<typeof ensureTestAnchor>[0];
  const tag = `peer-status-owner-${randomUUID().slice(0, 8)}`;
  const admin = randomUUID();
  const peers = { status: randomUUID(), full: randomUUID() };
  const nodes = { status: randomUUID(), full: randomUUID() };

  const row = async (id: string) =>
    (
      (await sql`select inbound_token_hash, enabled, status from mantle_peers
                  where id = ${id}`) as unknown as Record<string, unknown>[]
    )[0]!;

  const asAdmin = () => {
    who.actor = admin;
    who.isOwner = false;
  };
  const asOwner = () => {
    who.actor = who.anchor;
    who.isOwner = true;
  };
  const rotate = async (id: string) => {
    const { POST } = await import('@/app/api/peers/[id]/rotate/route');
    return POST(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ id }) });
  };
  const patch = async (id: string, body: unknown) => {
    const { PATCH } = await import('@/app/api/peers/[id]/route');
    return PATCH(
      new Request('http://x', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    );
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'peer-status-owner-db-test-secret-32-chars';
    m = await import('@mantle/db');
    sql = (m.systemDb as unknown as { $client: typeof sql }).$client;
    who.anchor = await ensureTestAnchor(sql);
    await sql`insert into auth.users (id, email, password_hash, role, display_name)
              values (${admin}, ${`${tag}-admin@example.com`}, 'x', 'admin', 'Another admin')`;
    for (const k of ['status', 'full'] as const) {
      await sql`insert into nodes (id, owner_id, type, title, path)
                values (${nodes[k]}, ${who.anchor}, 'mantle_peer', ${`${tag} ${k}`}, 'peers')`;
      await sql`insert into mantle_peers
                  (id, owner_id, node_id, display_name, base_url, inbound_token_hash,
                   access_scope, enabled, status)
                values (${peers[k]}, ${who.anchor}, ${nodes[k]}, ${`${tag} ${k}`},
                        'https://peer.example.com', ${`${tag}-${k}`}, ${k}, false, 'revoked')`;
    }
  }, 120_000);

  afterAll(async () => {
    await sql`delete from nodes where id in ${sql(Object.values(nodes))}`;
    await sql`delete from auth.users where id = ${admin}`;
    await m.closeDb();
  });

  it('an Admin user who is not the owner may not re-key a status peer', async () => {
    asAdmin();
    const before = await row(peers.status);
    const res = await rotate(peers.status);
    expect(res.status).toBe(403);
    expect(await row(peers.status)).toEqual(before);
  });

  it('nor turn it back on; turning it off stays open', async () => {
    asAdmin();
    const res = await patch(peers.status, { enabled: true });
    expect(res.status).toBe(403);
    expect(await row(peers.status)).toMatchObject({ enabled: false, status: 'revoked' });
    asOwner();
    expect((await patch(peers.status, { enabled: true })).status).toBe(200);
    asAdmin();
    expect((await patch(peers.status, { enabled: false })).status).toBe(200);
    expect(await row(peers.status)).toMatchObject({ enabled: false });
  });

  it('the owner may re-key it', async () => {
    asOwner();
    const before = await row(peers.status);
    const res = await rotate(peers.status);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { inboundToken: string }).inboundToken).toMatch(/^mtlpeer_/);
    expect((await row(peers.status)).inbound_token_hash).not.toBe(before.inbound_token_hash);
  });

  it('a full peer bound to nobody: an Admin user may re-key and re-arm it, as before', async () => {
    asAdmin();
    expect((await rotate(peers.full)).status).toBe(200);
    expect((await patch(peers.full, { enabled: true })).status).toBe(200);
  });
});
