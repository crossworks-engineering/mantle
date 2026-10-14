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
import { DATABASE_ERROR_PUBLIC } from '@mantle/std';
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

/** A nested call whose handler meets a drizzle error (SQL and params). */
const innerDb: BuiltinToolDef = {
  ...inner,
  slug: 'v1_nested_inner_db',
  name: 'v1_nested_inner_db',
  handler: async () => {
    throw Object.assign(new Error('Failed query: select "secret" from "nodes"\nparams: 4f1c'), {
      cause: Object.assign(new Error('deadlock detected'), { code: '40P01', severity: 'ERROR' }),
    });
  },
};

const outerDb: BuiltinToolDef = {
  ...outer,
  slug: 'v1_nested_outer_db',
  name: 'v1_nested_outer_db',
  // A handler that answers a nested refusal as its own: the route reads it
  // as the 400 body.
  handler: async (_input, ctx) => dispatchTool(row('v1_nested_inner_db'), {}, ctx),
};

beforeAll(() => {
  ensureGateReady();
  registerBuiltin(inner);
  registerBuiltin(outer);
  registerBuiltin(innerDb);
  registerBuiltin(outerDb);
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

  it("a nested call's database error is the one mapper's words, never its SQL (fix round 1, L3)", async () => {
    const res = await dispatchTool(
      row('v1_nested_outer_db'),
      {},
      { ownerId: 'o', surface: { kind: 'owner', via: 'api' }, caller: apiV1Caller() },
    );
    expect(res).toEqual({ ok: false, error: DATABASE_ERROR_PUBLIC });
  });
});
