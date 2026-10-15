/**
 * A10 #10 fix round 2: recall_match and find_window embed the caller's text
 * before they search. When that embed fails at the provider, the tool text
 * (the model reads it) says the fixed sentence, never the provider's body;
 * the detail goes to the server log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderHttpError } from '@mantle/std';

const SECRET = 'sk-proj-0123456789abcdef org=acme-private';

vi.mock('@mantle/embeddings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  embed: vi.fn(async () => {
    throw new ProviderHttpError({
      provider: 'openai',
      status: 403,
      body: SECRET,
      what: 'embeddings',
    });
  }),
}));
vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'innerJoin', 'orderBy']) chain[m] = () => chain;
  chain['limit'] = async () => [];
  return { ...actual, db: { select: () => chain } };
});

const { RECALL_TOOLS } = await import('./builtins-recall');
const { REPLAY_TOOLS } = await import('./builtins-replay');

let logged: string[] = [];
beforeEach(() => {
  logged = [];
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    logged.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(' '));
  });
});
afterEach(() => vi.restoreAllMocks());

describe('an embed that fails at the provider (A10 #10 fix round 2)', () => {
  it('recall_match says the fixed sentence', async () => {
    const tool = RECALL_TOOLS.find((t) => t.slug === 'recall_match')!;
    const res = await tool.handler({ need: 'upload a document' }, {
      ownerId: 'owner-1',
      surface: { kind: 'web' },
    } as Parameters<typeof tool.handler>[1]);
    expect(res).toEqual({
      ok: false,
      error: 'embed failed: The provider refused the API key. (openai, HTTP 403)',
    });
    // A refused key is logged by provider and status only: its body can echo
    // the key (model picker fix round 1, L2).
    expect(logged.join('\n')).toContain('openai refused the key (HTTP 403)');
    expect(logged.join('\n')).not.toContain('acme-private');
  });

  it('find_window says the fixed sentence', async () => {
    const tool = REPLAY_TOOLS.find((t) => t.slug === 'find_window')!;
    const res = await tool.handler({ topic: 'the Romans 8 talk' }, {
      ownerId: 'owner-1',
      surface: { kind: 'owner', via: 'mcp' },
    } as unknown as Parameters<typeof tool.handler>[1]);
    expect(res).toEqual({
      ok: false,
      error: 'embed failed: The provider refused the API key. (openai, HTTP 403)',
    });
    expect(JSON.stringify(res)).not.toContain('sk-proj');
  });
});
