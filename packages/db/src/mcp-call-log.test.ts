/**
 * The MCP call log's writer (Journal v3 J8, mcp-call-log.ts) with no
 * database: off until the process turns the audit on, bounded (a row past
 * the in-flight cap is dropped and counted, never queued), and a failed
 * insert is counted once, never retried, and never thrown to the caller.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startCallAudit, stopCallAudit } from './call-audit';
import {
  MCP_CALL_LOG_MAX_IN_FLIGHT,
  mcpCallLogStats,
  mcpCallsSettled,
  recordMcpCall,
  setMcpCallWriter,
  type McpCallEntry,
} from './mcp-call-log';

const entry: McpCallEntry = {
  loginId: null,
  via: 'stdio',
  workspaceId: null,
  tool: 'page_get',
  args: {},
  ok: true,
  error: null,
  durationMs: 1,
  itemIds: [],
  resultBytes: 2,
};

afterEach(async () => {
  await mcpCallsSettled();
  setMcpCallWriter(null);
  stopCallAudit();
  vi.restoreAllMocks();
});

describe('recordMcpCall', () => {
  it('writes nothing until the process turns the audit on', async () => {
    const write = vi.fn(async () => {});
    setMcpCallWriter(write);
    recordMcpCall(entry);
    expect(write).not.toHaveBeenCalled();
    startCallAudit({ sink: () => {} });
    recordMcpCall(entry);
    await mcpCallsSettled();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('drops and counts a row past the in-flight cap', async () => {
    startCallAudit({ sink: () => {} });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const write = vi.fn(() => gate);
    setMcpCallWriter(write);
    const before = mcpCallLogStats();
    for (let i = 0; i < MCP_CALL_LOG_MAX_IN_FLIGHT + 5; i++) recordMcpCall(entry);
    expect(write).toHaveBeenCalledTimes(MCP_CALL_LOG_MAX_IN_FLIGHT);
    expect(mcpCallLogStats().dropped - before.dropped).toBe(5);
    release();
    await mcpCallsSettled();
    expect(mcpCallLogStats().written - before.written).toBe(MCP_CALL_LOG_MAX_IN_FLIGHT);
  });

  it('a failed insert is counted, not retried, never thrown', async () => {
    startCallAudit({ sink: () => {} });
    const said = vi.spyOn(console, 'error').mockImplementation(() => {});
    const write = vi.fn(async () => {
      throw new Error('insert failed');
    });
    setMcpCallWriter(write);
    const before = mcpCallLogStats();
    expect(() => recordMcpCall(entry)).not.toThrow();
    expect(() => recordMcpCall(entry)).not.toThrow();
    await mcpCallsSettled();
    expect(write).toHaveBeenCalledTimes(2);
    expect(mcpCallLogStats().failed - before.failed).toBe(2);
    // Said at most once in ten minutes, not once per row.
    expect(said.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('a writer that throws at once is a failed row too', async () => {
    startCallAudit({ sink: () => {} });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setMcpCallWriter(() => {
      throw new Error('sync');
    });
    const before = mcpCallLogStats();
    expect(() => recordMcpCall(entry)).not.toThrow();
    await mcpCallsSettled();
    expect(mcpCallLogStats().failed - before.failed).toBe(1);
  });
});
