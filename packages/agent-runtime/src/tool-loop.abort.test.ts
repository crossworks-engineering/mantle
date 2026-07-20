/**
 * Stop-mid-turn tests for `runToolLoop`.
 *
 * A user Stop aborts the turn's AbortController; the adapters already honour
 * the signal for token generation, but the LOOP must also refuse to (a)
 * execute tool calls carried by an aborted round's partial reply, (b) start
 * further tool calls mid-batch, and (c) run more chat rounds / empty-reply
 * retries — otherwise the turn visibly runs to completion after a Stop (the
 * 2026-07 "stop doesn't stop it" bug).
 *
 * Same mock strategy as tool-loop.test.ts, plus ONE tracing override:
 * `currentTurnAbortSignal` is backed by a test-controlled AbortController
 * (the real implementation needs a live trace context with a turnId, which
 * needs a DB). Everything else in @mantle/tracing is the real no-op-outside-
 * a-trace implementation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dispatchToolCalls: Array<{ slug: string; input: Record<string, unknown> }> = [];
let dispatchToolImpl: (
  slug: string,
  input: Record<string, unknown>,
) =>
  | { ok: true; output: unknown; artifacts?: unknown[]; untrusted?: boolean }
  | { ok: false; error: string } = () => ({ ok: true, output: { ok: 1 } });

/** The turn's AbortController, swapped fresh per test. */
let turnController: AbortController;

vi.mock('@mantle/tracing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/tracing')>();
  return {
    ...actual,
    currentTurnAbortSignal: () => turnController.signal,
  };
});

vi.mock('@mantle/tools', async () => ({
  validateToolArgs: (
    await vi.importActual<typeof import('../../tools/src/validate-args')>(
      '../../tools/src/validate-args',
    )
  ).validateToolArgs,
  sanitizeToolError: (
    await vi.importActual<typeof import('../../tools/src/errors')>('../../tools/src/errors')
  ).sanitizeToolError,
  UNTRUSTED_CONTENT_TOOL_SLUGS: (
    await vi.importActual<typeof import('../../tools/src/untrusted')>('../../tools/src/untrusted')
  ).UNTRUSTED_CONTENT_TOOL_SLUGS,
  getDynamicSchema: (
    await vi.importActual<typeof import('../../tools/src/dynamic-schema')>(
      '../../tools/src/dynamic-schema',
    )
  ).getDynamicSchema,
  dispatchTool: vi.fn(async (tool: { slug: string }, input: Record<string, unknown>) => {
    dispatchToolCalls.push({ slug: tool.slug, input });
    return dispatchToolImpl(tool.slug, input);
  }),
  resolveTool: vi.fn(async () => null),
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
    inlineMaxBytes: 1_000_000,
    embedMinBytes: 0,
    spillMaxBytes: 10_000_000,
  })),
  notifyPendingCreated: vi.fn(async () => {}),
}));

let pendingInsertCount = 0;
vi.mock('@mantle/db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(async () => {
          pendingInsertCount += 1;
          return [{ id: `pending-${pendingInsertCount}` }];
        }),
      })),
    })),
  },
  pendingToolCalls: {},
}));

// Import AFTER mocks so the loop picks up the mocked deps.
import { runToolLoop, summarizeToolOutcomes } from './tool-loop';
import type { ChatDispatcher, ChatOptions, ChatResult, ChatToolCall } from '@mantle/voice';
import type { Tool } from '@mantle/db';

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
            `(script had ${script.length}).`,
        );
      }
      cursor += 1;
      if (step.type === 'text') {
        return { text: step.text, model: 'fake-model', tokensIn: 10, tokensOut: 5 };
      }
      return {
        text: step.text ?? '',
        model: 'fake-model',
        tokensIn: 10,
        tokensOut: 5,
        toolCalls: step.toolCalls,
      };
    }),
  };
  return { adapter, calls };
}

function fakeTool(): Tool {
  return {
    id: 'tool-abort-test',
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
  } as Tool;
}

const call = (id: string): ChatToolCall => ({
  id,
  type: 'function',
  function: { name: 'fake_tool', arguments: '{}' },
});

const baseArgs = (adapter: ChatDispatcher) => ({
  adapter,
  apiKey: 'k',
  model: 'fake-model',
  params: {},
  ownerId: 'owner-1',
  initialMessages: [{ role: 'user' as const, content: 'hi' }],
  tools: [fakeTool()],
});

