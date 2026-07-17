/**
 * Unit tests for the shared responder-loop core (audit #5c stage 2) — the
 * traced middle every conversational surface (web /assistant, Telegram, Team
 * Chat) runs. Pins the core CONTRACT: the load_context step's standardized
 * retrieval snapshot, the assembled→runToolLoop plumbing, the empty-reply
 * fallback (b3), the prefs-gated thought trail (b4), and the tool-outcome
 * ledger (b5).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '@mantle/db';
import type { ConversationContext } from '@mantle/agent-runtime';
import type { AssembledResponderTurn } from './assemble-turn';

const h = vi.hoisted(() => ({
  loopResult: null as any,
  loopCalls: [] as any[],
  steps: [] as Array<{ name: string; input?: unknown; output?: unknown }>,
  thoughtsOn: false,
}));

vi.mock('@mantle/agent-runtime', () => ({
  runToolLoop: vi.fn(async (args: any) => {
    h.loopCalls.push(args);
    return h.loopResult;
  }),
  // Real-shaped tally so the b5 assertions are meaningful.
  summarizeToolOutcomes: (records: Array<{ slug: string; error: string | null }>) => {
    const failures = records
      .filter((r) => r.error && r.error !== 'queued_for_approval')
      .map((r) => ({ slug: r.slug, error: r.error! }));
    return {
      calls: records.length,
      succeeded: records.filter((r) => !r.error).length,
      failed: failures.length,
      skipped: 0,
      queued: records.filter((r) => r.error === 'queued_for_approval').length,
      failures,
    };
  },
  resolveBackupAdapter: vi.fn(async () => undefined),
}));

vi.mock('@mantle/content', () => ({
  isStreamThoughtsEnabled: () => h.thoughtsOn,
  isPersistThoughtsEnabled: () => h.thoughtsOn,
}));

vi.mock('@mantle/tracing', () => ({
  step: async (init: any, fn: (handle: any) => Promise<unknown>) => {
    const rec: { name: string; input?: unknown; output?: unknown } = {
      name: init.name,
      input: init.input,
    };
    h.steps.push(rec);
    return fn({ setMeta: () => {}, setOutput: (o: unknown) => (rec.output = o) });
  },
}));

import { EMPTY_REPLY_FALLBACK, emptyLoopResult, runResponderLoop } from './responder-loop';

const AGENT = {
  id: 'agent-1',
  slug: 'saskia',
  model: 'anthropic/claude-sonnet-4.5',
  provider: 'openrouter',
  baseUrl: null,
  viaTailnet: false,
  params: { temperature: 0.7 },
} as unknown as Agent;

const ASSEMBLED = {
  attachedSkills: [],
  effectiveSystemPrompt: 'SYSTEM',
  volatileContext: 'TIME',
  relatedHeartbeatSlugs: [],
  allowedTools: [{ slug: 'search_nodes' }],
  thinkingBudget: 1024,
  delegateTo: ['researcher'],
  resultHandling: null,
  loopOverrides: { maxIterations: 12, maxToolCallsPerTurn: 40 },
} as unknown as AssembledResponderTurn;

function ctxFixture(): ConversationContext {
  return {
    personaNotes: [{ note: 'p' }],
    facts: [{ fact: 'f' }, { fact: 'g' }],
    digests: [{ digest: 'd' }],
    corpusMap: { entries: [{ e: 1 }] },
    contentHits: [],
    chunkHits: [{ c: 1 }],
    relations: [],
    history: [{ role: 'user', text: 'earlier' }],
    snapshot: { items: ['snap'] },
  } as unknown as ConversationContext;
}

function baseOpts(overrides: Record<string, unknown> = {}) {
  const ctx = ctxFixture();
  return {
    ownerId: 'owner-1',
    agent: AGENT,
    adapter: { providerId: 'openrouter', adapterName: 'openrouter-chat' } as never,
    apiKey: 'sk-test',
    prefs: { timezone: 'UTC', locale: 'en-GB' },
    logPrefix: '[test]',
    assembled: ASSEMBLED,
    loadContext: async () => ctx,
    buildMessages: (c: ConversationContext) => [
      { role: 'system' as const, content: 'SYSTEM' },
      { role: 'user' as const, content: `q (${c.history.length} turns)` },
    ],
    surface: { kind: 'web' as const },
    ...overrides,
  };
}

beforeEach(() => {
  h.loopResult = {
    reply: 'hi there!',
    messages: [],
    iterations: 1,
    toolCalls: [],
    pendingIds: [],
    artifacts: [],
    tokensOut: 7,
  };
  h.loopCalls = [];
  h.steps = [];
  h.thoughtsOn = false;
});

describe('runResponderLoop', () => {
  it('records the standardized retrieval snapshot in the load_context step', async () => {
    await runResponderLoop(baseOpts({ contextStepExtra: { turnCount: 99 } }) as never);

    const step = h.steps.find((s) => s.name === 'load_context')!;
    expect(step.input).toEqual({ agentId: 'agent-1' });
    expect(step.output).toEqual({
      turnCount: 99, // contextStepExtra wins (team overrides with its thread length)
      digestCount: 1,
      factCount: 2,
      contentHitCount: 0,
      chunkHitCount: 1,
      corpusMapCount: 1,
      relationCount: 0,
      personaNoteCount: 1,
      snapshot: { items: ['snap'] },
    });
  });

  it('threads the assembly + built messages into runToolLoop', async () => {
    const r = await runResponderLoop(baseOpts() as never);

    expect(h.loopCalls).toHaveLength(1);
    const args = h.loopCalls[0];
    expect(args).toMatchObject({
      model: AGENT.model,
      params: { temperature: 0.7 },
      agentDepth: 1,
      delegateTo: ['researcher'],
      thinkingBudget: 1024,
      maxIterations: 12,
      maxToolCallsPerTurn: 40,
      surface: { kind: 'web' },
    });
    expect(args.tools).toEqual([{ slug: 'search_nodes' }]);
    // Messages were built from the LOADED context.
    expect(args.initialMessages[1].content).toBe('q (1 turns)');
    expect(r.reply).toBe('hi there!');
    expect(r.emptyReplySubstituted).toBe(false);
    expect(r.loop.tokensOut).toBe(7);
  });

  it('b3: substitutes the shared fallback for a double-empty reply', async () => {
    h.loopResult.reply = '   ';
    const r = await runResponderLoop(baseOpts() as never);
    expect(r.reply).toBe(EMPTY_REPLY_FALLBACK);
    expect(r.emptyReplySubstituted).toBe(true);
  });

  it('a stopped (aborted) turn keeps its partial/empty reply — no substitution', async () => {
    h.loopResult.reply = '';
    const controller = new AbortController();
    controller.abort();
    const r = await runResponderLoop(baseOpts({ abortSignal: controller.signal }) as never);
    expect(r.reply).toBe('');
    expect(r.emptyReplySubstituted).toBe(false);
  });

  it('b4: builds the thought trail only when both persistence prefs are on', async () => {
    h.loopResult.toolCalls = [
      { slug: 'note_create', argsJson: '{"title":"Q3 plan"}', durationMs: 42, error: null },
      { slug: 'search_nodes', argsJson: 'not-json', durationMs: 7, error: null },
    ];
    const off = await runResponderLoop(baseOpts() as never);
    expect(off.persistedThoughts).toEqual([]);

    h.thoughtsOn = true;
    const on = await runResponderLoop(baseOpts() as never);
    expect(on.persistedThoughts).toEqual([
      { kind: 'write', label: 'Saving “Q3 plan” to your notes…', elapsedMs: 42 },
      { kind: 'brain', label: 'Searching your brain…', elapsedMs: 7 },
    ]);
  });

  it('b5: tallies the tool-outcome ledger whenever any tool ran', async () => {
    const none = await runResponderLoop(baseOpts() as never);
    expect(none.toolStats).toBeNull();

    h.loopResult.toolCalls = [
      { slug: 'search_nodes', argsJson: '{}', durationMs: 5, error: null },
      { slug: 'email_send', argsJson: '{}', durationMs: 9, error: 'smtp down' },
    ];
    const some = await runResponderLoop(baseOpts() as never);
    expect(some.toolStats).toEqual({
      calls: 2,
      succeeded: 1,
      failed: 1,
      skipped: 0,
      queued: 0,
      failures: [{ slug: 'email_send', error: 'smtp down' }],
    });
  });
});

describe('emptyLoopResult', () => {
  it('is the zeroed shape the abort paths synthesize', () => {
    expect(emptyLoopResult()).toEqual({
      reply: '',
      messages: [],
      iterations: 0,
      toolCalls: [],
      pendingIds: [],
      artifacts: [],
      tokensOut: 0,
    });
  });
});
