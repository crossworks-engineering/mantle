/**
 * Unit tests for `recordMcpResponderTurn` (the `responder_turn_record` MCP
 * tool's engine). Pins the contract:
 *   (a) two turns written through recordTurn, inbound then outbound, channel
 *       'mcp', the outbound carrying the CLIENT's model and authorship;
 *   (b) a trace names who answered, with the inbound row as its subject;
 *   (c) no tool ledger (toolStats) is written: the client's tool list is kept
 *       as its claim only;
 *   (d) every refusal happens before anything is written: empty or long
 *       fields, a missing model, a team or client responder.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  agent: null as unknown,
  writes: [] as any[],
  traces: [] as any[],
}));

vi.mock('./run-sim-turn', () => ({
  resolveSimAgent: vi.fn(async () => {
    if (!h.agent) throw new Error('No enabled assistant agent.');
    return h.agent;
  }),
}));
vi.mock('./turn-input', () => ({
  assertOwnerTurnAgent: (agent: { slug: string }) => {
    if (agent.slug === 'team-responder') throw new Error('mirrors the owner turn only');
  },
}));
vi.mock('../agent', () => ({
  recordTurn: vi.fn(async (args: any) => {
    h.writes.push(args);
    return { id: `row-${h.writes.length}` };
  }),
}));
vi.mock('@mantle/tracing', () => ({
  startTrace: vi.fn(async (init: unknown, fn: () => Promise<unknown>) => {
    h.traces.push(init);
    return fn();
  }),
  currentTrace: vi.fn(() => ({ id: 'trace-rec' })),
}));

import { recordMcpResponderTurn } from './record-mcp-turn';

const AGENT = { id: 'agent-1', slug: 'assistant', name: 'Morph', model: 'grok' };

beforeEach(() => {
  h.agent = AGENT;
  h.writes = [];
  h.traces = [];
});

describe('recordMcpResponderTurn', () => {
  it('(a) writes the inbound then the outbound turn on channel mcp', async () => {
    const res = await recordMcpResponderTurn('owner-1', {
      message: ' What is Jev? ',
      reply: 'A typed-decision model.',
      model: 'claude-haiku-4-5',
      client: 'claude-code',
      inputTraceId: 'trace-in',
      toolsUsed: ['search_chunks'],
    });
    expect(h.writes).toHaveLength(2);
    expect(h.writes[0]).toEqual({
      ownerId: 'owner-1',
      agentId: 'agent-1',
      direction: 'inbound',
      text: 'What is Jev?',
      channel: 'mcp',
      data: { via: 'mcp', input_trace_id: 'trace-in' },
    });
    expect(h.writes[1]).toEqual({
      ownerId: 'owner-1',
      agentId: 'agent-1',
      direction: 'outbound',
      text: 'A typed-decision model.',
      channel: 'mcp',
      model: 'claude-haiku-4-5',
      data: {
        via: 'mcp',
        authored_by: { model: 'claude-haiku-4-5', client: 'claude-code' },
        input_trace_id: 'trace-in',
        mcp_tools: ['search_chunks'],
      },
    });
    expect(res).toEqual({
      agent: { slug: 'assistant', name: 'Morph' },
      inboundId: 'row-1',
      outboundId: 'row-2',
      traceId: 'trace-rec',
    });
  });

  it('(b) the trace names who answered, subject the inbound row', async () => {
    await recordMcpResponderTurn('owner-1', { message: 'q', reply: 'a', model: 'm' });
    expect(h.traces[0]).toMatchObject({
      kind: 'manual',
      subjectKind: 'assistant_message',
      subjectId: 'row-1',
      agentId: 'agent-1',
      data: {
        surface: 'mcp_turn_record',
        agent_slug: 'assistant',
        agent_model: 'grok',
        authored_by: { model: 'm', client: 'mcp' },
        outbound_id: 'row-2',
      },
    });
  });

  it('(c) writes no tool ledger, and no claim when none is given', async () => {
    await recordMcpResponderTurn('owner-1', { message: 'q', reply: 'a', model: 'm' });
    for (const w of h.writes) {
      expect(w.toolStats).toBeUndefined();
      expect(w.data.mcp_tools).toBeUndefined();
      expect(w.data.toolStats).toBeUndefined();
    }
  });

  it('(d) refuses before writing: empty fields, no model, long text', async () => {
    const bad = [
      { message: ' ', reply: 'a', model: 'm' },
      { message: 'q', reply: ' ', model: 'm' },
      { message: 'q', reply: 'a', model: ' ' },
      { message: 'x'.repeat(8001), reply: 'a', model: 'm' },
      { message: 'q', reply: 'x'.repeat(64_001), model: 'm' },
      { message: 'q', reply: 'a', model: 'm'.repeat(201) },
    ];
    for (const b of bad) {
      await expect(recordMcpResponderTurn('owner-1', b)).rejects.toThrow();
    }
    expect(h.writes).toHaveLength(0);
  });

  it('(d) refuses the team responder and a missing agent before writing', async () => {
    h.agent = { ...AGENT, slug: 'team-responder' };
    await expect(
      recordMcpResponderTurn('owner-1', { message: 'q', reply: 'a', model: 'm' }),
    ).rejects.toThrow(/owner turn only/);
    h.agent = null;
    await expect(
      recordMcpResponderTurn('owner-1', { message: 'q', reply: 'a', model: 'm' }),
    ).rejects.toThrow(/No enabled assistant agent/);
    expect(h.writes).toHaveLength(0);
  });
});
