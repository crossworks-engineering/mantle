/**
 * withSpendTrace (dispatch.ts): a spending builtin called where no trace is
 * open (an app's broker, an MCP client) runs in a `tool_call` trace with one
 * step, so its provider usage lands where the cost screen sums. A free
 * builtin, an http tool, and a call already inside a trace or charged to one
 * run as they are.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const opened: Array<Record<string, unknown>> = [];
const steps: Array<Record<string, unknown>> = [];
const stepErrors: string[] = [];
let target: object | null = null;

vi.mock('@mantle/tracing', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  spendTarget: () => target,
  startTrace: async (init: Record<string, unknown>, fn: () => Promise<unknown>) => {
    opened.push(init);
    return fn();
  },
  step: async (init: Record<string, unknown>, fn: (h: unknown) => Promise<unknown>) => {
    steps.push(init);
    return fn({ setError: (m: string) => stepErrors.push(m), setMeta: () => {} });
  },
}));
vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  db: {},
  tools: {},
}));

import type { Tool } from '@mantle/db';
import { withSpendTrace } from './dispatch';
import { runCaller } from './gate-callers';
import type { ToolHandlerContext, ToolHandlerResult } from './types';

const CTX = { ownerId: 'o1' } as ToolHandlerContext;
const builtin = (slug: string): Tool =>
  ({ slug, handler: { kind: 'builtin', ref: slug } }) as unknown as Tool;
const ok = async (): Promise<ToolHandlerResult> => ({ ok: true, output: { text: 'hi' } });

beforeEach(() => {
  opened.length = 0;
  steps.length = 0;
  stepErrors.length = 0;
  target = null;
});

describe('withSpendTrace', () => {
  it('opens one tool_call trace with one llm_call step for a spending builtin outside a trace', async () => {
    const caller = runCaller();
    const r = await withSpendTrace(builtin('model_call'), CTX, caller, ok)();
    expect(r).toEqual({ ok: true, output: { text: 'hi' } });
    expect(opened).toEqual([
      {
        kind: 'tool_call',
        ownerId: 'o1',
        subjectKind: 'tool',
        data: { tool: 'model_call', entry: caller.entry, via: caller.via ?? null },
      },
    ]);
    expect(steps).toEqual([{ name: 'model_call', kind: 'llm_call', durable: false }]);
  });

  it('does so for every spending builtin, summarize_text and generate_image too', async () => {
    for (const slug of ['summarize_text', 'generate_image', 'extract_from_image']) {
      await withSpendTrace(builtin(slug), CTX, runCaller(), ok)();
    }
    expect(opened.map((t) => (t.data as { tool: string }).tool)).toEqual([
      'summarize_text',
      'generate_image',
      'extract_from_image',
    ]);
  });

  it("marks the step failed on a tool's refusal, and still answers it", async () => {
    const refused = async (): Promise<ToolHandlerResult> => ({ ok: false, error: 'no key' });
    const r = await withSpendTrace(builtin('model_call'), CTX, runCaller(), refused)();
    expect(r).toEqual({ ok: false, error: 'no key' });
    expect(stepErrors).toEqual(['no key']);
  });

  it('opens nothing inside a trace or a charge (the call is counted there)', async () => {
    target = { id: 'turn-trace' };
    const run = vi.fn(ok);
    expect(withSpendTrace(builtin('model_call'), CTX, runCaller(), run)).toBe(run);
    expect(opened).toEqual([]);
  });

  it('opens nothing for a free builtin or a non-builtin tool (an app polling writes no rows)', () => {
    const run = vi.fn(ok);
    const caller = runCaller();
    expect(withSpendTrace(builtin('table_list'), CTX, caller, run)).toBe(run);
    // search_chunks spends `model` (a cached query embedding), not the
    // owner's key: the most-called MCP tool writes no row per search.
    expect(withSpendTrace(builtin('search_chunks'), CTX, caller, run)).toBe(run);
    const http = {
      slug: 'weather',
      handler: { kind: 'http', url: 'https://x.test' },
    } as unknown as Tool;
    expect(withSpendTrace(http, CTX, caller, run)).toBe(run);
    expect(opened).toEqual([]);
  });
});
