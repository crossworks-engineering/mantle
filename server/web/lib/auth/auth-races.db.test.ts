/**
 * Races on credentials, on a real migrated Postgres (final audit F31):
 *
 *   - an OAuth authorization code is exchanged at most once, even by two
 *     exchanges at the same moment (claim = one DELETE ... RETURNING);
 *   - two refreshes of one web-client bearer at once give ONE new token, and
 *     the loser a 401 (claim = one UPDATE ... WHERE revoked_at IS NULL);
 *   - one contact names at most one login: the partial unique index (0181)
 *     refuses a second, and the users route answers that as a 409.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/auth/auth-races.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({ caller: null as unknown }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => h.caller),
}));

vi.mock('@/lib/audit', () => ({
  auditFireAndForget: () => {},
  requestMetaFrom: () => ({}),
}));

describe.skipIf(!URL)('credential races', () => {
  let m: typeof import('@mantle/db');
  let sql: Parameters<typeof m.ensureViewerRoles>[0];
  const tag = `races-${randomUUID().slice(0, 8)}`;
  const admin = randomUUID();
  const second = randomUUID();
  const third = randomUUID();
  const brain = randomUUID(); // owns the contact node
  const logins = [admin, second, third, brain];
  const contact = randomUUID();
  const client = randomUUID();

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'auth-races-db-test-secret-at-least-32-chars';
    m = await import('@mantle/db');
    sql = (m.systemDb as unknown as { $client: typeof sql }).$client;
    for (const id of logins) {
      await sql`insert into auth.users (id, email, password_hash, role)
                values (${id}, ${`${tag}-${id.slice(0, 8)}@example.com`}, 'x', 'admin')`;
    }
    await sql`insert into spaces (id, kind, login_id) values (${brain}, 'brain', ${brain})`;
    await sql`insert into nodes (id, owner_id, type, title, path)
              values (${contact}, ${brain}, 'contact', 'Pat', 'contacts')`;
    await sql`insert into oauth_clients (id, client_name, redirect_uris)
              values (${client}, ${tag}, ${sql.array(['https://client.example.com/cb'])})`;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from oauth_access_tokens where client_id = ${client}`;
    await sql`delete from oauth_auth_codes where client_id = ${client}`;
    await sql`delete from oauth_clients where id = ${client}`;
    await sql`delete from mobile_tokens where user_id in ${sql(logins)}`;
    await sql`update auth.users set contact_id = null where id in ${sql(logins)}`;
    await sql`delete from nodes where owner_id = ${brain}`;
    await sql`delete from spaces where login_id in ${sql(logins)} or id in ${sql(logins)}`;
    await sql`delete from auth.users where id in ${sql(logins)}`;
  });

  it('exchanges an OAuth code once, however many try at once', async () => {
    const { mintAuthCode, exchangeAuthCode } = await import('../mcp-oauth');
    const verifier = 'v'.repeat(64);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const code = await mintAuthCode({
      clientId: client,
      ownerId: admin,
      actorId: admin,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      redirectUri: 'https://client.example.com/cb',
      scope: 'mcp',
    });
    const exchange = () =>
      exchangeAuthCode({
        code,
        clientId: client,
        redirectUri: 'https://client.example.com/cb',
        codeVerifier: verifier,
      });
    // Hold a row lock on the code while three exchanges start, so all three
    // have read or tried to claim it before any can burn it: the widest the
    // race gets. A SELECT then DELETE lets all three through here; one
    // DELETE ... RETURNING lets exactly one.
    const codeHash = createHash('sha256').update(code, 'utf8').digest('hex');
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    let locked = () => {};
    const isLocked = new Promise<void>((r) => (locked = r));
    const lock = sql.begin(async (tx) => {
      await tx`select id from oauth_auth_codes where code_hash = ${codeHash} for update`;
      locked();
      await held;
    });
    await isLocked;
    const racing = Promise.all([exchange(), exchange(), exchange()]);
    await new Promise((r) => setTimeout(r, 500));
    release();
    await lock;
    const results = await racing;
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const grants = await sql<Row[]>`select id from oauth_access_tokens where client_id = ${client}`;
    expect(grants).toHaveLength(1);
    // And the code is gone for good.
    expect((await exchange()).ok).toBe(false);
  });

  it('rotates a web-client bearer once when two refreshes race', async () => {
    const { buildMobileToken, WEB_TOKEN_TTL_SECONDS } = await import('./tokens');
    const { POST } = await import('../../app/api/auth/token/refresh/route');
    const jti = randomUUID();
    const minted = buildMobileToken(admin, jti, WEB_TOKEN_TTL_SECONDS);
    await sql`insert into mobile_tokens (id, user_id, label, expires_at)
              values (${jti}, ${admin}, ${tag}, ${minted.expiresAt.toISOString()})`;
    let n = 0;
    const refresh = () =>
      POST(
        new Request('http://x/api/auth/token/refresh', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${minted.value}`,
            'x-forwarded-for': `198.51.100.${++n}`,
          },
        }),
      );
    const statuses = (await Promise.all([refresh(), refresh(), refresh()])).map((r) => r.status);
    expect(statuses.sort()).toEqual([200, 401, 401]);
    const live = await sql<Row[]>`select id from mobile_tokens
                                  where user_id = ${admin} and label = ${tag} and revoked_at is null`;
    expect(live).toHaveLength(1);
    expect(live[0]!.id).not.toBe(jti);
  });

  it('refuses a second login on one contact', async () => {
    await sql`update auth.users set contact_id = ${contact} where id = ${second}`;
    await expect(
      sql`update auth.users set contact_id = ${contact} where id = ${third}`,
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('answers the lost race on the users route with a 409, not a 500', async () => {
    await sql`update auth.users set contact_id = null where id in ${sql([second, third])}`;
    // Two links at once: both pre-checks can pass before either writes; the
    // index stops the second, which must read as the pre-check's 409.
    const { PATCH } = await import('../../app/api/users/[id]/route');
    h.caller = {
      id: brain,
      email: `${tag}@example.com`,
      actor: { id: admin, email: `${tag}@example.com`, displayName: null, isOwner: false },
    };
    {
      const patch = (id: string) =>
        PATCH(
          new Request(`http://x/api/users/${id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ contactId: contact }),
          }),
          { params: Promise.resolve({ id }) },
        );
      const statuses = (await Promise.all([patch(second), patch(third)])).map((r) => r.status);
      expect(statuses.sort()).toEqual([200, 409]);
      const linked = await sql<Row[]>`select id from auth.users where contact_id = ${contact}`;
      expect(linked).toHaveLength(1);
    }
  });
});
