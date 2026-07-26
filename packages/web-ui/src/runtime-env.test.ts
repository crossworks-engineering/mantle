import { afterEach, describe, expect, it, vi } from 'vitest';
import { isCrossOrigin, runtimeApiBase, serverUrl } from './runtime-env';

/**
 * The share-link origin bug this guards against was invisible in the
 * same-origin monolith and broke EVERY copied /s link the moment the owner UI
 * and the server became two apps: the link was built from the client's origin,
 * which does not serve /s at all.
 */

function withWindow(env: Record<string, unknown> | undefined, origin: string) {
  vi.stubGlobal('window', {
    __MANTLE_ENV__: env,
    location: { origin, href: `${origin}/team` },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('serverUrl', () => {
  it('points at the SERVER origin when the client is a separate app', () => {
    withWindow(
      { serverOrigin: 'https://brain.example.com', apiBase: 'https://brain.example.com' },
      'https://app.example.com',
    );
    expect(serverUrl('/s/abc123')).toBe('https://brain.example.com/s/abc123');
  });

  it('falls back to the API base when only that is configured', () => {
    withWindow({ apiBase: 'https://brain.example.com' }, 'https://app.example.com');
    expect(serverUrl('/s/abc123')).toBe('https://brain.example.com/s/abc123');
  });

  it('uses the current origin in the same-origin monolith', () => {
    withWindow({}, 'https://mantle.example.com');
    expect(serverUrl('/s/abc123')).toBe('https://mantle.example.com/s/abc123');
  });

  it('strips a trailing slash rather than emitting a double slash', () => {
    withWindow({ serverOrigin: 'https://brain.example.com/' }, 'https://app.example.com');
    expect(serverUrl('/s/abc123')).toBe('https://brain.example.com/s/abc123');
  });

  it('returns the bare path on the server, where there is no window', () => {
    expect(serverUrl('/s/abc123')).toBe('/s/abc123');
  });
});

/**
 * isCrossOrigin is the SPLIT detector. The bug it exists for: the default
 * deployment is ONE domain path-routed, but the client still ships an absolute
 * MANTLE_SERVER_ORIGIN (install.sh sets it unconditionally) — so "apiBase is
 * set" must NOT read as "the API is elsewhere". Every production box was
 * same-origin with apiBase set, and the old predicate disabled the inline
 * share reader + cookie auth on all of them.
 */
describe('isCrossOrigin', () => {
  it('false when no base is configured (monolith / detached-default)', () => {
    withWindow({}, 'https://mantle.example.com');
    expect(isCrossOrigin()).toBe(false);
  });

  it('false when the base is set but EQUALS the page origin (the default same-origin deploy)', () => {
    withWindow({ apiBase: 'https://mantle.example.com' }, 'https://mantle.example.com');
    expect(isCrossOrigin()).toBe(false);
  });

  it('true for a genuinely different host', () => {
    withWindow({ apiBase: 'https://brain.example.com' }, 'https://app.example.com');
    expect(isCrossOrigin()).toBe(true);
  });

  it('true for the same host on a different port (dev:fe against a local brain)', () => {
    withWindow({ apiBase: 'http://localhost:3000' }, 'http://localhost:3100');
    expect(isCrossOrigin()).toBe(true);
  });

  it('false on the server, where there is no window', () => {
    expect(isCrossOrigin()).toBe(false);
  });
});

describe('runtimeApiBase', () => {
  it('is empty for same-origin, so callers hit their own host', () => {
    withWindow({}, 'https://mantle.example.com');
    expect(runtimeApiBase()).toBe('');
  });

  it('strips a trailing slash', () => {
    withWindow({ apiBase: 'https://brain.example.com/' }, 'https://app.example.com');
    expect(runtimeApiBase()).toBe('https://brain.example.com');
  });
});
