/**
 * Unit tests for the simulated responder turn (respond_as_agent's engine). Pins
 * the CONTRACT that makes the MCP tool safe and useful:
 *   (a) it writes NOTHING — recordTurn / updateAssistantMessageOutcome are never
 *       touched (the whole point vs a real turn);
 *   (b) the prompt's conversation history is the CALLER-supplied `history`, not
 *       the agent's stored assistant_messages window;
 *   (c) excludeToolSlugs is threaded to the assembly and the narrowed tool list
 *       reaches the loop;
 *   (d) maxIterations is clamped and applied; the trace id is captured; the
 *       missing-agent / missing-key errors match the real turn.
 *
 * The three collaborators (agent resolution, prompt assembly, the loop) are
 * mocked so this pins run-sim-turn's ORCHESTRATION, not their internals (which
 * have their own tests). The MCP wrapper's own input caps are tested in
 * mcp-core (build-server.test.ts).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '@mantle/db';

const h = vi.hoisted(() => ({
  agent: null as unknown,
  apiKey: 'sk-test' as string | null,
  builtMessages: null as unknown,
  loopOpts: null as any,
  assembleOpts: null as any,
  outcome: null as any,
  recordTurn: vi.fn(),
  updateOutcome: vi.fn(),
  // A stored-history window that DIFFERS from the caller's history, so a test
  // can prove the built prompt used the caller's, not the store's.
  storedHistory: [{ role: 'user' as const, text: 'STORED — must not appear' }],
}));

vi.mock('./run-turn', () => ({
  resolveAssistantAgent: vi.fn(async () => h.agent),
}));

vi.mock('@mantle/api-keys', () => ({
  getApiKeyById: vi.fn(async () => h.apiKey),
}));

vi.mock('@mantle/voice', () => ({
  getChatAdapter: vi.fn(() => ({ providerId: 'openrouter', adapterName: 'stub' })),
}));

vi.mock('@mantle/content', () => ({
  loadProfilePreferences: vi.fn(async () => ({ timezone: 'UTC', locale: 'en-GB' })),
}));

vi.mock('@mantle/tracing', () => ({
  // Run the body inline; the sim captures the trace id via currentTrace().
  startTrace: vi.fn(async (_init: unknown, fn: () => Promise<unknown>) => fn()),
  currentTrace: vi.fn(() => ({ id: 'trace-abc' })),
}));

vi.mock('@mantle/agent-runtime', () => ({
  loadConversationContext: vi.fn(async () => ({
    personaNotes: [],
    facts: [],
    digests: [],
    corpusMap: { entries: [] },
    contentHits: [],
    chunkHits: [],
    relations: [],
    history: h.storedHistory,
    snapshot: {},
  })),
  // Echo the two fields the tests care about so the built prompt is inspectable.
  buildChatMessages: vi.fn((args: { history: unknown; newUserText: string }) => [
    { role: 'system', content: 'S' },
    {
      role: 'user',
      content: JSON.stringify({ history: args.history, newUserText: args.newUserText }),
    },
  ]),
  // The persistence writers — must never be called by the sim.
  recordTurn: h.recordTurn,
  updateAssistantMessageOutcome: h.updateOutcome,
}));

vi.mock('./assemble-turn', () => ({
  // Apply excludeToolSlugs to a base tool list so exclusion is observable end
  // to end, and echo maxIterations back through loopOverrides.
  assembleResponderTurn: vi.fn(async (opts: { excludeToolSlugs?: string[] }) => {
    h.assembleOpts = opts;
    const base = [{ slug: 'search_nodes' }, { slug: 'email_send' }, { slug: 'note_create' }];
    const gated = new Set(opts.excludeToolSlugs ?? []);
    return {
      attachedSkills: [],
      effectiveSystemPrompt: 'SYSTEM',
      volatileContext: 'TIME',
      relatedHeartbeatSlugs: [],
      allowedTools: base.filter((t) => !gated.has(t.slug)),
      thinkingBudget: 1024,
      delegateTo: [],
      resultHandling: null,
      loopOverrides: { maxToolCallsPerTurn: 40 },
    };
  }),
}));

vi.mock('./responder-loop', () => ({
  runResponderLoop: vi.fn(async (opts: any) => {
    h.loopOpts = opts;
    // Build the prompt exactly as the real loop would, so the test sees which
    // history the sim fed in.
    h.builtMessages = await opts.buildMessages({ ...(await opts.loadContext()) });
    return h.outcome;
  }),
}));

import { runSimulatedResponderTurn } from './run-sim-turn';

const AGENT = {
  id: 'agent-1',
  slug: 'saskia',
  model: 'anthropic/claude-sonnet-4.5',
  provider: 'openrouter',
  apiKeyId: 'key-1',
} as unknown as Agent;

beforeEach(() => {
  h.agent = AGENT;
  h.apiKey = 'sk-test';
  h.builtMessages = null;
  h.loopOpts = null;
  h.assembleOpts = null;
  h.outcome = {
    loop: {
      reply: 'hi there!',
      toolCalls: [{ slug: 'note_create', argsJson: '{"title":"x"}', durationMs: 5, status: 'ok' }],
      pendingIds: ['pending-9'],
      artifacts: [],
      tokensOut: 7,
    },
    reply: 'hi there!',
    emptyReplySubstituted: false,
    persistedThoughts: [],
    toolStats: { calls: 1, succeeded: 1, failed: 0, skipped: 0, queued: 0, failures: [] },
    ctx: {},
  };
  h.recordTurn.mockClear();
  h.updateOutcome.mockClear();
});

describe('runSimulatedResponderTurn', () => {
  it('(a) writes NOTHING — no recordTurn / updateAssistantMessageOutcome', async () => {
    const res = await runSimulatedResponderTurn('owner-1', { message: 'hello' });
    expect(h.recordTurn).not.toHaveBeenCalled();
    expect(h.updateOutcome).not.toHaveBeenCalled();
    // And it still returns a coherent result.
    expect(res.reply).toBe('hi there!');
    expect(res.agent).toEqual({ slug: 'saskia', model: 'anthropic/claude-sonnet-4.5' });
    expect(res.pendingIds).toEqual(['pending-9']);
    expect(res.traceId).toBe('trace-abc');
    expect(res.toolStats).toMatchObject({ calls: 1 });
  });

  it('(b) builds the prompt from CALLER history, not the stored window', async () => {
    await runSimulatedResponderTurn('owner-1', {
      message: 'and now?',
      history: [
        { role: 'user', content: 'earlier question' },
        { role: 'assistant', content: 'earlier answer' },
      ],
    });
    const userMsg = (h.builtMessages as Array<{ role: string; content: string }>)[1]!;
    const parsed = JSON.parse(userMsg.content) as {
      history: Array<{ role: string; text: string }>;
      newUserText: string;
    };
    expect(parsed.newUserText).toBe('and now?');
    // Caller turns, mapped { content → text }.
    expect(parsed.history).toEqual([
      { role: 'user', text: 'earlier question' },
      { role: 'assistant', text: 'earlier answer' },
    ]);
    // The stored window never leaked in.
    expect(JSON.stringify(parsed.history)).not.toContain('STORED');
  });

  it('(c) threads excludeToolSlugs to the assembly and the loop sees the narrowed set', async () => {
    await runSimulatedResponderTurn('owner-1', {
      message: 'hi',
      excludeToolSlugs: ['email_send'],
    });
    expect(h.assembleOpts.excludeToolSlugs).toEqual(['email_send']);
    const toolSlugs = (h.loopOpts.assembled.allowedTools as Array<{ slug: string }>).map(
      (t) => t.slug,
    );
    expect(toolSlugs).toEqual(['search_nodes', 'note_create']);
    expect(toolSlugs).not.toContain('email_send');
  });

  it('(d) clamps + applies maxIterations to the loop overrides', async () => {
    await runSimulatedResponderTurn('owner-1', { message: 'hi', maxIterations: 999 });
    expect(h.loopOpts.assembled.loopOverrides.maxIterations).toBe(30); // clamped to 30
    // A sane value passes through, floored.
    await runSimulatedResponderTurn('owner-1', { message: 'hi', maxIterations: 8.9 });
    expect(h.loopOpts.assembled.loopOverrides.maxIterations).toBe(8);
  });

  it('surfaces the empty-reply substitution flag', async () => {
    h.outcome.reply = 'fallback';
    h.outcome.emptyReplySubstituted = true;
    const res = await runSimulatedResponderTurn('owner-1', { message: 'hi' });
    expect(res.emptyReplySubstituted).toBe(true);
    expect(res.reply).toBe('fallback');
  });

  it('rejects an empty message', async () => {
    await expect(runSimulatedResponderTurn('owner-1', { message: '   ' })).rejects.toThrow(
      /empty message/,
    );
  });

  it('errors like the real turn when no agent resolves', async () => {
    h.agent = null;
    await expect(runSimulatedResponderTurn('owner-1', { message: 'hi' })).rejects.toThrow(
      /No enabled assistant agent/,
    );
  });

  it('errors when the resolved agent has no api key configured', async () => {
    h.agent = { ...AGENT, apiKeyId: null } as unknown as Agent;
    await expect(runSimulatedResponderTurn('owner-1', { message: 'hi' })).rejects.toThrow(
      /has no api_key_id set/,
    );
  });

  it('errors when the api key id no longer resolves', async () => {
    h.apiKey = null;
    await expect(runSimulatedResponderTurn('owner-1', { message: 'hi' })).rejects.toThrow(
      /not found for agent/,
    );
  });
});
