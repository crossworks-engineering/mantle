/**
 * A call nested in a /api/v1 route's call (A5 step 5, carried from the
 * step 4 re-audit): it names its own entry, not `api-v1`. Only the route's
 * own call throws a handler's error, or the database's refusal, on to
 * app.onError; a nested call answers it as the call's text, which the
 * outer handler reads, as a run's nested call does. Before, a nested call
 * kept the entry and threw past the outer handler.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Tool } from '@mantle/db';
import { dispatchTool } from './dispatch';
import { apiV1Caller, nestedToolCaller, runCaller, type ToolCaller } from './gate-callers';
import { registerBuiltin } from './registry';
import { ensureGateReady } from './gate-narrowers';
import type { BuiltinToolDef, ToolHandlerResult } from './types';

const row = (slug: string) =>
  ({ slug, handler: { kind: 'builtin', ref: slug } }) as unknown as Tool;

const seen: { nestedCaller: ToolCaller | null; inner: ToolHandlerResult | null }[] = [];

const POLICY = { effect: 'write', spends: 'none', scope: 'any' } as const;

const inner: BuiltinToolDef = {
  slug: 'v1_nested_inner',
  name: 'v1_nested_inner',
  description: 'probe',
  inputSchema: { type: 'object', properties: {} },
  policy: POLICY,
  handler: async () => {
    throw new Error('inner broke');
  },
};

const outer: BuiltinToolDef = {
  slug: 'v1_nested_outer',
  name: 'v1_nested_outer',
  description: 'probe',
  inputSchema: { type: 'object', properties: {} },
  policy: POLICY,
  handler: async (_input, ctx) => {
    const res = await dispatchTool(row('v1_nested_inner'), {}, ctx);
    seen.push({ nestedCaller: ctx.caller ?? null, inner: res });
    return { ok: true, output: { inner: res } };
  },
};

beforeAll(() => {
  ensureGateReady();
  registerBuiltin(inner);
  registerBuiltin(outer);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterAll(() => {
  seen.length = 0;
});

describe('a call nested in a /api/v1 route call', () => {
  it('names its own entry, a process call; the route call keeps api-v1', () => {
    const nested = nestedToolCaller(apiV1Caller());
    expect(nested.entry).toBe('api-v1-nested');
    expect(nested.via).toBe('process');
    expect(apiV1Caller().entry).toBe('api-v1');
    expect(nestedToolCaller(runCaller())).toBe(runCaller());
  });

  it('answers a throw as the call text for the outer handler, never past it', async () => {
    seen.length = 0;
    const res = await dispatchTool(
      row('v1_nested_outer'),
      {},
      { ownerId: 'o', surface: { kind: 'owner', via: 'api' }, caller: apiV1Caller() },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.nestedCaller?.entry).toBe('api-v1-nested');
    expect(seen[0]!.inner).toEqual({ ok: false, error: 'inner broke' });
    expect(res).toEqual({ ok: true, output: { inner: { ok: false, error: 'inner broke' } } });
  });

  it('the route call itself still throws on to app.onError', async () => {
    await expect(
      dispatchTool(
        row('v1_nested_inner'),
        {},
        { ownerId: 'o', surface: { kind: 'owner', via: 'api' }, caller: apiV1Caller() },
      ),
    ).rejects.toThrow('inner broke');
  });
});
