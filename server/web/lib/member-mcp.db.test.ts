/**
 * A member's own MCP screen (team apps Phase 1) on a real migrated Postgres,
 * through the real app:
 *
 *  - GET /api/member/mcp answers the member's own switches and THEIR OWN
 *    connected clients, never another login's;
 *  - DELETE /api/member/mcp/clients/:id ends only this member's grants on
 *    that client (and their open codes), under the login's OAuth lock; the
 *    client registration and a teammate's grant on it stay;
 *  - a client the member holds no live grant on is a 404; an admin is
 *    refused (the member view is a member's).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/member-mcp.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureTestAnchor } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const locks = vi.hoisted(() => ({ calls: 0 }));
vi.mock('./oauth-lock', async (importOriginal) => {
  const real = await importOriginal<typeof import('./oauth-lock')>();
  return {
    ...real,
    lockOauthActor: async (...args: Parameters<typeof real.lockOauthActor>) => {
      locks.calls += 1;
      return real.lockOauthActor(...args);
    },
  };
});

type Row = Record<string, unknown>;

describe.skipIf(!URL)("a member's own MCP screen", () => {
  let m: typeof import('@mantle/db');
  let sql: Parameters<typeof m.ensureViewerRoles>[0];
  let tokens: typeof import('./auth/tokens');
  let app: import('hono').Hono;
  let anchor = '';
  const tag = `mmcp-${randomUUID().slice(0, 8)}`;
  const admin = randomUUID();
  const member = randomUUID();
  const mate = randomUUID();
  const all = [admin, member, mate];
  const clientA = randomUUID();
  const clientB = randomUUID();
  const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

  const grant = async (actor: string, client: string, revoked = false) => {
    const id = randomUUID();
    await sql`insert into oauth_access_tokens
        (id, token_hash, refresh_token_hash, owner_id, actor_id, client_id,
         expires_at, refresh_expires_at, revoked_at, session_epoch)
      values (${id}, ${sha(`at-${id}`)}, ${sha(`rt-${id}`)}, ${anchor}, ${actor}, ${client},
              now() + interval '1 hour', now() + interval '30 days',
              ${revoked ? new Date().toISOString() : null}, 0)`;
    return id;
  };
  const code = (actor: string, client: string) => sql`insert into oauth_auth_codes
      (code_hash, client_id, owner_id, actor_id, code_challenge, code_challenge_method,
       redirect_uri, scope, expires_at)
    values (${sha(`code-${randomUUID()}`)}, ${client}, ${anchor}, ${actor}, ${'c'.repeat(43)},
            'S256', 'https://c.example/cb', 'mcp', now() + interval '5 minutes')`;
  const cookieFor = async (id: string) => {
    const [u] = await sql<Row[]>`select session_epoch from auth.users where id = ${id}`;
    return `mantle_session=${tokens.buildSessionCookie(id, { epoch: Number(u!.session_epoch) }).value}`;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'member-mcp-db-test-secret-at-least-32-chars';
    delete process.env.MANTLE_DETACHED_DEV;
    m = await import('@mantle/db');
    sql = (m.systemDb as unknown as { $client: typeof sql }).$client;
    tokens = await import('./auth/tokens');
    anchor = await ensureTestAnchor(sql);
    await sql`insert into auth.users (id, email, password_hash, role, display_name) values
      (${admin}, ${`${tag}-admin@example.com`}, 'x', 'admin', 'Ada Admin'),
      (${member}, ${`${tag}-member@example.com`}, 'x', 'member', 'Mia Member'),
      (${mate}, ${`${tag}-mate@example.com`}, 'x', 'member', 'Max Mate')`;
    await sql`insert into oauth_clients (id, client_name, redirect_uris) values
      (${clientA}, ${`${tag} A`}, ${['https://c.example/cb']}),
      (${clientB}, ${`${tag} B`}, ${['https://c.example/cb']})`;
    await sql`insert into mcp_login_access (login_id, enabled, write_enabled)
              values (${member}, true, true)`;
    const { createApp } = await import('../server/app');
    app = await createApp();
  }, 120_000);

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from oauth_access_tokens where client_id in (${clientA}, ${clientB})`;
    await sql`delete from oauth_auth_codes where client_id in (${clientA}, ${clientB})`;
    await sql`delete from oauth_clients where id in (${clientA}, ${clientB})`;
    await sql`delete from mcp_login_access where login_id in ${sql(all)}`;
    await sql`delete from spaces where login_id in ${sql(all)}`;
    await sql`delete from auth.users where id in ${sql(all)}`;
  });

  it("lists the member's own switches and own clients only", async () => {
    await grant(member, clientA);
    await grant(member, clientA);
    await grant(member, clientB, true);
    await grant(mate, clientB);
    const res = await app.request('/api/member/mcp', {
      headers: { cookie: await cookieFor(member) },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as import('@mantle/client-types').MemberMcpView;
    expect(body.access).toEqual({ enabled: true, writeEnabled: true });
    expect(typeof body.connectorUrl).toBe('string');
    expect(body.clients.map((c) => [c.id, c.activeTokens])).toEqual([[clientA, 2]]);
  });

  it("disconnects only the member's own grants on that client", async () => {
    const mates = await grant(mate, clientA);
    await code(member, clientA);
    await code(mate, clientA);
    const before = locks.calls;
    const res = await app.request(`/api/member/mcp/clients/${clientA}`, {
      method: 'DELETE',
      headers: { cookie: await cookieFor(member) },
    });
    expect(res.status).toBe(200);
    expect(locks.calls).toBe(before + 1);
    const live = await sql<Row[]>`select actor_id from oauth_access_tokens
      where client_id = ${clientA} and revoked_at is null`;
    expect(live.map((r) => r.actor_id)).toEqual([mate]);
    const [mateRow] = await sql<
      Row[]
    >`select revoked_at from oauth_access_tokens where id = ${mates}`;
    expect(mateRow!.revoked_at).toBeNull();
    const codes = await sql<
      Row[]
    >`select actor_id from oauth_auth_codes where client_id = ${clientA}`;
    expect(codes.map((r) => r.actor_id)).toEqual([mate]);
    const [still] = await sql<Row[]>`select id from oauth_clients where id = ${clientA}`;
    expect(still).toBeTruthy();
  });

  it("answers 404 for a client the member holds no live grant on (a teammate's included)", async () => {
    const cookie = await cookieFor(member);
    for (const id of [clientA, clientB, randomUUID(), 'not-a-uuid']) {
      const res = await app.request(`/api/member/mcp/clients/${id}`, {
        method: 'DELETE',
        headers: { cookie },
      });
      expect(res.status, id).toBe(404);
    }
    const [mateB] = await sql<Row[]>`select count(*)::int as n from oauth_access_tokens
      where client_id = ${clientB} and actor_id = ${mate} and revoked_at is null`;
    expect(mateB!.n).toBe(1);
  });

  it("refuses an admin: the member view is a member's", async () => {
    const res = await app.request('/api/member/mcp', {
      headers: { cookie: await cookieFor(admin) },
    });
    expect(res.status).toBe(403);
  });
});
