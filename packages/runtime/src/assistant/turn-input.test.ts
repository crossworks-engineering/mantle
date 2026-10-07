/**
 * Unit tests for `describeResponderTurnInput` (the `responder_turn_input` MCP
 * tool's engine). Pins the contract that makes it honest:
 *   (a) it runs the SIM's read path (the real run-sim-turn prepare + message
 *       builder), so the input it reports is the turn ask_responder runs;
 *   (b) it makes no model call and writes nothing to the conversation store:
 *       no api key, no chat adapter, no recordTurn;
 *   (c) the tools are the loop's own list (read_result added, dynamic schema
 *       built with the delegation allowlist), built at the agent's level;
 *   (d) cache marks survive the flattening; the loop settings are reported;
 *   (e) the two role responders are refused (their turn is assembled
 *       elsewhere).
 * Collaborators below run-sim-turn are mocked, as in run-sim-turn.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '@mantle/db';

const h = vi.hoisted(() => ({
  agent: null as unknown,
  stable: Symbol('stable'),
  builtArgs: null as any,
  loadArgs: null as any,
  stepCalls: [] as any[],
  toolCalls: [] as any[],
  viewerAgents: [] as any[],
  recordTurn: vi.fn(),
  getApiKeyById: vi.fn(),
  getChatAdapter: vi.fn(),
  loopOverrides: {} as Record<string, number>,
}));

vi.mock('./run-turn', () => ({ resolveAssistantAgent: vi.fn(async () => h.agent) }));
vi.mock('./run-team-turn', () => ({
  TEAM_RESPONDER_SLUG: 'team-responder',
  CLIENT_RESPONDER_SLUG: 'client-responder',
}));
vi.mock('@mantle/api-keys', () => ({ getApiKeyById: h.getApiKeyById }));
vi.mock('@mantle/voice', () => ({ getChatAdapter: h.getChatAdapter }));
vi.mock('@mantle/content', () => ({
  loadProfilePreferences: vi.fn(async () => ({ timezone: 'UTC' })),
}));
vi.mock('@mantle/decisions', () => ({ delegationHintTraceData: vi.fn(() => null) }));
vi.mock('@mantle/tracing', () => ({
  startTrace: vi.fn(async (_init: unknown, fn: () => Promise<unknown>) => fn()),
  currentTrace: vi.fn(() => ({ id: 'trace-in' })),
  createTracePrelude: vi.fn(() => ({ steps: [] })),
  withTracePrelude: vi.fn(async (_p: unknown, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('./responder-loop', () => ({
  runResponderLoop: vi.fn(),
  loadContextStep: vi.fn(async (load: () => Promise<unknown>, input: unknown) => {
    h.stepCalls.push(input);
    return load();
  }),
}));
vi.mock('../agent/messages', () => ({ STABLE_PREFIX: h.stable }));
vi.mock('../agent', () => ({
  DEFAULT_MAX_ITERATIONS: 6,
  loadConversationContext: vi.fn(async (args: unknown) => {
    h.loadArgs = args;
    return {
      personaNotes: [],
      facts: [{ content: 'f', kind: 'fact' }],
      digests: [],
      corpusMap: { entries: [{}, {}], truncated: false },
      contentHits: [],
      chunkHits: [{}],
      relations: [],
      history: [{ role: 'user', text: 'STORED' }],
      journalRelevant: '',
      snapshot: {},
    };
  }),
  // A cached block (explicit marker), an implicit-prefix block, a volatile
  // block, the caller history and the new message.
  buildChatMessages: vi.fn((args: any) => {
    h.builtArgs = args;
    return [
      { role: 'system', content: [{ type: 'text', text: 'PERSONA', cacheControl: {} }] },
      { role: 'system', content: 'MAP', [h.stable]: true },
      { role: 'system', content: 'TIME' },
      ...args.history.map((t: any) => ({ role: t.role, content: t.text })),
      { role: 'user', content: args.newUserText },
    ];
  }),
  withReadResultTool: vi.fn(async (_owner: string, tools: Array<{ slug: string }>) => [
    ...tools,
    { slug: 'read_result' },
  ]),
  buildToolsForModel: vi.fn(async (tools: Array<{ slug: string }>, ctx: unknown) => {
    h.toolCalls.push(ctx);
    return tools.map((t) => ({
      type: 'function',
      function: { name: t.slug, description: `d:${t.slug}`, parameters: { type: 'object' } },
    }));
  }),
  withAgentViewer: vi.fn(async (agent: unknown, fn: () => Promise<unknown>) => {
    h.viewerAgents.push(agent);
    return fn();
  }),
  recordTurn: h.recordTurn,
}));
vi.mock('./assemble-turn', () => ({
  assembleResponderTurn: vi.fn(async () => ({
    attachedSkills: [],
    effectiveSystemPrompt: 'SYSTEM',
    journalBlock: '',
    volatileContext: 'TIME',
    relatedHeartbeatSlugs: [],
    allowedTools: [{ slug: 'search_nodes' }],
    thinkingBudget: 2048,
    thinkingEffort: 'medium',
    delegateTo: ['researcher'],
    delegationHint: null,
    resultHandling: null,
    loopOverrides: h.loopOverrides,
  })),
}));

import { describeResponderTurnInput } from './turn-input';

const AGENT = {
  id: 'agent-1',
  slug: 'saskia',
  name: 'Saskia',
  model: 'anthropic/claude-sonnet-4.5',
  provider: 'openrouter',
  apiKeyId: 'key-1',
  params: { temperature: 0.4, max_retries: 3 },
} as unknown as Agent;

beforeEach(() => {
  h.agent = AGENT;
  h.builtArgs = null;
  h.loadArgs = null;
  h.stepCalls = [];
  h.toolCalls = [];
  h.viewerAgents = [];
  h.loopOverrides = {};
  h.recordTurn.mockClear();
  h.getApiKeyById.mockClear();
  h.getChatAdapter.mockClear();
});

describe('describeResponderTurnInput', () => {
  it('(a) builds the sim prompt from the caller history and the new message', async () => {
    const res = await describeResponderTurnInput('owner-1', {
      message: 'and now?',
      history: [
        { role: 'user', content: 'earlier' },
        { role: 'assistant', content: 'answer' },
      ],
    });
    expect(h.builtArgs.newUserText).toBe('and now?');
    expect(h.builtArgs.history).toEqual([
      { role: 'user', text: 'earlier' },
      { role: 'assistant', text: 'answer' },
    ]);
    expect(h.loadArgs.recentTurnTexts).toEqual(['earlier', 'answer']);
    expect(res.messages.map((m) => m.content)).toEqual([
      'PERSONA',
      'MAP',
      'TIME',
      'earlier',
      'answer',
      'and now?',
    ]);
    expect(JSON.stringify(res.messages)).not.toContain('STORED');
    expect(res.context).toMatchObject({
      historyTurns: 2,
      facts: 1,
      passages: 1,
      corpusMapEntries: 2,
    });
  });

  it('(b) makes no model call and writes nothing to the conversation', async () => {
    await describeResponderTurnInput('owner-1', { message: 'hi' });
    expect(h.getApiKeyById).not.toHaveBeenCalled();
    expect(h.getChatAdapter).not.toHaveBeenCalled();
    expect(h.recordTurn).not.toHaveBeenCalled();
  });

  it('(b) records the retrieval snapshot step and returns the trace id', async () => {
    const res = await describeResponderTurnInput('owner-1', { message: 'hi' });
    expect(h.stepCalls).toEqual([{ agentId: 'agent-1' }]);
    expect(res.traceId).toBe('trace-in');
  });

  it("(c) reports the loop's tool list, built at the agent's level", async () => {
    const res = await describeResponderTurnInput('owner-1', { message: 'hi' });
    expect(res.tools.map((t) => t.name)).toEqual(['search_nodes', 'read_result']);
    expect(res.tools[0]).toEqual({
      name: 'search_nodes',
      description: 'd:search_nodes',
      parameters: { type: 'object' },
    });
    expect(h.toolCalls).toEqual([{ ownerId: 'owner-1', delegateTo: ['researcher'] }]);
    expect(h.viewerAgents).toEqual([AGENT]);
  });

  it('(d) keeps the cache marks and reports the loop settings', async () => {
    h.loopOverrides = { maxToolCallsPerTurn: 40 };
    const res = await describeResponderTurnInput('owner-1', { message: 'hi' });
    expect(res.messages.map((m) => m.cached)).toEqual([true, true, false, false]);
    expect(res.loop).toEqual({
      maxIterations: 6,
      maxToolCallsPerTurn: 40,
      maxCallsPerToolPerTurn: null,
      thinkingBudget: 2048,
      thinkingEffort: 'medium',
      delegateTo: ['researcher'],
      // Only the model params; delivery knobs (max_retries) stay out.
      params: { temperature: 0.4 },
    });
    expect(res.differences.length).toBeGreaterThan(0);
  });

  it('(e) refuses the team and client responders', async () => {
    h.agent = { ...AGENT, slug: 'team-responder' } as unknown as Agent;
    await expect(describeResponderTurnInput('owner-1', { message: 'hi' })).rejects.toThrow(
      /mirrors the owner turn only/,
    );
    h.agent = { ...AGENT, slug: 'client-responder' } as unknown as Agent;
    await expect(describeResponderTurnInput('owner-1', { message: 'hi' })).rejects.toThrow(
      /mirrors the owner turn only/,
    );
  });

  it('rejects an empty message and a missing agent', async () => {
    await expect(describeResponderTurnInput('owner-1', { message: '  ' })).rejects.toThrow(
      /empty message/,
    );
    h.agent = null;
    await expect(describeResponderTurnInput('owner-1', { message: 'hi' })).rejects.toThrow(
      /No enabled assistant agent/,
    );
  });
});
