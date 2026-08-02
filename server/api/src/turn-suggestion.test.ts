/**
 * Unit tests for the follow-up suggester (./turn-suggestion.ts): the guard
 * ladder that keeps the per-turn LLM spend opt-in, the worker fallback order
 * (suggester → narrator → summarizer), prompt/knob honouring, and the
 * never-throws contract. Mock style follows extractor-chat.test.ts
 * (module-boundary vi.mock; no DB-backed test convention in this repo).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnSuggestionContext } from '@mantle/assistant-runtime';

const h = vi.hoisted(() => ({
  getDefaultWorker: vi.fn(),
  resolveChatKey: vi.fn(),
  resolveChatRoutes: vi.fn(),
  chatWithFailover: vi.fn(),
  installedHook: null as null | ((ctx: unknown) => void),
  /** Captured db.update(...).set(...) payloads, in order. */
  dbSets: [] as unknown[],
}));

vi.mock('@mantle/db', () => ({
  getDefaultWorker: h.getDefaultWorker,
  // The sql`` tag only needs SOMETHING to interpolate; never serialized here.
  assistantMessages: { id: 'col:id', ownerId: 'col:owner_id', data: 'col:data' },
  db: {
    update: () => ({
      set: (v: unknown) => {
        h.dbSets.push(v);
        return { where: () => Promise.resolve([]) };
      },
    }),
  },
}));
vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (...args: unknown[]) => ({ eq: args }),
  sql: (strings: TemplateStringsArray, ...vals: unknown[]) => ({ strings, vals }),
}));
vi.mock('@mantle/agent-runtime', () => ({
  resolveChatKey: h.resolveChatKey,
  resolveChatRoutes: h.resolveChatRoutes,
  chatWithFailover: h.chatWithFailover,
}));
vi.mock('@mantle/assistant-runtime', () => ({
  setTurnSuggestionHook: (fn: (ctx: unknown) => void) => {
    h.installedHook = fn;
  },
}));

import { installTurnSuggestionHook, suggestFollowUp } from './turn-suggestion';

const substantiveReply =
  'Here is a full explanation of how the embedder is configured, with the singleton ' +
  'embedding_config row, the 768-dimension lock, and what a re-embed would involve. '.repeat(3);

function ctx(overrides: Partial<TurnSuggestionContext> = {}): TurnSuggestionContext {
  return {
    ownerId: 'owner-1',
    agent: { params: { suggest_follow_up: true } } as TurnSuggestionContext['agent'],
    outboundId: 'out-1',
    userText: 'How is the embedder configured for my brain?',
    replyText: substantiveReply,
    stopped: false,
    ...overrides,
  };
}

const suggesterWorker = { kind: 'suggester', params: {}, systemPrompt: null };

beforeEach(() => {
  vi.clearAllMocks();
  h.dbSets.length = 0;
  h.getDefaultWorker.mockResolvedValue(suggesterWorker);
  h.resolveChatKey.mockResolvedValue({ ok: true });
  h.resolveChatRoutes.mockReturnValue([{ provider: 'openrouter' }]);
  h.chatWithFailover.mockResolvedValue({ result: { text: 'What would a re-embed cost?' } });
  delete process.env.MANTLE_TURN_SUGGESTIONS;
});
afterEach(() => {
  delete process.env.MANTLE_TURN_SUGGESTIONS;
});

describe('suggestFollowUp guards (all cheaper than the LLM call)', () => {
  it('toggle off (absent) → no worker lookup, no LLM call, null', async () => {
    const r = await suggestFollowUp(
      ctx({ agent: { params: {} } as TurnSuggestionContext['agent'] }),
    );
    expect(r).toBeNull();
    expect(h.getDefaultWorker).not.toHaveBeenCalled();
    expect(h.chatWithFailover).not.toHaveBeenCalled();
  });

  it('toggle must be exactly true, not merely truthy-shaped data', async () => {
    const agent = {
      params: { suggest_follow_up: 'yes' },
    } as unknown as TurnSuggestionContext['agent'];
    expect(await suggestFollowUp(ctx({ agent }))).toBeNull();
    expect(h.chatWithFailover).not.toHaveBeenCalled();
  });

  it('a user-stopped turn is never decorated', async () => {
    expect(await suggestFollowUp(ctx({ stopped: true }))).toBeNull();
    expect(h.chatWithFailover).not.toHaveBeenCalled();
  });

  it('short replies (one-liners) are not worth a suggestion', async () => {
    expect(await suggestFollowUp(ctx({ replyText: 'Done!' }))).toBeNull();
    expect(h.chatWithFailover).not.toHaveBeenCalled();
  });

  it('trivial user text ("ok") signals a closing beat, not a thread', async () => {
    expect(await suggestFollowUp(ctx({ userText: 'ok' }))).toBeNull();
    expect(h.chatWithFailover).not.toHaveBeenCalled();
  });

  it('MANTLE_TURN_SUGGESTIONS=0 kills it fleet-wide before any other check', async () => {
    process.env.MANTLE_TURN_SUGGESTIONS = '0';
    expect(await suggestFollowUp(ctx())).toBeNull();
    expect(h.getDefaultWorker).not.toHaveBeenCalled();
  });
});

