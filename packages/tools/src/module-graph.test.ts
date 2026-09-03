/**
 * The builtin registry closes a cycle if anything on the pending path imports
 * dispatch.ts statically:
 *   builtins-pending -> pending -> dispatch -> registry -> builtins -> builtins-pending
 * Production survived only because index.ts happens to export dispatch.ts
 * before anything reaches builtins.ts; import builtins.ts on its own and the
 * registry ran its `for (const def of BUILTIN_TOOLS)` against an uninitialised
 * binding. pending.ts now goes through dispatch-bridge.ts instead.
 * (2026-09-03 audit-of-audit, "registry cycle re-closed".)
 *
 * Each case resets the module registry so the named module really is the first
 * one evaluated, which is the only ordering the cycle shows up in.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

describe('module graph', () => {
  it('builtins.ts can be imported first', async () => {
    const mod = await import('./builtins');
    expect(Array.isArray(mod.BUILTIN_TOOLS)).toBe(true);
    expect(mod.BUILTIN_TOOLS.length).toBeGreaterThan(0);
  });

  it('registry.ts can be imported first', async () => {
    const mod = await import('./registry');
    expect(mod.getBuiltin('page_create')).toBeTruthy();
  });

  it('pending.ts can be imported first', async () => {
    const mod = await import('./pending');
    expect(typeof mod.approvePendingCall).toBe('function');
  });

  it('builtins-pending.ts can be imported first', async () => {
    const mod = await import('./builtins-pending');
    expect(Array.isArray(mod.PENDING_TOOLS)).toBe(true);
  });

  it('index.ts still registers the dispatcher for the bridge', async () => {
    const mod = await import('./index');
    expect(typeof mod.dispatchTool).toBe('function');
  });
});
