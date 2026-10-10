/**
 * A peer bound to a login is a credential of that login, and ends with its
 * other credentials (access matrix L12, L13), on a real migrated Postgres:
 *
 *  - L12: End sessions (and a password change, which runs the same
 *    endLoginSessions with endKeys) unbinds every peer that acts as the
 *    login; a peer bound to someone else is not touched;
 *  - L13: turning the login's MCP off revokes its API keys and unbinds its
 *    peers, so turning MCP on again brings neither back. The key rows, like
 *    the peer rows, say the MCP switch did it (T17).
 *
 * An unbound peer keeps its federation grants; it only stops acting as the
 * login (mcp-auth.ts refuses a peer bound to nobody).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/peer-unbind.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureTestAnchor } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
// The audit rows are written fire-and-forget after the response (audit must
// never break the request it describes). vi.waitFor's 1 s default is too
// short when the full suite loads the database: the row lands, just later.
const AUDIT_WAIT = { timeout: 10_000, interval: 50 };

const who = vi.hoisted(() => ({ anchor: '', admin: '' }));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({ id: who.anchor, actor: { id: who.admin, email: 'a' } })),
}));

type Peer = {
  acts_as_login_id: string | null;
  acts_as_role: string | null;
  write_enabled: boolean;
  ended_acts_as_login_id: string | null;
};

describe.skipIf(!URL)('peer bindings end with the login', () => {
  let m: typeof import('@mantle/db');
  let sql: Parameters<typeof m.ensureViewerRoles>[0];
  const tag = `peer-unbind-${randomUUID().slice(0, 8)}`;
  const member = randomUUID();
  const client = randomUUID();
  const peers = { member: randomUUID(), client: randomUUID(), other: randomUUID() };
  const nodesOf = { member: randomUUID(), client: randomUUID(), other: randomUUID() };
  const key = randomUUID();

  const peer = async (id: string) =>
    (
      (await sql`select acts_as_login_id, acts_as_role, write_enabled, ended_acts_as_login_id
                   from mantle_peers where id = ${id}`) as unknown as Peer[]
    )[0]!;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'peer-unbind-db-test-secret-at-least-32-chars';
    m = await import('@mantle/db');
    sql = (m.systemDb as unknown as { $client: typeof sql }).$client;
    who.anchor = await ensureTestAnchor(sql);
    who.admin = who.anchor;
    await sql`insert into auth.users (id, email, password_hash, role, display_name) values
      (${member}, ${`${tag}-member@example.com`}, 'x', 'member', 'A member'),
      (${client}, ${`${tag}-client@example.com`}, 'x', 'client', 'A client')`;
    for (const k of ['member', 'client', 'other'] as const) {
      await sql`insert into nodes (id, owner_id, type, title, path)
                values (${nodesOf[k]}, ${who.anchor}, 'mantle_peer', ${`${tag} ${k}`}, 'peers')`;
    }
    const bound = (k: 'member' | 'client' | 'other', login: string, role: string) => sql`
      insert into mantle_peers
        (id, owner_id, node_id, display_name, base_url, inbound_token_hash,
         acts_as_login_id, acts_as_role, write_enabled)
      values (${peers[k]}, ${who.anchor}, ${nodesOf[k]}, ${`${tag} ${k}`},
              'https://peer.example.invalid', ${`${tag}-${k}`}, ${login}, ${role}, true)`;
    await bound('member', member, 'member');
    await bound('client', client, 'client');
    await bound('other', who.anchor, 'admin');
    await sql`insert into mcp_login_access (login_id, enabled, write_enabled)
              values (${client}, true, true)`;
    // A client key carries the session epoch it was made in.
    await sql`insert into access_keys
                (id, name, login_id, login_role, key_prefix, key_hash, access, session_epoch)
              select ${key}, 'script', ${client}, 'client', ${key.replace(/-/g, '').slice(0, 8)},
                     ${createHash('sha256').update(tag).digest('hex')}, 'read',
                     session_epoch
                from auth.users where id = ${client}`;
  }, 120_000);

  afterAll(async () => {
    await sql`delete from access_keys where login_id in (${member}, ${client})`;
    await sql`delete from mcp_login_access where login_id in (${member}, ${client})`;
    await sql`delete from nodes where id in ${sql(Object.values(nodesOf))}`;
    await sql`delete from spaces where login_id in (${member}, ${client})`;
    await sql`delete from auth.users where id in (${member}, ${client})`;
    await m.closeDb();
  });

  const unboundAudits = async (peerId: string) =>
    (await sql`select detail->>'reason' as reason from audit_log
                where action = 'peer.unbound' and detail->>'peerId' = ${peerId}`) as unknown as {
      reason: string;
    }[];

  it('End sessions unbinds the peers that act as the login, and only those', async () => {
    const { endLoginSessions } = await import('./auth/session');
    const unboundPeerIds: string[] = [];
    await endLoginSessions(member, { endKeys: true, actorId: who.admin, unboundPeerIds });
    expect(unboundPeerIds).toEqual([peers.member]);
    // Unbound; Write kept and the binding remembered, for a one-step rebind.
    expect(await peer(peers.member)).toEqual({
      acts_as_login_id: null,
      acts_as_role: null,
      write_enabled: true,
      ended_acts_as_login_id: member,
    });
    await vi.waitFor(
      async () => expect(await unboundAudits(peers.member)).toEqual([{ reason: 'sessions-ended' }]),
      AUDIT_WAIT,
    );
    expect((await peer(peers.client)).acts_as_login_id).toBe(client);
    expect((await peer(peers.other)).acts_as_login_id).toBe(who.anchor);
  }, 30_000);

  it('turning MCP off revokes the keys and unbinds the peers, for good', async () => {
    const { PATCH } = await import('../app/api/mcp-logins/[id]/route');
    const patch = (enabled: boolean) =>
      PATCH(
        new Request('http://x/api/mcp-logins/x', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled }),
        }),
        { params: Promise.resolve({ id: client }) },
      );
    const off = await patch(false);
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ enabled: false, peersUnbound: 1 });
    await vi.waitFor(
      async () => expect(await unboundAudits(peers.client)).toEqual([{ reason: 'mcp-off' }]),
      AUDIT_WAIT,
    );
    const [k] =
      (await sql`select revoked_at, revoked_by from access_keys where id = ${key}`) as unknown as {
        revoked_at: Date | null;
        revoked_by: string | null;
      }[];
    expect(k!.revoked_at).not.toBeNull();
    expect(k!.revoked_by).toBe(who.admin);
    expect((await peer(peers.client)).acts_as_login_id).toBeNull();
    // The key row names the switch, as the peer row does (T17).
    await vi.waitFor(
      async () =>
        expect(
          (
            await sql`select actor_email, detail->>'reason' as reason from audit_log
                     where action = 'key.revoked' and detail->'keyIds' ? ${key}`
          ).map((r) => ({ ...r })),
        ).toEqual([{ actor_email: 'mcp-switch', reason: 'mcp-off' }]),
      AUDIT_WAIT,
    );
    // On again: nothing comes back.
    expect((await patch(true)).status).toBe(200);
    const [again] =
      (await sql`select revoked_at from access_keys where id = ${key}`) as unknown as {
        revoked_at: Date | null;
      }[];
    expect(again!.revoked_at).not.toBeNull();
    expect((await peer(peers.client)).acts_as_login_id).toBeNull();
    expect((await peer(peers.other)).acts_as_login_id).toBe(who.anchor);
  }, 30_000);

  it('binding a peer again to the same login restores Write; another login starts closed', async () => {
    const { setPeerAccess } = await import('@mantle/content');
    const back = await setPeerAccess(who.anchor, peers.member, {
      actsAs: { loginId: member, role: 'member' },
    });
    expect(back).toMatchObject({ actsAsLoginId: member, writeEnabled: true });
    expect((await peer(peers.member)).ended_acts_as_login_id).toBeNull();
    // The client peer was unbound by MCP off; bound to a different login,
    // it starts closed as before.
    const moved = await setPeerAccess(who.anchor, peers.client, {
      actsAs: { loginId: member, role: 'member' },
    });
    expect(moved).toMatchObject({ actsAsLoginId: member, writeEnabled: false });
  });
});
