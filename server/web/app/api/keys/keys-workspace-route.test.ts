/**
 * The Anthropic workspace id on the keys routes, without a database: GET
 * says the brain stores it (`features`), POST passes it to the vault's
 * write gateway only when sent, and PATCH sets or clears it on an existing
 * key (with the target, tags and switches PATCH also carries). A credential
 * change (POST, PATCH of the workspace id, rotate) sends the "Try again"
 * nudge (A10 lows). The gateway's own rules (anthropic only, the shape) are
 * pinned in packages/api-keys/src/anthropic-workspace.db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InputError } from '@mantle/std';

const OWNER = '33333333-3333-4333-8333-333333333333';
const KEY_ID = '11111111-1111-4111-8111-111111111111';

const h = vi.hoisted(() => ({
  set: vi.fn(),
  retry: vi.fn(async () => {}),
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ownerCaller: vi.fn(() => ({ id: OWNER, actor: { id: OWNER, email: 'a@example.invalid' } })),
}));

vi.mock('@/lib/api-keys', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listApiKeys: vi.fn(async () => [
    { id: KEY_ID, service: 'anthropic', label: 'default', anthropicWorkspaceId: 'wrkspc_a' },
  ]),
  setVaultKey: h.set,
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

type SetArgs = [unknown, string, { ref: { id?: string; name?: string } } & Record<string, unknown>];

function keyOf(service: string, input: Record<string, unknown>) {
  return {
    id: KEY_ID,
    name: service,
    kind: 'token',
    service,
    label: 'default',
    target: [],
    tags: [],
    needsApproval: false,
    viaTailnet: false,
    masked: '••••',
    anthropicWorkspaceId:
      typeof input.anthropicWorkspaceId === 'string' && input.anthropicWorkspaceId.trim()
        ? input.anthropicWorkspaceId.trim()
        : null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

beforeEach(() => {
  h.set.mockReset();
  h.retry.mockClear();
  h.set.mockImplementation(async (...[, , input]: SetArgs) => {
    const service = input.ref.name ? input.ref.name.split('/')[0]! : 'anthropic';
    return { op: 'add', secretWritten: input.value !== undefined, key: keyOf(service, input) };
  });
});

describe('GET /api/keys', () => {
  it('lists the workspace id and says the brain stores it', async () => {
    const { GET } = await import('./route');
    const body = (await (await GET()).json()) as {
      keys: Array<{ anthropicWorkspaceId: string | null }>;
      features?: { anthropicWorkspaceId?: boolean; vaultKinds?: string[] };
    };
    expect(body.keys[0]!.anthropicWorkspaceId).toBe('wrkspc_a');
    expect(body.features?.anthropicWorkspaceId).toBe(true);
    expect(body.features?.vaultKinds).toEqual(['token', 'password', 'ssh_key', 'login']);
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
    expect(h.set.mock.calls[0]![2]).toMatchObject({ anthropicWorkspaceId: 'wrkspc_b' });
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
    expect(h.set.mock.calls[1]![2]).not.toHaveProperty('anthropicWorkspaceId');
  });
});

describe('PATCH /api/keys/:id', () => {
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

  it('sets and clears the workspace id', async () => {
    const { PATCH } = await import('./[id]/route');
    const set = await PATCH(
      json(`http://localhost/api/keys/${KEY_ID}`, 'PATCH', { anthropicWorkspaceId: 'wrkspc_c' }),
      ctx(KEY_ID),
    );
    expect(set.status).toBe(200);
    expect(h.set.mock.calls[0]![1]).toBe(OWNER);
    expect(h.set.mock.calls[0]![2]).toEqual({
      ref: { id: KEY_ID },
      anthropicWorkspaceId: 'wrkspc_c',
    });
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

  it('carries target, tags and the switches, and sends no nudge for them', async () => {
    const { PATCH } = await import('./[id]/route');
    const res = await PATCH(
      json(`http://localhost/api/keys/${KEY_ID}`, 'PATCH', {
        target: ['printer-07.lan'],
        tags: ['printers'],
        needsApproval: false,
        viaTailnet: true,
      }),
      ctx(KEY_ID),
    );
    expect(res.status).toBe(200);
    expect(h.set.mock.calls[0]![2]).toEqual({
      ref: { id: KEY_ID },
      target: ['printer-07.lan'],
      tags: ['printers'],
      needsApproval: false,
      viaTailnet: true,
    });
    expect(h.retry).not.toHaveBeenCalled();
  });

  it('answers 400 for a bad body or id, 404 for no such key, and lets the gateway refuse', async () => {
    const { PATCH } = await import('./[id]/route');
    expect((await PATCH(json('http://x', 'PATCH', {}), ctx(KEY_ID))).status).toBe(400);
    expect(
      (await PATCH(json('http://x', 'PATCH', { anthropicWorkspaceId: 'w' }), ctx('nope'))).status,
    ).toBe(400);
    h.set.mockResolvedValueOnce(null);
    expect(
      (await PATCH(json('http://x', 'PATCH', { anthropicWorkspaceId: 'w' }), ctx(KEY_ID))).status,
    ).toBe(404);
    const refusal = new InputError('Only an Anthropic key can carry a workspace id.');
    h.set.mockRejectedValueOnce(refusal);
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
    h.set.mockResolvedValueOnce({
      op: 'replace',
      secretWritten: true,
      key: keyOf('openai', {}),
    });
    const ok = await POST(json('http://x', 'POST', { plaintext: 'test-not-a-key' }), ctx);
    expect(ok.status).toBe(200);
    expect(h.set.mock.calls[0]![2]).toEqual({ ref: { id: KEY_ID }, value: 'test-not-a-key' });
    expect(h.retry).toHaveBeenCalledTimes(1);
    expect(h.retry).toHaveBeenCalledWith(OWNER, 'openai');
    h.set.mockResolvedValueOnce(null);
    const missing = await POST(json('http://x', 'POST', { plaintext: 'test-not-a-key' }), ctx);
    expect(missing.status).toBe(404);
    expect(h.retry).toHaveBeenCalledTimes(1);
  });
});
