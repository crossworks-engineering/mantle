/**
 * Tests for the in-memory fixed-window rate limiter that guards
 * /api/auth/login + /api/auth/change-password. Verifies:
 *
 *   - Allow up to `max`, deny on N+1.
 *   - Window resets after `windowMs`.
 *   - Different keys are independent.
 *   - retryAfterSec shrinks as we approach the window boundary.
 *   - clientIp() trusts x-forwarded-for, falls back to x-real-ip,
 *     defaults to "unknown" so the limiter still has a key.
 *
 * Uses vi.useFakeTimers so we don't actually sleep through a window.
 * `rateLimit` reads Date.now(); vitest's fake-timer toolkit covers
 * that without monkey-patching.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Each test wants a fresh in-memory bucket map. The module's `buckets`
// is module-scoped, so we resetModules + re-import per test. Cheap.
async function freshLimiter() {
  vi.resetModules();
  return (await import('./rate-limit')) as typeof import('./rate-limit');
}

describe('rateLimit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-20T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows up to max, denies the next', async () => {
    const { rateLimit } = await freshLimiter();
    for (let i = 0; i < 3; i++) {
      expect(rateLimit('k', { max: 3, windowMs: 60_000 }).ok).toBe(true);
    }
    expect(rateLimit('k', { max: 3, windowMs: 60_000 }).ok).toBe(false);
  });

  it('reports remaining tokens correctly', async () => {
    const { rateLimit } = await freshLimiter();
    expect(rateLimit('k', { max: 3, windowMs: 60_000 }).remaining).toBe(2);
    expect(rateLimit('k', { max: 3, windowMs: 60_000 }).remaining).toBe(1);
    expect(rateLimit('k', { max: 3, windowMs: 60_000 }).remaining).toBe(0);
    expect(rateLimit('k', { max: 3, windowMs: 60_000 }).remaining).toBe(0);
  });

  it('returns Retry-After-friendly seconds', async () => {
    const { rateLimit } = await freshLimiter();
    rateLimit('k', { max: 1, windowMs: 60_000 });
    const denied = rateLimit('k', { max: 1, windowMs: 60_000 });
    expect(denied.ok).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThan(0);
    expect(denied.retryAfterSec).toBeLessThanOrEqual(60);
  });

  it('starts a fresh window after windowMs elapses', async () => {
    const { rateLimit } = await freshLimiter();
    rateLimit('k', { max: 1, windowMs: 60_000 });
    expect(rateLimit('k', { max: 1, windowMs: 60_000 }).ok).toBe(false);

    // Jump 61 seconds — past the window boundary.
    vi.advanceTimersByTime(61_000);
    expect(rateLimit('k', { max: 1, windowMs: 60_000 }).ok).toBe(true);
  });

  it('keeps separate counts for different keys', async () => {
    const { rateLimit } = await freshLimiter();
    rateLimit('a', { max: 1, windowMs: 60_000 });
    // a is now exhausted; b is fresh.
    expect(rateLimit('a', { max: 1, windowMs: 60_000 }).ok).toBe(false);
    expect(rateLimit('b', { max: 1, windowMs: 60_000 }).ok).toBe(true);
  });

  it('floors retryAfterSec at 1 even right at the boundary', async () => {
    const { rateLimit } = await freshLimiter();
    rateLimit('k', { max: 1, windowMs: 1_000 });
    // Advance to 999ms in — still inside the window.
    vi.advanceTimersByTime(999);
    const denied = rateLimit('k', { max: 1, windowMs: 1_000 });
    expect(denied.ok).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThanOrEqual(1);
  });
});

describe('clientIp', () => {
  function makeReq(headers: Record<string, string>): Request {
    return new Request('http://example/', { headers });
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // X-Forwarded-For is `client, proxy1, …, ourProxy`. The leftmost entry is
  // client-supplied and forgeable, so clientIp keys on the entry our nearest
  // trusted proxy (Caddy) appended — the RIGHTMOST, counting MANTLE_TRUSTED_PROXIES
  // hops (default 1). NOTE: asserting the leftmost here would only "pass" by
  // reverting clientIp to the spoofable behavior — i.e. re-opening a login/signup
  // rate-limit bypass. These assertions must stay on the rightmost entry.
  it('uses the rightmost (trusted-proxy) entry, not the spoofable leftmost', async () => {
    const { clientIp } = await freshLimiter();
    const req = makeReq({ 'x-forwarded-for': '203.0.113.5, 10.0.0.2, 10.0.0.3' });
    expect(clientIp(req)).toBe('10.0.0.3');
  });

  it('trims whitespace around the chosen entry', async () => {
    const { clientIp } = await freshLimiter();
    const req = makeReq({ 'x-forwarded-for': '10.0.0.1,  198.51.100.10  ' });
    expect(clientIp(req)).toBe('198.51.100.10');
  });

  it('honours MANTLE_TRUSTED_PROXIES to count more hops from the right', async () => {
    vi.stubEnv('MANTLE_TRUSTED_PROXIES', '2');
    const { clientIp } = await freshLimiter();
    const req = makeReq({ 'x-forwarded-for': '203.0.113.5, 10.0.0.2, 10.0.0.3' });
    // Two trusted hops → second entry from the right.
    expect(clientIp(req)).toBe('10.0.0.2');
  });

  it('falls back to x-real-ip if x-forwarded-for is absent', async () => {
    const { clientIp } = await freshLimiter();
    const req = makeReq({ 'x-real-ip': '198.51.100.20' });
    expect(clientIp(req)).toBe('198.51.100.20');
  });

  it('returns "unknown" when neither header is present', async () => {
    const { clientIp } = await freshLimiter();
    const req = makeReq({});
    expect(clientIp(req)).toBe('unknown');
  });
});