beforeEach(() => {
  dispatchToolCalls.length = 0;
  pendingInsertCount = 0;
  dispatchToolImpl = () => ({ ok: true, output: { ok: 1 } });
  turnController = new AbortController();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('runToolLoop — user Stop (turn abort)', () => {
  it('discards tool calls carried by an aborted round and finalizes with the partial text', async () => {
    // Stop landed before/during round 1: the signal is already aborted when
    // the round's result comes back carrying complete tool calls.
    turnController.abort();
    const { adapter, calls } = makeFakeAdapter([
      { type: 'toolCalls', toolCalls: [call('c1'), call('c2')], text: 'partial thoughts' },
    ]);
    const result = await runToolLoop(baseArgs(adapter));
    expect(result.reply).toBe('partial thoughts');
    expect(dispatchToolCalls).toHaveLength(0); // nothing executed
    expect(calls).toHaveLength(1); // no further rounds, no empty-retry
  });

  it('does not run the empty-reply retry after a Stop', async () => {
    turnController.abort();
    const { adapter, calls } = makeFakeAdapter([
      { type: 'toolCalls', toolCalls: [call('c1')], text: '' },
    ]);
    const result = await runToolLoop(baseArgs(adapter));
    expect(result.reply).toBe(''); // caller substitutes its stock fallback
    expect(calls).toHaveLength(1);
  });

  it('stops mid-batch: remaining calls get paired cancelled results, no further rounds', async () => {
    // Round 1 emits three calls; the user hits Stop while the FIRST executes.
    const { adapter, calls } = makeFakeAdapter([
      { type: 'toolCalls', toolCalls: [call('c1'), call('c2'), call('c3')], text: 'working…' },
    ]);
    dispatchToolImpl = () => {
      turnController.abort(); // Stop arrives during tool #1
      return { ok: true, output: { ok: 1 } };
    };
    const result = await runToolLoop(baseArgs(adapter));
    expect(dispatchToolCalls).toHaveLength(1); // only tool #1 ran
    expect(calls).toHaveLength(1); // no round 2 against a dead signal
    expect(result.reply).toBe('working…');
    // The skipped calls are recorded as cancelled and stay PAIRED in the
    // transcript (providers reject unpaired tool_use on any later request).
    const cancelled = result.toolCalls.filter((t) => t.error === 'cancelled_by_user');
    expect(cancelled).toHaveLength(2);
    const toolMsgs = result.messages.filter(
      (m) => (m as { role: string }).role === 'tool',
    ) as Array<{ toolCallId: string; content: string }>;
    expect(toolMsgs.map((m) => m.toolCallId)).toEqual(['c1', 'c2', 'c3']);
    expect(toolMsgs[1]!.content).toContain('cancelled_by_user');
    expect(toolMsgs[2]!.content).toContain('cancelled_by_user');
  });

  it('a Stop after the batch finishes ends the turn before the next round', async () => {
    const { adapter, calls } = makeFakeAdapter([
      { type: 'toolCalls', toolCalls: [call('c1')], text: 'round one' },
      { type: 'text', text: 'never reached' },
    ]);
    let toolRuns = 0;
    dispatchToolImpl = () => {
      toolRuns += 1;
      turnController.abort(); // Stop during the batch's only (= last) call
      return { ok: true, output: { ok: 1 } };
    };
    const result = await runToolLoop(baseArgs(adapter));
    expect(toolRuns).toBe(1);
    expect(calls).toHaveLength(1); // round 2 never dispatched
    expect(result.reply).toBe('round one');
  });

  it('cancelled calls count as SKIPPED, never as failed (no red badge)', async () => {
    const { adapter } = makeFakeAdapter([
      { type: 'toolCalls', toolCalls: [call('c1'), call('c2'), call('c3')], text: 'working…' },
    ]);
    dispatchToolImpl = () => {
      turnController.abort();
      return { ok: true, output: { ok: 1 } };
    };
    const result = await runToolLoop(baseArgs(adapter));
    const stats = summarizeToolOutcomes(result.toolCalls);
    expect(stats.failed).toBe(0);
    expect(stats.skipped).toBe(2);
    expect(stats.succeeded).toBe(1);
    expect(stats.failures).toEqual([]);
  });

  it('a Stop in a prose-less round finalizes with the LAST round’s visible text', async () => {
    // Round 1 narrates then calls a tool; round 2 emits a bare tool call
    // (models usually skip prose mid-plan). Stop lands during round 2's tool.
    const { adapter } = makeFakeAdapter([
      { type: 'toolCalls', toolCalls: [call('c1')], text: 'Digging through your notes…' },
      { type: 'toolCalls', toolCalls: [call('c2')], text: '' },
    ]);
    let runs = 0;
    dispatchToolImpl = () => {
      runs += 1;
      if (runs === 2) turnController.abort();
      return { ok: true, output: { ok: 1 } };
    };
    const result = await runToolLoop(baseArgs(adapter));
    // Without the lastRoundText fallback this would be '' and reconcile would
    // blank the text the user was reading.
    expect(result.reply).toBe('Digging through your notes…');
  });

  it('does NOT fail over to the backup when the primary throws because of a Stop', async () => {
    turnController.abort();
    const abortErr = Object.assign(new Error('This operation was aborted'), {
      name: 'AbortError',
    });
    const primary: ChatDispatcher = {
      providerId: 'anthropic',
      adapterName: 'primary-chat',
      chat: vi.fn(async () => {
        throw abortErr;
      }),
    };
    const backupChat = vi.fn(async (): Promise<ChatResult> => {
      throw new Error('backup must never be dispatched on a user abort');
    });
    const backup: ChatDispatcher = {
      providerId: 'openrouter',
      adapterName: 'backup-chat',
      chat: backupChat,
    };
    await expect(
      runToolLoop({
        ...baseArgs(primary),
        backup: { adapter: backup, apiKey: 'k2', model: 'b-model' },
      }),
    ).rejects.toThrow(/aborted/);
    expect(backupChat).not.toHaveBeenCalled();
  });

  it('does not queue a requires_confirm pending row for a cancelled call', async () => {
    turnController.abort();
    const confirmTool = { ...fakeTool(), requiresConfirm: true } as Tool;
    const { adapter } = makeFakeAdapter([
      { type: 'toolCalls', toolCalls: [call('c1')], text: 'partial' },
    ]);
    const result = await runToolLoop({ ...baseArgs(adapter), tools: [confirmTool] });
    expect(result.reply).toBe('partial');
    expect(pendingInsertCount).toBe(0);
    expect(result.pendingIds).toEqual([]);
  });

  it('without a Stop the same script runs to completion (control)', async () => {
    const { adapter, calls } = makeFakeAdapter([
      { type: 'toolCalls', toolCalls: [call('c1')], text: '' },
      { type: 'text', text: 'final answer' },
    ]);
    const result = await runToolLoop(baseArgs(adapter));
    expect(result.reply).toBe('final answer');
    expect(dispatchToolCalls).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });
});
