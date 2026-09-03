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

  it('importing the package index ARMS the bridge', async () => {
    // The load-bearing claim of the whole fix: pending.ts calls dispatchTool
    // through the bridge, and the bridge throws unless dispatch.ts has been
    // evaluated. Every real consumer reaches it by importing the index, so
    // that is what this asserts — not merely that the export exists, which
    // would still be true if the registration were deleted.
    const { hasToolDispatcher } = await import('./dispatch-bridge');
    expect(hasToolDispatcher(), 'nothing has loaded dispatch.ts yet').toBe(false);
    await import('./index');
    expect(hasToolDispatcher(), 'index.ts must load dispatch.ts').toBe(true);
  });

  it('reaching pending.ts through the index arms the bridge too', async () => {
    // The path that actually matters at runtime: telegram-poll imports
    // approvePendingCall from the package, taps Approve, and pending.ts
    // dispatches the parked tool.
    const { approvePendingCall } = await import('./index');
    const { hasToolDispatcher } = await import('./dispatch-bridge');
    expect(typeof approvePendingCall).toBe('function');
    expect(hasToolDispatcher()).toBe(true);
  });
});
