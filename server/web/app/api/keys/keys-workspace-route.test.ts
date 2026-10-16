/**
 * The Anthropic workspace id on the keys routes, without a database: GET
 * says the brain stores it (`features`), POST passes it to the store only
 * when sent, and PATCH sets or clears it on an existing key. A credential
 * change (POST, PATCH, rotate) sends the "Try again" nudge (A10 lows). The store's own
 * rules (anthropic only, the shape) are pinned in
 * packages/api-keys/src/anthropic-workspace.db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InputError } from '@mantle/std';

const OWNER = '33333333-3333-4333-8333-333333333333';
const KEY_ID = '11111111-1111-4111-8111-111111111111';

const h = vi.hoisted(() => ({
  setApiKey: vi.fn(),
  setWorkspace: vi.fn(),
  rotate: vi.fn(),
  retry: vi.fn(async () => {}),
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ownerCaller: vi.fn(() => ({ id: OWNER, actor: { id: OWNER } })),
}));

vi.mock('@/lib/api-keys', () => ({
  listApiKeys: vi.fn(async () => [
    { id: KEY_ID, service: 'anthropic', label: 'default', anthropicWorkspaceId: 'wrkspc_a' },
  ]),
  setApiKey: h.setApiKey,
  setApiKeyAnthropicWorkspace: h.setWorkspace,
  rotateApiKey: h.rotate,
  deleteApiKey: vi.fn(),
}));

// The "Try again" nudge a credential change sends (A10 lows item 6).
vi.mock('@/lib/embedding-config', () => ({ retryProvidersAfterKeyChange: h.retry }));

vi.mock('@mantle/tools', () => ({ isMcpManagedSecretService: () => false }));
vi.mock('@/lib/mcp-connectors', () => ({ afterVaultKeyReplaced: vi.fn(async () => {}) }));

const json = (url: string, method: string, body: unknown) =>
  new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  h.setApiKey.mockReset();
  h.setWorkspace.mockReset();
  h.rotate.mockReset();
  h.retry.mockClear();
  h.setApiKey.mockImplementation(async (_o, service, label, _p, opts) => ({
    id: KEY_ID,
    service,
    label,
    anthropicWorkspaceId: opts?.anthropicWorkspaceId ?? null,
    createdAt: new Date(0),
  }));
});

describe('GET /api/keys', () => {
  it('lists the workspace id and says the brain stores it', async () => {
    const { GET } = await import('./route');
    const body = (await (await GET()).json()) as {
      keys: Array<{ anthropicWorkspaceId: string | null }>;
      features?: { anthropicWorkspaceId?: boolean };
    };
    expect(body.keys[0]!.anthropicWorkspaceId).toBe('wrkspc_a');
    expect(body.features?.anthropicWorkspaceId).toBe(true);
  });
});

describe('POST /api/keys', () => {
  it('passes the workspace id when sent, and nothing when not (an older UI)', async () => {
    const { POST } = await import('./route');
    const withWs = await POST(
      json('http://localhost/api/keys', 'POST', {
        service: 'anthropic',
        label: 'default',
        plaintext: 'test-not-a-key',
        anthropicWorkspaceId: 'wrkspc_b',
      }),
    );
    expect(withWs.status).toBe(200);
    expect(h.setApiKey.mock.calls[0]![4]).toEqual({ anthropicWorkspaceId: 'wrkspc_b' });
    expect(((await withWs.json()) as { anthropicWorkspaceId: string }).anthropicWorkspaceId).toBe(
      'wrkspc_b',
    );

    await POST(
      json('http://localhost/api/keys', 'POST', {
        service: 'openrouter',
        label: 'default',
        plaintext: 'test-not-a-key',
      }),
    );
    expect(h.setApiKey.mock.calls[1]![4]).toEqual({});
  });
});

describe('PATCH /api/keys/:id', () => {
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

  it('sets and clears the workspace id', async () => {
    h.setWorkspace.mockImplementation(async (_o, id, v) => ({
      id,
      anthropicWorkspaceId: v && v.trim() ? v.trim() : null,
      updatedAt: new Date(0),
    }));
    const { PATCH } = await import('./[id]/route');
    const set = await PATCH(
      json(`http://localhost/api/keys/${KEY_ID}`, 'PATCH', { anthropicWorkspaceId: 'wrkspc_c' }),
      ctx(KEY_ID),
    );
    expect(set.status).toBe(200);
    expect(h.setWorkspace).toHaveBeenCalledWith(OWNER, KEY_ID, 'wrkspc_c');
    const clear = await PATCH(
      json(`http://localhost/api/keys/${KEY_ID}`, 'PATCH', { anthropicWorkspaceId: null }),
      ctx(KEY_ID),
    );
    expect(
      ((await clear.json()) as { anthropicWorkspaceId: null }).anthropicWorkspaceId,
    ).toBeNull();
    // Each change asks the open provider alerts to probe now (A10 lows).
    expect(h.retry).toHaveBeenCalledTimes(2);
    expect(h.retry).toHaveBeenCalledWith(OWNER, 'anthropic');
  });

  it('answers 400 for a bad body or id, 404 for no such key, and lets the store refuse', async () => {
    const { PATCH } = await import('./[id]/route');
    expect((await PATCH(json('http://x', 'PATCH', {}), ctx(KEY_ID))).status).toBe(400);
    expect(
      (await PATCH(json('http://x', 'PATCH', { anthropicWorkspaceId: 'w' }), ctx('nope'))).status,
    ).toBe(400);
    h.setWorkspace.mockResolvedValueOnce(null);
    expect(
      (await PATCH(json('http://x', 'PATCH', { anthropicWorkspaceId: 'w' }), ctx(KEY_ID))).status,
    ).toBe(404);
    const refusal = new InputError('Only an Anthropic key can carry a workspace id.');
    h.setWorkspace.mockRejectedValueOnce(refusal);
    await expect(
      PATCH(json('http://x', 'PATCH', { anthropicWorkspaceId: 'w' }), ctx(KEY_ID)),
    ).rejects.toBe(refusal);
    // No change, no nudge.
    expect(h.retry).not.toHaveBeenCalled();
  });
});

describe('a key credential change nudges the provider alerts (A10 lows item 6)', () => {
  it('a POST that sets a key nudges once', async () => {
    const { POST } = await import('./route');
    await POST(
      json('http://localhost/api/keys', 'POST', {
        service: 'openai',
        label: 'default',
        plaintext: 'test-not-a-key',
      }),
    );
    expect(h.retry).toHaveBeenCalledTimes(1);
    // With the key's service: the helper itself skips a service that is no
    // model provider (embedding-config-retry.test.ts).
    expect(h.retry).toHaveBeenCalledWith(OWNER, 'openai');
  });

  it('a rotate nudges once; a key that is not there does not', async () => {
    const { POST } = await import('./[id]/rotate/route');
    const ctx = { params: Promise.resolve({ id: KEY_ID }) };
    h.rotate.mockResolvedValueOnce({
      id: KEY_ID,
      service: 'openai',
      label: 'default',
      updatedAt: new Date(0),
    });
    const ok = await POST(json('http://x', 'POST', { plaintext: 'test-not-a-key' }), ctx);
    expect(ok.status).toBe(200);
    expect(h.retry).toHaveBeenCalledTimes(1);
    expect(h.retry).toHaveBeenCalledWith(OWNER, 'openai');
    h.rotate.mockResolvedValueOnce(null);
    const missing = await POST(json('http://x', 'POST', { plaintext: 'test-not-a-key' }), ctx);
    expect(missing.status).toBe(404);
    expect(h.retry).toHaveBeenCalledTimes(1);
  });
});
