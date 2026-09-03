/**
 * The one rule this file exists for: a chat round that has already streamed
 * tokens to the user must NOT be replayed on the backup route.
 *
 * The failover is otherwise correct and worth keeping — a route that is down,
 * rate-limited or 5xx-ing should hand the turn to the backup. But the streaming
 * path has a second, common way to fail: the stream's own idle guard
 * (voice/adapters/sse.ts) raises a `TimeoutError` when a provider goes quiet
 * mid-answer, and `classifyChatError` calls that retryable. Before 2026-09-03
 * that ran the backup for the same round, so the client rendered the primary's
 * partial answer and then the backup's whole answer underneath it.
 *
 * The discriminator is whether a delta actually REACHED a client, which is what
 * `emitTurnDelta` now reports: it returns false when there is no observer, and
 * false for a delegated sub-agent (whose tokens are internal). Those are exactly
 * the cases where a replay is invisible, so those keep their failover.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  isTurnStreaming: vi.fn(() => true),
  emitTurnDelta: vi.fn(() => true),
  currentTurnAbortSignal: vi.fn(() => undefined),
  setMeta: vi.fn(),
}));

vi.mock('@mantle/tracing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/tracing')>();
  return {
    ...actual,
    isTurnStreaming: h.isTurnStreaming,
    emitTurnDelta: h.emitTurnDelta,
    currentTurnAbortSignal: h.currentTurnAbortSignal,
    // Run the body straight through with a handle the caller can assert on.
    step: vi.fn(async (_spec: unknown, fn: (handle: unknown) => Promise<unknown>) =>
      fn({
        setMeta: h.setMeta,
        setOutput: vi.fn(),
        addTokens: vi.fn(),
        addCost: vi.fn(),
      }),
    ),
  };
});
vi.mock('../llm-usage', () => ({ recordChatUsage: vi.fn() }));

import { createModelCaller } from './model-caller';
import type { ToolLoopArgs } from '../tool-loop';

/** A route whose chatStream emits `deltas` text chunks and then throws. */
function failingRoute(name: string, deltas: string[], err: Error) {
  return {
    adapterName: name,
    providerId: name,
    chat: vi.fn(async () => ({ text: `${name} one-shot`, model: 'm' })),
    chatStream: vi.fn(async (_o: unknown, sink: (d: { type: string; text: string }) => void) => {
      for (const text of deltas) sink({ type: 'text', text });
      throw err;
    }),
  };
}

/** A route that streams one chunk and resolves. */
function okRoute(name: string) {
  return {
    adapterName: name,
    providerId: name,
    chat: vi.fn(async () => ({ text: `${name} one-shot`, model: 'm' })),
    chatStream: vi.fn(async (_o: unknown, sink: (d: { type: string; text: string }) => void) => {
      sink({ type: 'text', text: `${name} answer` });
      return { text: `${name} answer`, model: 'm', tokensOut: 3 };
    }),
  };
}

/** A `TimeoutError`, the shape the stream idle guard raises. classifyChatError
 *  keys on the NAME, so this is genuinely classified retryable. */
const idleTimeout = (): Error =>
  Object.assign(new Error('chat stream idle after 120000ms of silence'), {
    name: 'TimeoutError',
  });

function caller(primary: ReturnType<typeof okRoute>, backup: ReturnType<typeof okRoute>) {
  const args = {
    adapter: primary,
    apiKey: 'k',
    model: 'primary-model',
    backup: { adapter: backup, apiKey: 'k2', model: 'backup-model' },
    params: {},
    ownerId: 'o1',
  } as unknown as ToolLoopArgs;
  return createModelCaller({ args, messages: [], toolsForModel: [], turnAborted: () => false });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.isTurnStreaming.mockReturnValue(true);
  h.emitTurnDelta.mockReturnValue(true);
  h.currentTurnAbortSignal.mockReturnValue(undefined);
});

describe('failover after a round has streamed', () => {
  it('does NOT run the backup once deltas reached the client', async () => {
    const primary = failingRoute('primary', ['Here is the ans'], idleTimeout());
    const backup = okRoute('backup');
    await expect(caller(primary, backup).round(0)).rejects.toThrow(/idle/);
    // The whole point: the user keeps the partial answer they can see, and no
    // second answer is streamed underneath it.
    expect(backup.chatStream).not.toHaveBeenCalled();
    expect(backup.chat).not.toHaveBeenCalled();
    expect(h.setMeta).toHaveBeenCalledWith({ failover_skipped: 'deltas_already_streamed' });
  });

  it('still fails over when the route died BEFORE any delta', async () => {
    // Same retryable error, nothing on screen — this is the case the failover
    // was built for, and it has to keep working.
    const primary = failingRoute('primary', [], idleTimeout());
    const backup = okRoute('backup');
    const res = await caller(primary, backup).round(0);
    expect(res.text).toBe('backup answer');
    expect(backup.chatStream).toHaveBeenCalledTimes(1);
    expect(h.setMeta).not.toHaveBeenCalledWith({
      failover_skipped: 'deltas_already_streamed',
    });
  });

  it('still fails over when the deltas went nowhere (no observer / sub-agent)', async () => {
    // emitTurnDelta reports false when there is no turn observer, and for a
    // delegated sub-agent whose tokens never reach the user. A replay there is
    // invisible, so the failover must survive.
    h.emitTurnDelta.mockReturnValue(false);
    const primary = failingRoute('primary', ['internal tokens'], idleTimeout());
    const backup = okRoute('backup');
    const res = await caller(primary, backup).round(0);
    expect(res.text).toBe('backup answer');
    expect(backup.chatStream).toHaveBeenCalledTimes(1);
  });

  it('leaves a non-retryable failure alone whether or not it streamed', async () => {
    // A 4xx would fail identically on the backup; the streamed check must not
    // change that verdict, only narrow the retryable one.
    const primary = failingRoute('primary', ['partial'], new Error('400 bad request'));
    const backup = okRoute('backup');
    await expect(caller(primary, backup).round(0)).rejects.toThrow(/bad request/);
    expect(backup.chatStream).not.toHaveBeenCalled();
  });
});
