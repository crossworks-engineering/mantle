/**
 * The gate has production callers (arch A4 step 1: every routed HTTP
 * request runs through enterCall), so a gate that is not ready stops the
 * boot: ensureGateReady throws, it never logs and starts. Its own file: the
 * gate's readiness check is stubbed to fail here.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@mantle/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@mantle/db')>();
  return {
    ...orig,
    assertGateReady: () => {
      throw new orig.GateNotReadyError(['key']);
    },
  };
});

import { GATE_HAS_PRODUCTION_CALLERS, ensureGateReady } from './gate-narrowers';

describe('a gate that is not ready stops the boot', () => {
  it('the gate has production callers', () => {
    expect(GATE_HAS_PRODUCTION_CALLERS).toBe(true);
  });

  it('ensureGateReady throws the not-ready error instead of starting the process', () => {
    expect(() => ensureGateReady()).toThrow(
      /the gate is not ready: no narrower registered for key/,
    );
  });
});
