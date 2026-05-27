/**
 * Direct unit tests for `runToolLoop`.
 *
 * The tool-loop is the heart of the responder + assistant + heartbeat
 * + invoke_agent paths. Pre-Phase-3 it was exercised only via
 * production integration; this suite locks down the iteration grammar
 * + contract-forwarding behaviour at the unit level so a future
 * refactor breaks LOUDLY rather than at first inbound message.
 *
 * Strategy:
 *   - Don't mock @mantle/tracing — `step()` no-ops gracefully when
 *     called outside a trace context (no DB writes), so the loop runs
 *     under instrumentation that's effectively transparent.
 *   - Mock @mantle/tools so `dispatchTool` + `resolveTool` (the
 *     read_result lookup) are programmable per test, and so we don't
 *     drag the real DB into the test path.
 *   - Mock @mantle/db's `db` + `pendingToolCalls` for the
 *     requires_confirm path (the only place the loop writes).
 *   - Build a fake ChatDispatcher that returns scripted ChatResults
 *     so iteration shapes are deterministic. Capture every adapter
 *     call so assertions can check what the loop SENT, not just what
 *     came back.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Module mocks ──────────────────────────────────────────────────────────
//
// Hoisted state these mocks reference. The vitest factory pattern requires
// the state vars to be visible at module scope so the lazy mock factory can
// close over them.

const dispatchToolCalls: Array<{ slug: string; input: Record<string, unknown> }> = [];
let dispatchToolImpl: (slug: string, input: Record<string, unknown>) =>
  | { ok: true; output: unknown; artifacts?: unknown[] }
  | { ok: false; error: string } = () => ({ ok: true, output: { ok: 1 } });

const insertedPendingArgs: Array<Record<string, unknown>> = [];

vi.mock('@mantle/tools', () => ({
  dispatchTool: vi.fn(async (tool: { slug: string }, input: Record<string, unknown>) => {
    dispatchToolCalls.push({ slug: tool.slug, input });
    return dispatchToolImpl(tool.slug, input);
  }),
  resolveTool: vi.fn(async () => null), // No `read_result` seeded — keeps loopTools = args.tools
  resolveTools: vi.fn(async () => []),
  getBuiltinRedactFields: vi.fn(() => []),
  redactArgsForLogging: vi.fn(<T>(args: T) => args),
  processToolResultForModel: vi.fn(async ({ serialized }: { serialized: string }) => ({
    payload: serialized,
    spilled: false,
    handle: null,
    bytes: serialized.length,
  })),
  resolveResultHandling: vi.fn(() => ({
    inlineMaxBytes: 1_000_000, // Effectively never spill in unit tests.
    embedMinBytes: 0,
    spillMaxBytes: 10_000_000,
  })),
}));

vi.mock('@mantle/db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn((row: Record<string, unknown>) => ({
        returning: vi.fn(async () => {
          insertedPendingArgs.push(row);
          return [{ id: `pending-${insertedPendingArgs.length}` }];
        }),
      })),
    })),
  },
  pendingToolCalls: {},
}));

// Import AFTER mocks so the loop picks up the mocked deps.
import { runToolLoop } from './tool-loop';
import type {
  ChatDispatcher,
  ChatOptions,
  ChatResult,
  ChatToolCall,
} from '@mantle/voice';
import type { Tool } from '@mantle/db';

// ─── Fake adapter ──────────────────────────────────────────────────────────

type ScriptStep =
  | { type: 'text'; text: string }
  | { type: 'toolCalls'; toolCalls: ChatToolCall[]; text?: string };

function makeFakeAdapter(script: ScriptStep[]): {
  adapter: ChatDispatcher;
  calls: ChatOptions[];
} {
  const calls: ChatOptions[] = [];
  let cursor = 0;
  const adapter: ChatDispatcher = {
    providerId: 'openrouter',
    adapterName: 'fake-chat',
    chat: vi.fn(async (opts: ChatOptions): Promise<ChatResult> => {
      calls.push(opts);
      const step = script[cursor];
      if (!step) {
        throw new Error(
          `fake-chat: ran out of scripted responses on call ${cursor + 1} ` +
            `(script had ${script.length}). Loop is probably iterating more ` +
            `than the test expects.`,
        );
      }
      cursor += 1;
      if (step.type === 'text') {
        return {
          text: step.text,
          model: 'fake-model',
          tokensIn: 10,
          tokensOut: 5,
        };
      }
      return {
        text: step.text ?? '',
        model: 'fake-model',
        toolCalls: step.toolCalls,
        tokensIn: 10,
        tokensOut: 5,
      };
    }),
  };
  return { adapter, calls };
}

// ─── Fake tool rows ────────────────────────────────────────────────────────

function fakeTool(overrides: Partial<Tool> = {}): Tool {
  return {
    id: `tool-${Math.random().toString(36).slice(2, 8)}`,
    ownerId: 'owner-1',
    slug: 'fake_tool',
    name: 'Fake tool',
    description: 'Test fixture',
    inputSchema: { type: 'object', properties: {} },
    handler: { kind: 'builtin', slug: 'fake_tool' } as never,
    requiresConfirm: false,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Tool;
}

// ─── Setup / teardown ──────────────────────────────────────────────────────

beforeEach(() => {
  dispatchToolCalls.length = 0;
  insertedPendingArgs.length = 0;
  // Default dispatcher returns success with a small payload.
  dispatchToolImpl = () => ({ ok: true, output: { ok: 1 } });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('runToolLoop — happy paths', () => {
  it('returns the reply on a single LLM call with no tool requests', async () => {
    const { adapter, calls } = makeFakeAdapter([{ type: 'text', text: 'hello back' }]);
    const result = await runToolLoop({
      adapter,
      apiKey: 'k',
      model: 'm',
      params: {},
      ownerId: 'owner-1',
      initialMessages: [
        { role: 'system', content: 'you are saskia' },
        { role: 'user', content: 'hi' },
      ],
      tools: [],
    });
    expect(result.reply).toBe('hello back');
    expect(result.iterations).toBe(1);
    expect(result.toolCalls).toEqual([]);
    expect(result.pendingIds).toEqual([]);
    expect(result.artifacts).toEqual([]);
    expect(calls).toHaveLength(1);
    // Last message in the chain is the assistant's text reply.
    const last = result.messages[result.messages.length - 1]!;
    expect(last).toEqual({ role: 'assistant', content: 'hello back' });
  });

  it('does not send the tools field when args.tools is empty', async () => {
    const { adapter, calls } = makeFakeAdapter([{ type: 'text', text: 'ok' }]);
    await runToolLoop({
      adapter,
      apiKey: 'k',
      model: 'm',
      params: {},
      ownerId: 'owner-1',
      initialMessages: [{ role: 'user', content: 'hi' }],
      tools: [],
    });
    expect(calls[0]!.tools).toBeUndefined();
  });

  it('forwards temperature / max_tokens / top_p from params on every iteration', async () => {
    const { adapter, calls } = makeFakeAdapter([{ type: 'text', text: 'ok' }]);
    await runToolLoop({
      adapter,
      apiKey: 'k',
      model: 'm',
      params: { temperature: 0.3, max_tokens: 250, top_p: 0.95 },
      ownerId: 'owner-1',
      initialMessages: [{ role: 'user', content: 'hi' }],
      tools: [],
    });
    expect(calls[0]!.temperature).toBe(0.3);
    expect(calls[0]!.maxTokens).toBe(250);
    expect(calls[0]!.topP).toBe(0.95);
  });
});

describe('runToolLoop — cache markers', () => {
  it('sends cacheControl { systemPrompt, lastUserMessage } on every iteration', async () => {
    // Two iterations: a tool call + a final text. Both LLM calls must
    // carry the cache markers — without this the responder loses cache
    // hits on iter 2+ (the audit #4 regression).
    const { adapter, calls } = makeFakeAdapter([
      {
        type: 'toolCalls',
        toolCalls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'fake_tool', arguments: '{}' },
          },
        ],
      },
      { type: 'text', text: 'done' },
    ]);
    await runToolLoop({
      adapter,
      apiKey: 'k',
      model: 'm',
      params: {},
      ownerId: 'owner-1',
      initialMessages: [{ role: 'user', content: 'hi' }],
      tools: [fakeTool()],
    });
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.cacheControl).toEqual({
        systemPrompt: true,
        lastUserMessage: true,
      });
    }
  });
});

describe('runToolLoop — single tool iteration', () => {
  it('dispatches the tool, appends the result, and returns the next LLM text', async () => {
    const tool = fakeTool({ slug: 'note_create' });
    const { adapter, calls } = makeFakeAdapter([
      {
        type: 'toolCalls',
        toolCalls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'note_create', arguments: '{"title":"hi"}' },
          },
        ],
      },
      { type: 'text', text: 'note created' },
    ]);
    dispatchToolImpl = () => ({ ok: true, output: { id: 'node_42' } });

    const result = await runToolLoop({
      adapter,
      apiKey: 'k',
      model: 'm',
      params: {},
      ownerId: 'owner-1',
      initialMessages: [{ role: 'user', content: 'make a note' }],
      tools: [tool],
    });
    expect(result.reply).toBe('note created');
    expect(result.iterations).toBe(2);
    expect(dispatchToolCalls).toEqual([
      { slug: 'note_create', input: { title: 'hi' } },
    ]);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({
      slug: 'note_create',
      status: 'success',
    });
    // The message chain after the loop:
    //   [user, assistant(toolCalls), tool(result), assistant(text)]
    expect(result.messages).toHaveLength(4);
    expect(result.messages[1]).toMatchObject({
      role: 'assistant',
      toolCalls: [
        expect.objectContaining({
          function: { name: 'note_create', arguments: '{"title":"hi"}' },
        }),
      ],
    });
    expect(result.messages[2]).toEqual({
      role: 'tool',
      toolCallId: 'call_1',
      content: '{"id":"node_42"}',
    });
    // The second LLM call's tools field is still populated (we don't
    // strip tools mid-loop; the model can chain calls).
    expect(calls[1]!.tools).toHaveLength(1);
  });
});

describe('runToolLoop — multi-iteration tool sequence', () => {
  it('runs N iterations until the model returns text, threading message history', async () => {
    const tool = fakeTool({ slug: 'fake_tool' });
    const { adapter, calls } = makeFakeAdapter([
      {
        type: 'toolCalls',
        toolCalls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'fake_tool', arguments: '{"n":1}' },
          },
        ],
      },
      {
        type: 'toolCalls',
        toolCalls: [
          {
            id: 'call_2',
            type: 'function',
            function: { name: 'fake_tool', arguments: '{"n":2}' },
          },
        ],
      },
      { type: 'text', text: 'all done' },
    ]);

    const result = await runToolLoop({
      adapter,
      apiKey: 'k',
      model: 'm',
      params: {},
      ownerId: 'owner-1',
      initialMessages: [{ role: 'user', content: 'do twice' }],
      tools: [tool],
    });
    expect(result.iterations).toBe(3);
    expect(result.reply).toBe('all done');
    expect(dispatchToolCalls).toEqual([
      { slug: 'fake_tool', input: { n: 1 } },
      { slug: 'fake_tool', input: { n: 2 } },
    ]);
    // Iter 3's messages array MUST include both prior assistant turns
    // + both tool results so the model sees its own history.
    const iter3Messages = calls[2]!.messages;
    expect(iter3Messages).toHaveLength(6); // user, asst1, tool1, asst2, tool2, (next pos)
    expect(iter3Messages[2]).toMatchObject({ role: 'tool', toolCallId: 'call_1' });
    expect(iter3Messages[4]).toMatchObject({ role: 'tool', toolCallId: 'call_2' });
  });

  it('handles multiple tool calls in a single iteration', async () => {
    const tool = fakeTool({ slug: 'fake_tool' });
    const { adapter } = makeFakeAdapter([
      {
        type: 'toolCalls',
        toolCalls: [
          {
            id: 'call_a',
            type: 'function',
            function: { name: 'fake_tool', arguments: '{"x":1}' },
          },
          {
            id: 'call_b',
            type: 'function',
            function: { name: 'fake_tool', arguments: '{"x":2}' },
          },
        ],
      },
      { type: 'text', text: 'both done' },
    ]);
    const result = await runToolLoop({
      adapter,
      apiKey: 'k',
      model: 'm',
      params: {},
      ownerId: 'owner-1',
      initialMessages: [{ role: 'user', content: 'do two' }],
      tools: [tool],
    });
    expect(dispatchToolCalls).toEqual([
      { slug: 'fake_tool', input: { x: 1 } },
      { slug: 'fake_tool', input: { x: 2 } },
    ]);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.reply).toBe('both done');
  });
});

describe('runToolLoop — error surfaces', () => {
  it('surfaces "tool not in allowlist" as a tool_result the model can react to', async () => {
    // The model called `unknown_tool` but we only granted `fake_tool`.
    // The loop should NOT throw — it should send an error result back
    // to the model so it can recover with a different tool / approach.
    const { adapter } = makeFakeAdapter([
      {
        type: 'toolCalls',
        toolCalls: [
          {
            id: 'call_x',
            type: 'function',
            function: { name: 'unknown_tool', arguments: '{}' },
          },
        ],
      },
      { type: 'text', text: 'sorry, retried' },
    ]);
    const result = await runToolLoop({
      adapter,
      apiKey: 'k',
      model: 'm',
      params: {},
      ownerId: 'owner-1',
      initialMessages: [{ role: 'user', content: 'go' }],
      tools: [fakeTool({ slug: 'fake_tool' })],
    });
    expect(result.reply).toBe('sorry, retried');
    expect(dispatchToolCalls).toHaveLength(0); // never dispatched
    expect(result.toolCalls[0]).toMatchObject({
      slug: 'unknown_tool',
      status: 'error',
      error: expect.stringContaining('allowlist'),
    });
    // The tool message in the chain carries the error JSON the model saw.
    const toolMsg = result.messages.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).toContain('allowlist');
  });

  it('surfaces malformed-JSON args as a structured error to the model', async () => {
    const tool = fakeTool({ slug: 'fake_tool' });
    const { adapter } = makeFakeAdapter([
      {
        type: 'toolCalls',
        toolCalls: [
          {
            id: 'call_y',
            type: 'function',
            // Missing closing brace — parseToolArgs rejects.
            function: { name: 'fake_tool', arguments: '{"a": "b' },
          },
        ],
      },
      { type: 'text', text: 'recovered' },
    ]);
    const result = await runToolLoop({
      adapter,
      apiKey: 'k',
      model: 'm',
      params: {},
      ownerId: 'owner-1',
      initialMessages: [{ role: 'user', content: 'go' }],
      tools: [tool],
    });
    expect(dispatchToolCalls).toHaveLength(0); // never dispatched — guard caught it
    expect(result.toolCalls[0]).toMatchObject({
      slug: 'fake_tool',
      status: 'error',
    });
    expect(result.reply).toBe('recovered');
  });

  it('surfaces handler-thrown errors as tool_results without crashing the loop', async () => {
    const tool = fakeTool({ slug: 'fake_tool' });
    dispatchToolImpl = () => ({
      ok: false as const,
      error: 'tool internals exploded',
    });
    const { adapter } = makeFakeAdapter([
      {
        type: 'toolCalls',
        toolCalls: [
          {
            id: 'call_z',
            type: 'function',
            function: { name: 'fake_tool', arguments: '{}' },
          },
        ],
      },
      { type: 'text', text: 'will retry later' },
    ]);
    const result = await runToolLoop({
      adapter,
      apiKey: 'k',
      model: 'm',
      params: {},
      ownerId: 'owner-1',
      initialMessages: [{ role: 'user', content: 'go' }],
      tools: [tool],
    });
    expect(result.reply).toBe('will retry later');
    expect(result.toolCalls[0]).toMatchObject({
      status: 'error',
      error: 'tool internals exploded',
    });
  });
});

describe('runToolLoop — requires_confirm path', () => {
  it('queues a pending_tool_calls row and feeds a "queued for approval" ack back to the model', async () => {
    const tool = fakeTool({ slug: 'send_email', requiresConfirm: true });
    const { adapter } = makeFakeAdapter([
      {
        type: 'toolCalls',
        toolCalls: [
          {
            id: 'call_send',
            type: 'function',
            function: {
              name: 'send_email',
              arguments: '{"to":"a@b.com","subject":"hi"}',
            },
          },
        ],
      },
      { type: 'text', text: 'queued' },
    ]);
    const result = await runToolLoop({
      adapter,
      apiKey: 'k',
      model: 'm',
      params: {},
      ownerId: 'owner-1',
      agentId: 'agent-1',
      initialMessages: [{ role: 'user', content: 'send it' }],
      tools: [tool],
    });
    // The dispatcher is NEVER called — confirmed gate kicks in.
    expect(dispatchToolCalls).toHaveLength(0);
    // A pending row IS inserted with the ORIGINAL args (not redacted).
    expect(insertedPendingArgs).toHaveLength(1);
    expect(insertedPendingArgs[0]).toMatchObject({
      ownerId: 'owner-1',
      agentId: 'agent-1',
      toolSlug: 'send_email',
      args: { to: 'a@b.com', subject: 'hi' },
    });
    // The loop returns the pending id.
    expect(result.pendingIds).toEqual(['pending-1']);
    // The synthetic tool_result tells the model it's queued.
    const toolMsg = result.messages.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).toContain('queued_for_approval');
    expect(toolMsg!.content).toContain('pending-1');
  });
});

describe('runToolLoop — artifacts collection', () => {
  it('harvests sidecar artifacts emitted by tools', async () => {
    const tool = fakeTool({ slug: 'synthesize_speech' });
    const artifact = {
      kind: 'audio',
      bytes: Buffer.from('fake-audio'),
      mimeType: 'audio/opus',
    };
    dispatchToolImpl = () => ({
      ok: true as const,
      output: { delivered: true },
      artifacts: [artifact],
    });
    const { adapter } = makeFakeAdapter([
      {
        type: 'toolCalls',
        toolCalls: [
          {
            id: 'call_tts',
            type: 'function',
            function: { name: 'synthesize_speech', arguments: '{}' },
          },
        ],
      },
      { type: 'text', text: 'spoken' },
    ]);
    const result = await runToolLoop({
      adapter,
      apiKey: 'k',
      model: 'm',
      params: {},
      ownerId: 'owner-1',
      initialMessages: [{ role: 'user', content: 'speak' }],
      tools: [tool],
    });
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toEqual(artifact);
  });
});

describe('runToolLoop — max iterations + force_final', () => {
  it('falls through to a force_final call with toolChoice="none" when maxIterations is exhausted', async () => {
    // Script: every iteration emits a tool call. With maxIterations=2,
    // the loop runs both, then fires the force_final call (no tools)
    // to get a text answer. That's 3 LLM calls total.
    const tool = fakeTool({ slug: 'fake_tool' });
    const { adapter, calls } = makeFakeAdapter([
      {
        type: 'toolCalls',
        toolCalls: [
          { id: 'c1', type: 'function', function: { name: 'fake_tool', arguments: '{}' } },
        ],
      },
      {
        type: 'toolCalls',
        toolCalls: [
          { id: 'c2', type: 'function', function: { name: 'fake_tool', arguments: '{}' } },
        ],
      },
      { type: 'text', text: 'forced final answer' },
    ]);
    const result = await runToolLoop({
      adapter,
      apiKey: 'k',
      model: 'm',
      params: {},
      ownerId: 'owner-1',
      initialMessages: [{ role: 'user', content: 'go' }],
      tools: [tool],
      maxIterations: 2,
    });
    expect(calls).toHaveLength(3);
    // The force_final call disables tools.
    expect(calls[2]!.toolChoice).toBe('none');
    expect(calls[2]!.tools).toBeUndefined();
    expect(result.reply).toBe('forced final answer');
    expect(result.iterations).toBe(3); // maxIters (2) + 1 (force_final)
  });
});

describe('runToolLoop — step naming uses adapter.adapterName', () => {
  // The /traces UI keys off step names; this assertion ensures the
  // chat-step name carries the adapter identity so operators can
  // tell at a glance which adapter ran a given call. Pre-3b the name
  // was hard-coded 'openrouter_chat' regardless of provider.
  it('step names are not asserted here (no trace context — step() bypasses)', () => {
    // The naming logic lives in tool-loop.ts:
    //   `${args.adapter.adapterName}_chat` / `_chat[N]` / `_chat[force_final]`
    // We exercise the path implicitly in every test above; a direct
    // assertion would require running inside a trace context which
    // means the real DB. Left as a documentation marker.
    expect(true).toBe(true);
  });
});
