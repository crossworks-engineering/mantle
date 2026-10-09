/**
 * POST /api/keys when the label is taken, without a database. Drizzle wraps
 * the Postgres error: the top message is "Failed query: ..." and the 23505
 * sits on `cause`. The route used to read the message, so a duplicate
 * answered 500; it must answer 409.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = '33333333-3333-4333-8333-333333333333';

const h = vi.hoisted(() => ({ setError: null as unknown }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({ id: OWNER, actor: { id: OWNER } })),
}));

vi.mock('@/lib/api-keys', () => ({
  listApiKeys: vi.fn(async () => []),
  setApiKey: vi.fn(async () => {
    if (h.setError) throw h.setError;
    return { id: 'k1', service: 'openrouter', label: 'default', createdAt: new Date(0) };
  }),
}));

vi.mock('@mantle/tools', () => ({ isMcpManagedSecretService: () => false }));

// A connector's marks on a replaced key: key-replace-voids-marks.db.test.ts.
vi.mock('@/lib/mcp-connectors', () => ({ afterVaultKeyReplaced: vi.fn(async () => {}) }));

/** The shape drizzle 0.45 throws (pinned by packages/db/src/pg-error.db.test.ts). */
function drizzleError(code: string, constraint?: string): Error {
  return Object.assign(
    new Error('Failed query: insert into "api_keys" (...) values (...)\nparams: ...'),
    { cause: { code, constraint_name: constraint } },
  );
}

function post(): Request {
  return new Request('http://localhost/api/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ service: 'openrouter', label: 'default', plaintext: 'sk-test' }),
  });
}

describe('POST /api/keys', () => {
  beforeEach(() => {
    h.setError = null;
  });

  it('creates a key', async () => {
    const { POST } = await import('./route');
    const res = await POST(post());
    expect(res.status).toBe(200);
  });

  it('answers 409 when the service and label are taken', async () => {
    h.setError = drizzleError('23505', 'api_keys_user_service_label_uq');
    const { POST } = await import('./route');
    const res = await POST(post());
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/Rotate it instead/);
  });

  it('still answers 500 for any other database error', async () => {
    h.setError = drizzleError('23503');
    const { POST } = await import('./route');
    const res = await POST(post());
    expect(res.status).toBe(500);
  });
});
