/**
 * POST /api/keys over the vault's write gateway, without a database: the
 * older body (service, label, plaintext) and the newer (name, kind, value)
 * reach the gateway as one name, a name taken at the same moment answers
 * 409 (the gateway's ConflictError), any other error is the app's opaque
 * 500, and the reply never carries the value.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictError } from '@mantle/std';

const OWNER = '33333333-3333-4333-8333-333333333333';

const h = vi.hoisted(() => ({ setError: null as unknown, calls: [] as unknown[] }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // The route reads the caller the pipeline answers (A4 step 3b part 4).
  ownerCaller: vi.fn(() => ({
    id: OWNER,
    email: 'admin@example.invalid',
    actor: { id: OWNER, email: 'admin@example.invalid' },
  })),
}));

vi.mock('@/lib/api-keys', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listApiKeys: vi.fn(async () => []),
  setVaultKey: vi.fn(async (_who: unknown, _owner: string, input: { ref: { name?: string } }) => {
    h.calls.push(input);
    if (h.setError) throw h.setError;
    return {
      op: 'add',
      secretWritten: true,
      key: {
        id: 'k1',
        name: input.ref.name ?? 'openrouter',
        kind: 'token',
        service: 'openrouter',
        label: 'default',
        target: [],
        tags: [],
        needsApproval: false,
        viaTailnet: false,
        masked: '••••',
        anthropicWorkspaceId: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    };
  }),
}));

vi.mock('@mantle/tools', () => ({ isMcpManagedSecretService: () => false }));
vi.mock('@/lib/embedding-config', () => ({ retryProvidersAfterKeyChange: vi.fn(async () => {}) }));

// A connector's marks on a replaced key: key-replace-voids-marks.db.test.ts.
vi.mock('@/lib/mcp-connectors', () => ({ afterVaultKeyReplaced: vi.fn(async () => {}) }));

/** The handler's answer, or the app's to what it threw (app.onError,
 *  answerAppError: a ConflictError is 409 by its row, fix round 1, L7). */
async function answered(res: Promise<Response>): Promise<Response> {
  try {
    return await res;
  } catch (err) {
    const { answerAppError } = await import('@/server/app-error');
    return answerAppError(
      err as Error,
      { req: { url: 'http://localhost/api/keys', method: 'POST' } } as never,
    );
  }
}

const SECRET = 'test-not-a-key-value';

function post(body: unknown = { service: 'openrouter', label: 'default', plaintext: SECRET }) {
  return new Request('http://localhost/api/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/keys', () => {
  beforeEach(() => {
    h.setError = null;
    h.calls = [];
  });

  it('creates a key; the older body is the name service/label', async () => {
    const { POST } = await import('./route');
    const res = await POST(post());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(h.calls[0]).toMatchObject({
      ref: { service: 'openrouter', label: 'default' },
      addKind: 'token',
      value: SECRET,
    });
  });

  it('takes the newer body: name, kind, value, target, tags', async () => {
    const { POST } = await import('./route');
    const res = await POST(
      post({
        name: 'printer-07',
        kind: 'login',
        value: SECRET,
        user: 'pi',
        target: ['printer-07.lan'],
        tags: ['printers'],
      }),
    );
    expect(res.status).toBe(200);
    expect(h.calls[0]).toMatchObject({
      ref: { name: 'printer-07' },
      kind: 'login',
      value: SECRET,
      user: 'pi',
      target: ['printer-07.lan'],
      tags: ['printers'],
    });
  });

  it('refuses a body with both forms of the name, or the secret twice', async () => {
    const { POST } = await import('./route');
    expect((await POST(post({ name: 'a', service: 'a', value: 'x' }))).status).toBe(400);
    expect((await POST(post({ name: 'a', value: 'x', plaintext: 'y' }))).status).toBe(400);
    expect(h.calls).toEqual([]);
  });

  it('answers 409 when the name was taken at the same moment', async () => {
    h.setError = new ConflictError('A key named openrouter was saved at the same moment.');
    const { POST } = await import('./route');
    const res = await answered(POST(post()));
    expect(res.status).toBe(409);
  });

  it('throws any other error, for the app to answer the opaque 500', async () => {
    const err = new Error('boom');
    h.setError = err;
    const { POST } = await import('./route');
    await expect(POST(post())).rejects.toBe(err);
  });
});
