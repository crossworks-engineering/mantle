/**
 * A workspace id in any shape but ASCII letters, digits, `_` and `-` is an
 * InputError, a 400 with a fixed sentence, on every keys route that takes
 * one, before any database work: never a 500, and never a value that would
 * reach a request header and make fetch throw a TypeError. The real key
 * store's check runs here (no database: the check comes first).
 */
import { describe, expect, it, vi } from 'vitest';
import { domainErrorAnswer, InputError } from '@mantle/std';
import { anthropicHeaders } from '@mantle/voice';
import { normalizeAnthropicWorkspaceId } from '@mantle/voice/client';

const OWNER = '33333333-3333-4333-8333-333333333333';
const KEY_ID = '11111111-1111-4111-8111-111111111111';

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ownerCaller: vi.fn(() => ({ id: OWNER, actor: { id: OWNER } })),
}));
vi.mock('@mantle/tools', () => ({ isMcpManagedSecretService: () => false }));
vi.mock('@/lib/mcp-connectors', () => ({ afterVaultKeyReplaced: vi.fn(async () => {}) }));

const BAD = [
  'wrkspc_é', // a non-ASCII letter
  'wrkspc_é中', // beyond Latin-1
  'wrkspc_\u0085x', // a C1 control character
  'wrkspc_\u009fx', // another
  'wrkspc_\u0000x', // NUL
  'has space',
  'line\nbreak',
  'wrkspc.x',
  'x'.repeat(129),
];

const json = (method: string, body: unknown) =>
  new Request(`http://localhost/api/keys/${KEY_ID}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function answerOf(p: Promise<Response>): Promise<{ status: number; error?: string }> {
  try {
    const res = await p;
    return { status: res.status, ...((await res.json()) as { error?: string }) };
  } catch (err) {
    // What app.onError answers for a thrown error: a domain error by its
    // table, anything else the opaque 500.
    const domain = domainErrorAnswer(err);
    expect(err).toBeInstanceOf(InputError);
    return domain
      ? { status: domain.status, error: (domain.body as { error: string }).error }
      : { status: 500 };
  }
}

describe('a workspace id that is not ASCII letters, digits, _ or -', () => {
  it('PATCH /api/keys/:id answers 400 with the fixed sentence', async () => {
    const { PATCH } = await import('./[id]/route');
    for (const bad of BAD) {
      const a = await answerOf(
        PATCH(json('PATCH', { anthropicWorkspaceId: bad }), {
          params: Promise.resolve({ id: KEY_ID }),
        }),
      );
      expect(a.status, JSON.stringify(bad)).toBe(400);
      expect(a.error).toMatch(/workspace id/);
    }
  });

  it('POST /api/keys answers 400 with the fixed sentence', async () => {
    const { POST } = await import('./route');
    for (const bad of BAD) {
      const a = await answerOf(
        POST(
          new Request('http://localhost/api/keys', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              service: 'anthropic',
              label: 'default',
              plaintext: 'test-not-a-key',
              anthropicWorkspaceId: bad,
            }),
          }),
        ),
      );
      expect(a.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('every id the check accepts makes a header fetch takes', () => {
    for (const ok of ['wrkspc_01ABCdef', 'a', 'A-b_9', 'x'.repeat(128)]) {
      const n = normalizeAnthropicWorkspaceId(ok);
      expect(n.ok).toBe(true);
      const value = n.ok ? n.value! : '';
      expect(
        () => new Headers(anthropicHeaders({ apiKey: 'k', anthropicWorkspaceId: value })),
      ).not.toThrow();
    }
  });
});
