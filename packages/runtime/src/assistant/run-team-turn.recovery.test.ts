/**
 * Audit F31: the member's thread window is read before the inbound message is
 * written, outside any durable step. A turn RECOVERED after that step (DBOS
 * replays the step from its journal) finds its own inbound row already in the
 * thread, so the message reached the model twice: once as history, once as
 * the new message. The window must leave this turn's inbound row out.
 *
 * Everything around the prompt build is stubbed; the build is where the test
 * stops, holding the history the model would have seen.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  built: null as null | { history: { role: string; text: string }[]; newUserText: string },
}));

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const agent = {
    id: 'agent-1',
    slug: 'team-responder',
    audience: 'team',
    enabled: true,
    apiKeyId: 'key-1',
    provider: 'openrouter',
    model: 'test/model',
    memoryConfig: { history_limit: 20 },
  };
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit']) chain[m] = () => chain;
  chain['then'] = (resolve: (v: unknown[]) => void) => resolve([agent]);
  return { ...actual, db: { select: () => chain } };
});
vi.mock('@mantle/api-keys', () => ({ getApiKeyById: vi.fn(async () => ({ id: 'key-1' })) }));
vi.mock('../agent/agent-viewer', () => ({
  agentLevel: () => 'team',
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
  buildChatMessages: vi.fn((args: typeof h.built) => {
    h.built = args;
    throw new Error('stop after the prompt build');
  }),
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
  recentTeamMessages: vi.fn(async () => [
    row('in-1', 'inbound', 'first question'),
    row('out-1', 'outbound', 'first answer'),
    row('in-2', 'inbound', 'second question'),
  ]),
  // The journal replays the inbound step: the same row comes back.
  appendTeamMessage: vi.fn(async (r: { direction: string }) =>
    r.direction === 'inbound'
      ? row('in-2', 'inbound', 'second question')
      : { id: 'out-2', direction: 'outbound', text: '', status: 'pending' },
  ),
}));
vi.mock('@mantle/tracing', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runDurableStep: (_name: string, fn: () => Promise<unknown>) => fn(),
  emitTurnLifecycle: vi.fn(),
}));

import { historyBeforeInbound, runTeamTurn } from './run-team-turn';

beforeEach(() => {
  h.built = null;
});

describe('runTeamTurn: a recovered turn', () => {
  it('sends the member message once, not also as history', async () => {
    await expect(
      runTeamTurn('owner-1', 'second question', { loginId: 'login-1', channel: 'web' }),
    ).rejects.toThrow(/stop after the prompt build/);
    expect(h.built?.newUserText).toBe('second question');
    expect(h.built?.history).toEqual([
      { role: 'user', text: 'first question' },
      { role: 'assistant', text: 'first answer' },
    ]);
  });

  it('historyBeforeInbound drops only the inbound row', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(historyBeforeInbound(rows, 'b')).toEqual([{ id: 'a' }, { id: 'c' }]);
    expect(historyBeforeInbound(rows, 'z')).toEqual(rows);
  });
});
