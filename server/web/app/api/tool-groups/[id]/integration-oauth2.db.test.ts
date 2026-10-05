/**
 * A save from the owner's tool-group editor must not drop the OAuth2 token
 * config Toolsmith stored on the binding: the editor has no oauth2 field and
 * the binding is stored whole. On a real, migrated Postgres; only the owner
 * check is stood in. Seeds its own brain and removes it.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run integration-oauth2.db.test
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const h = vi.hoisted(() => ({ owner: '' }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({
    id: h.owner,
    email: 'admin@example.invalid',
    actor: { id: h.owner, email: 'admin@example.invalid', displayName: null, isOwner: true },
  })),
}));

type Route = (req: Request, ctx?: { params: Promise<unknown> }) => Promise<Response>;

describe.skipIf(!URL)('tool group PATCH keeps the stored oauth2', () => {
  let m: typeof import('@mantle/db');
  let sqlTag: typeof import('drizzle-orm').sql;
  let patch: Route;
  const owner = randomUUID();
  h.owner = owner;
  const tag = `tgoauth-${owner.slice(0, 8)}`;
  const groupId = randomUUID();

  const oauth2 = {
    grant: 'client_credentials',
    tokenUrl: 'https://auth.example.invalid/token',
    clientIdRef: 'acme/client-id',
    clientSecretRef: 'acme/client-secret',
  };
  // What the editor sends: the fields it shows, no oauth2.
  const editorBody = {
    service: 'acme',
    baseUrl: 'https://api.example.invalid',
    authTemplate: { headers: { Authorization: `Bearer {{oauth:${tag}}}` } },
  };

  const call = (body: unknown) =>
    new Request('http://brain.test/x', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const ctx = { params: Promise.resolve({ id: groupId }) };
  const stored = async () => {
    const rows = (await m.db.execute(
      sqlTag`select integration from tool_groups where id = ${groupId}`,
    )) as unknown as { integration: Record<string, unknown> | null }[];
    return rows[0]!.integration;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    sqlTag = (await import('drizzle-orm')).sql;
    patch = (await import('./route')).PATCH as unknown as Route;
    await m.db.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role) values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await m.db.execute(
      sqlTag`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`,
    );
    await m.db.execute(sqlTag`
      insert into tool_groups (id, owner_id, slug, name, integration) values
        (${groupId}, ${owner}, ${tag}, 'oauth group',
         ${JSON.stringify({ ...editorBody, oauth2 })}::jsonb)`);
  }, 60_000);

  afterAll(async () => {
    await m.db.execute(sqlTag`delete from tool_groups where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
    await m.closeDb();
  }, 60_000);

  it('an editor save without oauth2 keeps the stored one', async () => {
    const res = await patch(call({ integration: { ...editorBody, service: 'acme2' } }), ctx);
    expect(res.status).toBe(200);
    const integration = await stored();
    expect(integration?.service).toBe('acme2');
    expect(integration?.oauth2).toMatchObject(oauth2);
  });

  it('oauth2: null clears it', async () => {
    const res = await patch(call({ integration: { ...editorBody, oauth2: null } }), ctx);
    expect(res.status).toBe(200);
    expect(await stored()).not.toHaveProperty('oauth2');
  });
});
