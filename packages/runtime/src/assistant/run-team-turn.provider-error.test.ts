/**
 * A10 #10 fix round 1: a provider's answer can carry an account id, an
 * organisation name or part of a key. When a member's turn fails on one, the
 * member's thread and the turn's stream event say the fixed sentence for its
 * class, never the provider's body (the detail is logged server side).
 *
 * Everything around the loop is stubbed; the loop throws the provider error.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderHttpError } from '@mantle/std';

const SECRET = 'sk-or-v1-0123456789abcdef org=acme-private';

const h = vi.hoisted(() => ({
  outcomes: [] as Record<string, unknown>[],
  events: [] as unknown[][],
  /** What the loop throws (default: a ProviderHttpError). */
  throws: null as (() => Error) | null,
}));
vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const agent = {
    id: 'agent-1',
    slug: 'team-responder',
    enabled: true,
    apiKeyId: 'key-1',
    provider: 'openrouter',
    model: 'test/model',
    memoryConfig: { history_limit: 20 },
  };
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'innerJoin', 'where', 'orderBy', 'limit']) chain[m] = () => chain;
  chain['then'] = (resolve: (v: unknown[]) => void) => resolve([agent]);
  // No "New chat" yet: the thread has no lower bound.
  return { ...actual, db: { select: () => chain }, openChatThread: async () => null };
});
vi.mock('@mantle/api-keys', () => ({ getApiKeyById: vi.fn(async () => ({ id: 'key-1' })) }));
vi.mock('../agent/agent-viewer', () => ({
  withAgentViewer: (_a: unknown, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../agent', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadConversationContext: vi.fn(async () => ({
    facts: [],
    contentHits: [],
    chunkHits: [],
    relations: [],
  })),
  buildChatMessages: vi.fn(() => []),
}));
vi.mock('./assemble-turn', () => ({
  assembleResponderTurn: vi.fn(async () => ({
    volatileContext: '',
    allowedTools: [],
    effectiveSystemPrompt: 'system',
  })),
}));
vi.mock('@mantle/voice', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getChatAdapter: () => ({}),
}));
const row = (id: string, direction: 'inbound' | 'outbound', text: string) => ({
  id,
  direction,
  text,
  status: 'complete',
  usedPrivate: false,
});
vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadProfilePreferences: vi.fn(async () => ({})),
  isTeamPrivateReadsEnabled: () => false,
  teamHiddenNodeTypes: () => [],
  // The recovered turn: its own inbound (in-2) was written before the crash.
  recentThreadMessages: vi.fn(async () => [
    row('in-1', 'inbound', 'first question'),
    row('out-1', 'outbound', 'first answer'),
    row('in-2', 'inbound', 'second question'),
  ]),
  updateThreadMessageOutcome: vi.fn(async (r: Record<string, unknown>) => {
    h.outcomes.push(r);
  }),
  appendThreadMessage: vi.fn(async (r: { direction: string }) =>
    r.direction === 'inbound'
      ? row('in-2', 'inbound', 'second question')
      : { id: 'out-2', direction: 'outbound', text: '', status: 'pending' },
  ),
}));
vi.mock('@mantle/tracing', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runDurableStep: (_name: string, fn: () => Promise<unknown>) => fn(),
  emitTurnLifecycle: vi.fn((...args: unknown[]) => {
    h.events.push(args);
  }),
  startTrace: (_opts: unknown, fn: () => Promise<unknown>) => fn(),
  withTracePrelude: (_p: unknown, fn: () => Promise<unknown>) => fn(),
  currentTrace: () => null,
  registerTurnAbort: () => new AbortController(),
  unregisterTurnAbort: () => {},
}));

vi.mock('./responder-loop', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runResponderLoop: vi.fn(async () => {
    if (h.throws) throw h.throws();
    throw new ProviderHttpError({
      provider: 'openrouter',
      status: 401,
      body: SECRET,
      what: 'chat',
    });
  }),
}));

import { runTeamTurn } from './run-team-turn';

beforeEach(() => {
  h.outcomes = [];
  h.events = [];
  h.throws = null;
});

describe('runTeamTurn: a provider error', () => {
  it('reaches the member thread and the stream as the fixed sentence only', async () => {
    const err = await runTeamTurn('owner-1', 'second question', {
      loginId: 'login-1',
      channel: 'web',
      streamId: 'stream-1',
    }).catch((e: unknown) => e);
    // The caller (the route, the logs) still gets the error itself.
    expect(err).toBeInstanceOf(ProviderHttpError);

    const failed = h.outcomes.find((o) => o.status === 'failed');
    expect(failed).toBeDefined();
    expect(String(failed!.error)).toBe('The provider refused the API key. (openrouter, HTTP 401)');
    expect(JSON.stringify(h.outcomes)).not.toContain('sk-or-v1');

    const errorEvents = h.events.filter((e) => e[2] === 'error');
    expect(errorEvents.length).toBeGreaterThan(0);
    expect(JSON.stringify(errorEvents)).not.toContain('sk-or-v1');
    expect(JSON.stringify(errorEvents)).not.toContain('acme-private');
  });

  // A10 #10 fix round 2: OpenRouter's 400 that is not about the model (and a
  // 403 moderation refusal, a 413) is a class the classifier does not name;
  // its message carries the upstream text and metadata.
  it('a provider failure the classifier does not name is the fixed sentence too', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.throws = () =>
      new Error(`openrouter-chat 400 on test/model: prompt too long metadata=${SECRET}`, {
        cause: Object.assign(new Error('Provider returned error'), {
          statusCode: 400,
          body: SECRET,
        }),
      });
    await runTeamTurn('owner-1', 'second question', {
      loginId: 'login-1',
      channel: 'web',
      streamId: 'stream-1',
    }).catch(() => {});
    log.mockRestore();
    const failed = h.outcomes.find((o) => o.status === 'failed');
    // A10 lows item 2: a 400 says the arguments are bad, still no body.
    expect(String(failed!.error)).toBe(
      'The provider rejected the request as invalid. Check the arguments (names, types, sizes) and try again. (HTTP 400)',
    );
    expect(JSON.stringify(h.outcomes)).not.toContain('acme-private');
    const errorEvents = h.events.filter((e) => e[2] === 'error');
    expect(errorEvents.length).toBeGreaterThan(0);
    expect(JSON.stringify(errorEvents)).not.toContain('acme-private');
  });
});