describe('worker resolution', () => {
  it('falls back suggester → narrator → summarizer, in that order', async () => {
    h.getDefaultWorker.mockImplementation(async (_owner: string, kind: string) =>
      kind === 'summarizer'
        ? { kind: 'summarizer', params: {}, systemPrompt: 'digest prompt' }
        : null,
    );
    const r = await suggestFollowUp(ctx());
    expect(r).toBe('What would a re-embed cost?');
    expect(h.getDefaultWorker.mock.calls.map((c) => c[1])).toEqual([
      'suggester',
      'narrator',
      'summarizer',
    ]);
  });

  it('no worker of any kind → null without an LLM call', async () => {
    h.getDefaultWorker.mockResolvedValue(null);
    expect(await suggestFollowUp(ctx())).toBeNull();
    expect(h.chatWithFailover).not.toHaveBeenCalled();
  });

  it('a fallback worker keeps the BUILT-IN prompt (its own prompt tunes another job)', async () => {
    h.getDefaultWorker.mockImplementation(async (_owner: string, kind: string) =>
      kind === 'narrator' ? { kind: 'narrator', params: {}, systemPrompt: 'narrate warmly' } : null,
    );
    await suggestFollowUp(ctx());
    const call = h.chatWithFailover.mock.calls[0]![2];
    expect(call.messages[0].content).not.toBe('narrate warmly');
    expect(call.messages[0].content).toContain('ONE short follow-up question');
  });

  it('a dedicated suggester worker gets its own prompt + knobs honoured', async () => {
    h.getDefaultWorker.mockResolvedValue({
      kind: 'suggester',
      params: { temperature: 0.2, max_tokens: 24 },
      systemPrompt: 'Ask about deadlines.',
    });
    await suggestFollowUp(ctx());
    const call = h.chatWithFailover.mock.calls[0]![2];
    expect(call.messages[0].content).toBe('Ask about deadlines.');
    expect(call.temperature).toBe(0.2);
    expect(call.maxTokens).toBe(24);
  });

  it('missing chat key → null without an LLM call', async () => {
    h.resolveChatKey.mockResolvedValue({ ok: false });
    expect(await suggestFollowUp(ctx())).toBeNull();
    expect(h.chatWithFailover).not.toHaveBeenCalled();
  });
});

describe('output handling + persistence', () => {
  it('tidies wrapping quotes/bullets and persists onto the outbound row', async () => {
    h.chatWithFailover.mockResolvedValue({ result: { text: '  "What about  backups?"  ' } });
    const r = await suggestFollowUp(ctx());
    expect(r).toBe('What about backups?');
    expect(h.dbSets).toHaveLength(1);
    const patch = JSON.stringify(h.dbSets[0]);
    expect(patch).toContain('What about backups?');
    expect(patch).toContain('suggestedAt');
  });

  it('empty model output → null, nothing persisted', async () => {
    h.chatWithFailover.mockResolvedValue({ result: { text: '   ' } });
    expect(await suggestFollowUp(ctx())).toBeNull();
    expect(h.dbSets).toHaveLength(0);
  });

  it('a runaway "question" (way past the cap) is dropped, not truncated', async () => {
    h.chatWithFailover.mockResolvedValue({ result: { text: 'why? '.repeat(100) } });
    expect(await suggestFollowUp(ctx())).toBeNull();
    expect(h.dbSets).toHaveLength(0);
  });

  it('never throws: an LLM failure resolves null', async () => {
    h.chatWithFailover.mockRejectedValue(new Error('provider down'));
    await expect(suggestFollowUp(ctx())).resolves.toBeNull();
  });
});

describe('installTurnSuggestionHook', () => {
  it('registers a synchronous, non-awaiting, non-throwing hook', () => {
    installTurnSuggestionHook();
    expect(h.installedHook).toBeTypeOf('function');
    // Even a context that fails guards must not throw through the hook.
    expect(() => h.installedHook!(ctx({ stopped: true }))).not.toThrow();
  });
});
