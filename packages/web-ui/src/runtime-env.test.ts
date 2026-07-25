import { afterEach, describe, expect, it, vi } from 'vitest';
import { runtimeApiBase, serverUrl } from './runtime-env';

/**
 * The share-link origin bug this guards against was invisible in the
 * same-origin monolith and broke EVERY copied /s link the moment the owner UI
 * and the server became two apps: the link was built from the client's origin,
 * which does not serve /s at all.
 */

function withWindow(env: Record<string, unknown> | undefined, origin: string) {
  vi.stubGlobal('window', {
    __MANTLE_ENV__: env,
    location: { origin },
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
