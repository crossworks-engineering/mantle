/**
 * MCP wrapper tests for `ask_responder` — the thin boundary in front of
 * runSimulatedResponderTurn (which has its own unit tests in
 * @mantle/runtime/assistant). Pins the wrapper's own responsibilities: the
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
  inputResult: null as any,
  inputCalls: [] as any[],
  recordCalls: [] as any[],
}));

vi.mock('@mantle/runtime/assistant', () => ({
  runSimulatedResponderTurn: vi.fn(async (_owner: string, opts: unknown) => {
    h.simCalls.push(opts);
    return h.simResult;
  }),
  describeResponderTurnInput: vi.fn(async (_owner: string, opts: unknown) => {
    h.inputCalls.push(opts);
    return h.inputResult;
  }),
  recordMcpResponderTurn: vi.fn(async (_owner: string, opts: unknown) => {
    h.recordCalls.push(opts);
    return {
      agent: { slug: 'saskia', name: 'Saskia' },
      inboundId: 'in-1',
      outboundId: 'out-1',
      traceId: 'trace-rec',
    };
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
    registerTool: (name: string, _config: unknown, handler: Handler) => {
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
  h.inputCalls = [];
  h.inputResult = {
    agent: { slug: 'saskia', name: 'Saskia', model: 'm', provider: 'openrouter' },
    readOnly: false,
    messages: [
      { role: 'system', content: 'PERSONA', cached: true },
      { role: 'system', content: 'MAP', cached: true },
      { role: 'system', content: 'TIME', cached: false },
      { role: 'system', content: 'FACTS', cached: false },
      { role: 'user', content: 'hello', cached: false },
    ],
    tools: [
      { name: 'search_nodes', description: 'd', parameters: { type: 'object' } },
      { name: 'read_result', description: 'r', parameters: { type: 'object' } },
    ],
    loop: { maxIterations: 6 },
    context: { facts: 1 },
    traceId: 'trace-in',
    differences: ['x'],
  };
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

describe('ask_responder MCP tool', () => {
  it('is registered on the surface', () => {
    expect(handlerFor('ask_responder')).toBeTypeOf('function');
  });

  it('rejects an over-long message without calling the engine', async () => {
    const handler = handlerFor('ask_responder');
    const res = await handler({ message: 'x'.repeat(8001) });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/max 8000/);
    const { runSimulatedResponderTurn } = await import('@mantle/runtime/assistant');
    expect(runSimulatedResponderTurn).not.toHaveBeenCalled();
  });

  it('rejects an over-cap history (too many turns) without calling the engine', async () => {
    const handler = handlerFor('ask_responder');
    const history = Array.from({ length: 41 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: 'x',
    }));
    const res = await handler({ message: 'hi', history });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/max 40/);
    const { runSimulatedResponderTurn } = await import('@mantle/runtime/assistant');
    expect(runSimulatedResponderTurn).not.toHaveBeenCalled();
  });

  it('rejects an over-long history entry without calling the engine', async () => {
    const handler = handlerFor('ask_responder');
    const history = [{ role: 'user' as const, content: 'x'.repeat(8001) }];
    const res = await handler({ message: 'hi', history });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/max 8000/);
  });

  it('returns the reply + clipped tool_calls on the happy path', async () => {
    const handler = handlerFor('ask_responder');
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
    const handler = handlerFor('ask_responder');
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
    const handler = handlerFor('ask_responder');
    const out = parseReply(await handler({ message: 'hi' }));
    const args = out.tool_calls[0].args as string;
    expect(args.endsWith('…')).toBe(true);
    expect(args.length).toBeLessThanOrEqual(501); // 500 chars + ellipsis
  });

  it('forwards message + options to the engine', async () => {
    const handler = handlerFor('ask_responder');
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
    const { runSimulatedResponderTurn } = await import('@mantle/runtime/assistant');
    (runSimulatedResponderTurn as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('No enabled assistant agent'),
    );
    const handler = handlerFor('ask_responder');
    const res = await handler({ message: 'hi' });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/No enabled assistant agent/);
  });
});

describe('responder_turn_input MCP tool', () => {
  it('passes the message, history and narrowing to the engine', async () => {
    const res = await handlerFor('responder_turn_input')({
      message: 'hello',
      tools: 'full',
      agent_slug: 'saskia',
      history: [{ role: 'user', content: 'prior' }],
      exclude_tools: ['email_send'],
      read_only: true,
    });
    expect(res.isError).toBeUndefined();
    expect(h.inputCalls[0]).toEqual({
      message: 'hello',
      agentSlug: 'saskia',
      history: [{ role: 'user', content: 'prior' }],
      excludeToolSlugs: ['email_send'],
      readOnly: true,
    });
    const body = parseReply(res);
    expect(body.messages).toHaveLength(5);
    expect(body.tools.map((t: { name: string }) => t.name)).toEqual([
      'search_nodes',
      'read_result',
    ]);
    expect(body.trace_id).toBe('trace-in');
    expect(body.differences).toEqual(['x']);
  });

  it('omit_cached drops the cached prefix blocks and says how many', async () => {
    const body = parseReply(
      await handlerFor('responder_turn_input')({ message: 'hello', omit_cached: true }),
    );
    expect(body.messages.map((m: { content: string }) => m.content)).toEqual([
      'TIME',
      'FACTS',
      'hello',
    ]);
    expect(body.omitted_cached_blocks).toBe(2);
  });

  it('tools default to brief, and schemas_for fetches chosen full schemas', async () => {
    const body = parseReply(
      await handlerFor('responder_turn_input')({ message: 'hello', schemas_for: ['read_result'] }),
    );
    expect(body.tools).toEqual([
      { name: 'search_nodes', about: 'd' },
      { name: 'read_result', about: 'r' },
    ]);
    expect(body.schemas).toEqual([
      { name: 'read_result', description: 'r', parameters: { type: 'object' } },
    ]);
  });

  it('tools "names" and "none" shrink the tool part', async () => {
    const names = parseReply(
      await handlerFor('responder_turn_input')({ message: 'hello', tools: 'names' }),
    );
    expect(names.tools).toBeUndefined();
    expect(names.tool_names).toEqual(['search_nodes', 'read_result']);
    const none = parseReply(
      await handlerFor('responder_turn_input')({ message: 'hello', tools: 'none' }),
    );
    expect(none.tools).toBeUndefined();
    expect(none.tool_count).toBe(2);
  });

  it('rejects an over-cap transcript before the engine runs', async () => {
    const res = await handlerFor('responder_turn_input')({
      message: 'hello',
      history: Array.from({ length: 41 }, () => ({ role: 'user', content: 'x' })),
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/max 40/);
    expect(h.inputCalls).toHaveLength(0);
  });

  it('surfaces an engine error as an isError reply', async () => {
    const { describeResponderTurnInput } = await import('@mantle/runtime/assistant');
    (describeResponderTurnInput as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('answers team or client logins'),
    );
    const res = await handlerFor('responder_turn_input')({ message: 'hi' });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/responder_turn_input failed: answers team/);
  });
});

describe('responder_turn_record MCP tool', () => {
  beforeEach(() => {
    h.recordCalls = [];
  });

  it('passes the turn and its authorship to the engine and returns the row ids', async () => {
    const res = await handlerFor('responder_turn_record')({
      message: 'What is Jev?',
      reply: 'A typed-decision model.',
      model: 'claude-haiku-4-5',
      agent_slug: 'saskia',
      client: 'claude-code',
      input_trace_id: 'trace-in',
      tools_used: ['search_chunks'],
    });
    expect(res.isError).toBeUndefined();
    expect(h.recordCalls[0]).toEqual({
      message: 'What is Jev?',
      reply: 'A typed-decision model.',
      model: 'claude-haiku-4-5',
      agentSlug: 'saskia',
      client: 'claude-code',
      inputTraceId: 'trace-in',
      toolsUsed: ['search_chunks'],
    });
    expect(parseReply(res)).toEqual({
      recorded: true,
      agent: { slug: 'saskia', name: 'Saskia' },
      inbound_id: 'in-1',
      outbound_id: 'out-1',
      trace_id: 'trace-rec',
    });
  });

  it('surfaces a refusal as an isError reply', async () => {
    const { recordMcpResponderTurn } = await import('@mantle/runtime/assistant');
    (recordMcpResponderTurn as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('mirrors the owner turn only'),
    );
    const res = await handlerFor('responder_turn_record')({ message: 'q', reply: 'a', model: 'm' });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/responder_turn_record failed: mirrors the owner/);
  });

  it('ask_responder still records nothing', async () => {
    await handlerFor('ask_responder')({ message: 'hi' });
    expect(h.recordCalls).toHaveLength(0);
  });
});

describe('firstSentence', () => {
  it('keeps the first sentence and flattens whitespace', async () => {
    const { firstSentence } = await import('./register/responder');
    expect(firstSentence('Search the brain for nodes.\n  Returns ids. More text.')).toBe(
      'Search the brain for nodes.',
    );
    // A short lead ("e.g.") is not a sentence end.
    expect(firstSentence('Run it, e.g. on a table. Then more.')).toBe('Run it, e.g. on a table.');
    expect(firstSentence('x'.repeat(300))).toHaveLength(200);
  });
});
