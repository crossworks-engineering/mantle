/**
 * The OAuth lock (lib/oauth-lock.ts) on a real migrated Postgres:
 *
 *  - verification audit N1: more parallel refreshes than the pool has
 *    connections (10) all finish, and the pool still answers after; a
 *    revoked refresh token takes no lock at all;
 *  - N2: a code is not minted for a session that ended after consent;
 *  - N3: turning a login's MCP off revokes its grants and deletes its open
 *    codes, under the lock.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/mcp-oauth-lock.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureTestAnchor } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

/** Every lockOauthActor call, counted, then passed to the real one: a test
 *  can then prove a path takes the lock, or does not. */
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

describe.skipIf(!URL)('the OAuth lock', () => {
  let m: typeof import('@mantle/db');
  let sql: Parameters<typeof m.ensureViewerRoles>[0];
  let oauth: typeof import('./mcp-oauth');
  let tokens: typeof import('./auth/tokens');
  let app: import('hono').Hono;
  let anchor = '';
  const tag = `oalock-${randomUUID().slice(0, 8)}`;
  const admin = randomUUID();
  const member = randomUUID();
  const client = randomUUID();
  const all = [admin, member];
  const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

  /** A live grant for `actor` with a known refresh token. */
  const grant = async (actor: string, revoked = false) => {
    const refresh = `mtlmcp_rt_${randomUUID()}`;
    const id = randomUUID();
    await sql`insert into oauth_access_tokens
        (id, token_hash, refresh_token_hash, owner_id, actor_id, client_id,
         expires_at, refresh_expires_at, revoked_at, session_epoch)
      values (${id}, ${sha(`at-${id}`)}, ${sha(refresh)}, ${anchor}, ${actor}, ${client},
              now() + interval '1 hour', now() + interval '30 days',
              ${revoked ? new Date().toISOString() : null}, null)`;
    return { id, refresh };
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'oauth-lock-db-test-secret-at-least-32-chars';
    delete process.env.MANTLE_DETACHED_DEV;
    m = await import('@mantle/db');
    sql = (m.systemDb as unknown as { $client: typeof sql }).$client;
    oauth = await import('./mcp-oauth');
    tokens = await import('./auth/tokens');
    anchor = await ensureTestAnchor(sql);
    await sql`insert into auth.users (id, email, password_hash, role, display_name) values
      (${admin}, ${`${tag}-admin@example.com`}, 'x', 'admin', 'Ada Admin'),
      (${member}, ${`${tag}-member@example.com`}, 'x', 'member', 'Mia Member')`;
    await sql`insert into oauth_clients (id, client_name, redirect_uris)
              values (${client}, ${`${tag} client`}, ${['https://c.example/cb']})`;
    const { createApp } = await import('../server/app');
    app = await createApp();
  }, 120_000);

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from oauth_access_tokens where client_id = ${client}`;
    await sql`delete from oauth_auth_codes where client_id = ${client}`;
    await sql`delete from oauth_clients where id = ${client}`;
    await sql`delete from mcp_login_access where login_id in ${sql(all)}`;
    await sql`delete from spaces where login_id in ${sql(all)}`;
    await sql`delete from auth.users where id in ${sql(all)}`;
  });

  it('finishes more parallel refreshes than the pool has connections (N1)', async () => {
    const { refresh } = await grant(admin);
    const started = Date.now();
    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        oauth.refreshAccessToken({ refreshToken: refresh, clientId: client }),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(Date.now() - started).toBeLessThan(15_000);
    // The pool still answers.
    const [one] = await sql<Row[]>`select 1 as one`;
    expect(Number(one!.one)).toBe(1);
  }, 30_000);

  it('takes no lock for a revoked refresh token (N1)', async () => {
    const { refresh } = await grant(admin, true);
    // A live token does take it: the count is a real signal.
    const live = await grant(admin);
    const before = locks.calls;
    expect(
      (await oauth.refreshAccessToken({ refreshToken: live.refresh, clientId: client })).ok,
    ).toBe(true);
    expect(locks.calls).toBe(before + 1);

    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        oauth.refreshAccessToken({ refreshToken: refresh, clientId: client }),
      ),
    );
    expect(results.every((r) => !r.ok)).toBe(true);
    // Not one of the 25 took the lock (or a transaction).
    expect(locks.calls).toBe(before + 1);
  }, 30_000);

  it('mints no code for a session that ended after consent (N2)', async () => {
    const [row] = await sql<Row[]>`select session_epoch from auth.users where id = ${admin}`;
    const epoch = Number(row!.session_epoch);
    const input = {
      clientId: client,
      ownerId: anchor,
      actorId: admin,
      codeChallenge: 'c'.repeat(43),
      codeChallengeMethod: 'S256',
      redirectUri: 'https://c.example/cb',
      scope: 'mcp',
    };
    expect(await oauth.mintAuthCode({ ...input, consentEpoch: epoch })).toBeTruthy();
    await sql`update auth.users set session_epoch = session_epoch + 1 where id = ${admin}`;
    expect(await oauth.mintAuthCode({ ...input, consentEpoch: epoch })).toBeNull();
  });

  it("revokes grants and deletes open codes when a login's MCP is turned off (N3)", async () => {
    await sql`insert into mcp_login_access (login_id, enabled, write_enabled)
              values (${member}, true, false)
              on conflict (login_id) do update set enabled = true`;
    const g = await grant(member);
    await sql`insert into oauth_auth_codes
        (code_hash, client_id, owner_id, actor_id, code_challenge, code_challenge_method,
         redirect_uri, scope, expires_at)
      values (${sha(`code-${randomUUID()}`)}, ${client}, ${anchor}, ${member}, ${'c'.repeat(43)},
              'S256', 'https://c.example/cb', 'mcp', now() + interval '5 minutes')`;
    const [a] = await sql<Row[]>`select session_epoch from auth.users where id = ${admin}`;
    const cookie = `mantle_session=${
      tokens.buildSessionCookie(admin, { epoch: Number(a!.session_epoch) }).value
    }`;
    const res = await app.request(`/api/mcp-logins/${member}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    const [row] = await sql<Row[]>`select revoked_at from oauth_access_tokens where id = ${g.id}`;
    expect(row!.revoked_at).not.toBeNull();
    const codes = await sql<Row[]>`select 1 from oauth_auth_codes where actor_id = ${member}`;
    expect(codes).toHaveLength(0);
  });
});
