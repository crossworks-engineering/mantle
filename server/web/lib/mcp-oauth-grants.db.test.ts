/**
 * The OAuth token endpoint on a real migrated Postgres, through the real app:
 *
 *  - T10: while the box's MCP switch is off (Settings > MCP), the token
 *    endpoint answers 404 like the rest of the connector: a refresh mints no
 *    grant and a code is not exchanged;
 *  - T11: a code exchange and a refresh each write an audit row naming the
 *    login and the client.
 *
 * The switch is the brain's own preference, so this file sets it through
 * the real route and puts it back as it found it.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/mcp-oauth-grants.db.test.ts
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureTestAnchor } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Row = Record<string, unknown>;

describe.skipIf(!URL)('the OAuth token endpoint', () => {
  let m: typeof import('@mantle/db');
  let sql: Parameters<typeof m.ensureViewerRoles>[0];
  let oauth: typeof import('./mcp-oauth');
  let tokens: typeof import('./auth/tokens');
  let app: import('hono').Hono;
  let anchor = '';
  let wasOn = false;
  const tag = `oagrant-${randomUUID().slice(0, 8)}`;
  const admin = randomUUID();
  const client = randomUUID();
  const REDIRECT = 'https://c.example.invalid/cb';
  let ip = 0;

  const asAdmin = () => `mantle_session=${tokens.buildSessionCookie(admin).value}`;
  const setBoxSwitch = async (enabled: boolean) => {
    const res = await app.request('/api/mcp-settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: asAdmin() },
      body: JSON.stringify({ enabled }),
    });
    expect(res.status).toBe(200);
  };
  const token = (form: Record<string, string>) => {
    ip += 1;
    return app.request('/api/oauth/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-forwarded-for': `198.51.100.${ip % 250}`,
      },
      body: new URLSearchParams(form).toString(),
    });
  };
  /** A code for the admin, as the consent page mints it, and its verifier. */
  const freshCode = async () => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const code = await oauth.mintAuthCode({
      clientId: client,
      ownerId: anchor,
      actorId: admin,
      sessionEpoch: null,
      consentEpoch: 0,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      redirectUri: REDIRECT,
      scope: 'mcp',
    });
    expect(code).toBeTruthy();
    return { code: code!, verifier };
  };
  const exchange = (c: { code: string; verifier: string }) =>
    token({
      grant_type: 'authorization_code',
      code: c.code,
      redirect_uri: REDIRECT,
      client_id: client,
      code_verifier: c.verifier,
    });
  const refresh = (refreshToken: string) =>
    token({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: client });
  const grants = async () =>
    Number(
      (
        await sql<Row[]>`select count(*)::int as n from oauth_access_tokens
                         where client_id = ${client}`
      )[0]!.n,
    );
  const audited = async (action: string) => {
    for (let i = 0; i < 100; i += 1) {
      const rows = await sql<Row[]>`
        select actor_id, actor_email, path, detail from audit_log
        where action = ${action} and detail->>'clientId' = ${client}`;
      if (rows.length) return rows.map((r) => ({ ...r }));
      await new Promise((r) => setTimeout(r, 20));
    }
    return [];
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'oauth-grants-db-test-secret-at-least-32-chars';
    delete process.env.MANTLE_DETACHED_DEV;
    m = await import('@mantle/db');
    sql = (m.systemDb as unknown as { $client: typeof sql }).$client;
    oauth = await import('./mcp-oauth');
    tokens = await import('./auth/tokens');
    anchor = await ensureTestAnchor(sql);
    await sql`insert into auth.users (id, email, password_hash, role, display_name)
              values (${admin}, ${`${tag}-admin@example.com`}, 'x', 'admin', 'Ada Admin')`;
    await sql`insert into oauth_clients (id, client_name, redirect_uris)
              values (${client}, ${`${tag} client`}, ${[REDIRECT]})`;
    const { createApp } = await import('../server/app');
    app = await createApp();
    wasOn = await oauth.isRemoteMcpEnabled();
  }, 120_000);

  afterAll(async () => {
    if (!sql) return;
    if (app) await setBoxSwitch(wasOn);
    await sql`delete from audit_log where detail->>'clientId' = ${client}`;
    await sql`delete from oauth_access_tokens where client_id = ${client}`;
    await sql`delete from oauth_auth_codes where client_id = ${client}`;
    await sql`delete from oauth_clients where id = ${client}`;
    await sql`delete from audit_log where actor_id = ${admin}`;
    await sql`delete from spaces where login_id = ${admin}`;
    await sql`delete from auth.users where id = ${admin}`;
  });

  it('puts a code exchange and a refresh on the audit trail (T11)', async () => {
    await setBoxSwitch(true);
    const res = await exchange(await freshCode());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { refresh_token: string };
    expect(await audited('oauth.code_exchanged')).toEqual([
      expect.objectContaining({
        actor_id: admin,
        actor_email: `${tag}-admin@example.com`,
        path: '/api/oauth/token',
        detail: { clientId: client },
      }),
    ]);
    expect((await refresh(body.refresh_token)).status).toBe(200);
    expect(await audited('oauth.token_refreshed')).toEqual([
      expect.objectContaining({ actor_id: admin, detail: { clientId: client } }),
    ]);
  });

  it('mints nothing while the box switch is off (T10)', async () => {
    await setBoxSwitch(true);
    const first = (await (await exchange(await freshCode())).json()) as {
      refresh_token: string;
    };
    const code = await freshCode();
    await setBoxSwitch(false);
    const before = await grants();
    const refused = await refresh(first.refresh_token);
    expect(refused.status).toBe(404);
    expect((await exchange(code)).status).toBe(404);
    expect(await grants()).toBe(before);
    // On again, the endpoint answers once more.
    await setBoxSwitch(true);
    expect((await exchange(code)).status).toBe(200);
  });
});
