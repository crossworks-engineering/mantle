/**
 * A new key in a connector's vault entry voids its read-only marks (access
 * matrix T7), on a real migrated Postgres. The guide says a new key does;
 * only a change of the binding (url, secretRef, header, scheme, OAuth app or
 * scope) did, so an admin who rotated the entry, or saved another account's
 * key over it, kept the marks taken on the old account. POST
 * /api/keys/:id/rotate and a save over the same service and label now void
 * them; a key no connector uses voids nothing. Only the owner check is
 * stubbed.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run key-replace-voids-marks.db.test
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const h = vi.hoisted(() => ({ owner: '' }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({
    id: h.owner,
    actor: { id: h.owner, displayName: 'Admin' },
  })),
}));

describe.skipIf(!URL)("replacing a connector's key", () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let ta: typeof import('@mantle/tools');
  let keys: typeof import('@mantle/api-keys');
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const tag = `key-marks-${owner.slice(0, 8)}`;
  let toolId = '';
  let keyId = '';
  let prevMasterKey: string | undefined;

  const exec = (q: ReturnType<typeof sqlTag>) => m.systemDb.execute(q);
  const mark = async () => {
    const res = await ta.setToolExternalAccess(owner, toolId, {
      allow: true,
      readOnlyConfirmed: true,
      by: { via: 'web', actorId: owner, actorEmail: `${tag}@example.invalid` },
    });
    expect(res.ok).toBe(true);
  };
  const state = async () => {
    const [r] = (await exec(sqlTag`
      select slug, handler, requires_confirm as "requiresConfirm",
        external_access as "externalAccess", description, input_schema as "inputSchema"
      from tools where id = ${toolId}`)) as unknown as Parameters<
      typeof ta.connectorMarkState
    >[0][];
    return ta.connectorMarkState(r!);
  };
  const post = (path: string, body: unknown) =>
    new Request(`http://brain.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    // The vault seals with a 32-byte master key; this test's own.
    prevMasterKey = process.env.MANTLE_MASTER_KEY;
    process.env.MANTLE_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
    m = await import('@mantle/db');
    ta = await import('@mantle/tools');
    keys = await import('@mantle/api-keys');
    sqlTag = (await import('drizzle-orm')).sql;
    h.owner = owner;
    await exec(sqlTag`
      insert into auth.users (id, email, password_hash, role)
      values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await exec(
      sqlTag`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`,
    );
    keyId = (await keys.setApiKey(owner, 'site-key', 'default', 'first-account-key')).id;
    const handler = JSON.stringify({ kind: 'mcp', group: 'mcp-site', toolName: 'query' });
    const [t] = (await exec(sqlTag`
      insert into tools (owner_id, slug, name, description, handler, input_schema)
      values (${owner}, 'site_query', 'n', 'd', ${handler}::jsonb,
        '{"type":"object","properties":{"q":{"type":"string"}}}'::jsonb)
      returning id`)) as unknown as { id: string }[];
    toolId = t!.id;
    const binding = JSON.stringify({
      service: 'mcp-site',
      mcp: { url: 'https://mcp.example.test/mcp', secretRef: 'site-key/default' },
    });
    await exec(sqlTag`
      insert into tool_groups (owner_id, slug, name, tool_slugs, audience, enabled, integration)
      values (${owner}, 'mcp-site', 'site', ARRAY['site_query'], 'team', true, ${binding}::jsonb)`);
  }, 60_000);

  afterAll(async () => {
    if (!m) return;
    await exec(sqlTag`delete from audit_log where detail->>'toolId' = ${toolId}`);
    await exec(sqlTag`delete from tool_groups where owner_id = ${owner}`);
    await exec(sqlTag`delete from tools where owner_id = ${owner}`);
    await exec(sqlTag`delete from api_keys where user_id = ${owner}`);
    await exec(sqlTag`delete from spaces where login_id = ${owner}`);
    await exec(sqlTag`delete from auth.users where id = ${owner}`);
    await m.closeDb();
    if (prevMasterKey === undefined) delete process.env.MANTLE_MASTER_KEY;
    else process.env.MANTLE_MASTER_KEY = prevMasterKey;
  }, 60_000);

  it('a key no connector uses voids nothing', async () => {
    await mark();
    const { POST } = await import('./route');
    const res = await POST(
      post('/api/keys', { service: 'other-key', label: 'default', plaintext: 'x' }),
    );
    expect(res.status).toBe(200);
    expect(await state()).toBe('read');
  });

  it('a rotate of the connector key voids the mark', async () => {
    await mark();
    const { POST } = await import('./[id]/rotate/route');
    const res = await POST(post(`/api/keys/${keyId}/rotate`, { plaintext: 'other-account-key' }), {
      params: Promise.resolve({ id: keyId }),
    });
    expect(res.status).toBe(200);
    expect(await state()).toBe('stale');
  });

  it('a save over the same service and label voids the mark', async () => {
    await mark();
    expect(await state()).toBe('read');
    const { POST } = await import('./route');
    const res = await POST(
      post('/api/keys', { service: 'site-key', label: 'default', plaintext: 'third-account-key' }),
    );
    expect(res.status).toBe(200);
    expect(await state()).toBe('stale');
  });
});
