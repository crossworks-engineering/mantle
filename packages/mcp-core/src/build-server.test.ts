/**
 * MCP wrapper tests for `respond_as_agent` — the thin boundary in front of
 * runSimulatedResponderTurn (which has its own unit tests in
 * @mantle/assistant-runtime). Pins the wrapper's own responsibilities: the
 * caller-held-history input caps (reject over-cap rather than silently
 * truncate), the include_tool_calls projection, and the arg-clipping — none of
 * which live in the engine.
 *
 * We register the whole tool surface onto a capturing fake server (the SDK
 * McpServer is not needed to test a handler) and drive the one handler directly.
 * runSimulatedResponderTurn is stubbed so the test touches no DB / model.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  simResult: null as any,
  simCalls: [] as any[],
}));

vi.mock('@mantle/assistant-runtime', () => ({
  runSimulatedResponderTurn: vi.fn(async (_owner: string, opts: unknown) => {
    h.simCalls.push(opts);
    return h.simResult;
  }),
}));

import { registerMantleTools } from './build-server';

type Handler = (
  args: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

/** Register the full surface onto a fake server and return the named handler. */
function handlerFor(slug: string): Handler {
  const handlers = new Map<string, Handler>();
  const fakeServer = {
    tool: (name: string, _desc: string, _schema: unknown, handler: Handler) => {
      handlers.set(name, handler);
    },
  };
  registerMantleTools(fakeServer as never, 'owner-1');
  const handler = handlers.get(slug);
  if (!handler) throw new Error(`handler ${slug} not registered`);
  return handler;
}

function parseReply(res: { content: Array<{ text: string }> }) {
  return JSON.parse(res.content[0]!.text);
}

beforeEach(() => {
  h.simCalls = [];
  h.simResult = {
    reply: 'hi there!',
    agent: { slug: 'saskia', model: 'anthropic/claude-sonnet-4.5' },
    toolCalls: [
      { slug: 'note_create', argsJson: '{"title":"x"}', durationMs: 5, status: 'ok', error: null },
    ],
    toolStats: { calls: 1, succeeded: 1, failed: 0, skipped: 0, queued: 0, failures: [] },
    pendingIds: ['pending-9'],
    traceId: 'trace-abc',
    emptyReplySubstituted: false,
  };
});

describe('respond_as_agent MCP tool', () => {
  it('is registered on the surface', () => {
    expect(handlerFor('respond_as_agent')).toBeTypeOf('function');
  });

  it('rejects an over-long message without calling the engine', async () => {
    const handler = handlerFor('respond_as_agent');
    const res = await handler({ message: 'x'.repeat(8001) });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/max 8000/);
    const { runSimulatedResponderTurn } = await import('@mantle/assistant-runtime');
    expect(runSimulatedResponderTurn).not.toHaveBeenCalled();
  });

  it('rejects an over-cap history (too many turns) without calling the engine', async () => {
    const handler = handlerFor('respond_as_agent');
    const history = Array.from({ length: 41 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: 'x',
    }));
    const res = await handler({ message: 'hi', history });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/max 40/);
    const { runSimulatedResponderTurn } = await import('@mantle/assistant-runtime');
    expect(runSimulatedResponderTurn).not.toHaveBeenCalled();
  });

  it('rejects an over-long history entry without calling the engine', async () => {
    const handler = handlerFor('respond_as_agent');
    const history = [{ role: 'user' as const, content: 'x'.repeat(8001) }];
    const res = await handler({ message: 'hi', history });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/max 8000/);
  });

  it('returns the reply + clipped tool_calls on the happy path', async () => {
    const handler = handlerFor('respond_as_agent');
    const res = await handler({ message: 'hi' });
    expect(res.isError).toBeUndefined();
    const out = parseReply(res);
    expect(out.reply).toBe('hi there!');
    expect(out.agent).toEqual({ slug: 'saskia', model: 'anthropic/claude-sonnet-4.5' });
    expect(out.pending_ids).toEqual(['pending-9']);
    expect(out.trace_id).toBe('trace-abc');
    expect(out.tool_calls).toEqual([
      { slug: 'note_create', status: 'ok', duration_ms: 5, args: '{"title":"x"}' },
    ]);
  });

  it('omits tool_calls when include_tool_calls is false', async () => {
    const handler = handlerFor('respond_as_agent');
    const res = await handler({ message: 'hi', include_tool_calls: false });
    const out = parseReply(res);
    expect(out.tool_calls).toBeUndefined();
    // Ledger + pending are still surfaced.
    expect(out.tool_stats).toMatchObject({ calls: 1 });
    expect(out.pending_ids).toEqual(['pending-9']);
  });

  it('clips a large tool arg payload to ~500 chars', async () => {
    h.simResult.toolCalls = [
      { slug: 'page_update', argsJson: 'A'.repeat(900), durationMs: 3, status: 'ok', error: null },
    ];
    const handler = handlerFor('respond_as_agent');
    const out = parseReply(await handler({ message: 'hi' }));
    const args = out.tool_calls[0].args as string;
    expect(args.endsWith('…')).toBe(true);
    expect(args.length).toBeLessThanOrEqual(501); // 500 chars + ellipsis
  });

  it('forwards message + options to the engine', async () => {
    const handler = handlerFor('respond_as_agent');
    await handler({
      message: 'do it',
      agent_slug: 'planner',
      history: [{ role: 'user', content: 'prior' }],
      exclude_tools: ['email_send'],
      max_iterations: 5,
    });
    expect(h.simCalls).toHaveLength(1);
    expect(h.simCalls[0]).toMatchObject({
      message: 'do it',
      agentSlug: 'planner',
      history: [{ role: 'user', content: 'prior' }],
      excludeToolSlugs: ['email_send'],
      maxIterations: 5,
    });
  });

  it('surfaces an engine error as an isError reply', async () => {
    const { runSimulatedResponderTurn } = await import('@mantle/assistant-runtime');
    (runSimulatedResponderTurn as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('No enabled assistant agent'),
    );
    const handler = handlerFor('respond_as_agent');
    const res = await handler({ message: 'hi' });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/No enabled assistant agent/);
  });
});
