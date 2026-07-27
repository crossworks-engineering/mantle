import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The owner plane's credential + asset behaviour across the three deployment
 * shapes, pinned at the exact case the e2e suite cannot reach.
 *
 * Both e2e topology projects run the client on :3901 against a server on
 * :3900, so `isCrossOrigin()` is TRUE in each and they only ever prove the
 * split path. The shape that actually changed here is the third one below —
 * ONE domain with an apiBase configured, which is the default production
 * deployment (install.sh + Caddyfile.same-origin: the client app always needs
 * an absolute MANTLE_SERVER_ORIGIN because its server-side fetches can't be
 * relative, so apiBase is SET and EQUALS the page origin).
 *
 * Under the old `apiBase set ⇒ split` test that box was misread as split:
 * owners were signed in bearer-only and held no session cookie, `withAuth`
 * refused to send cookies, and `assetUrl` signed every <img> src with a
 * short-lived `?at=` token — putting it in history and access logs for no
 * benefit. Everything worked, via the bearer; it was the wrong shape.
 */

function withWindow(env: Record<string, unknown> | undefined, origin: string) {
  vi.stubGlobal('window', {
    __MANTLE_ENV__: env,
    location: { origin, href: `${origin}/pages` },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  });
}

/** Fresh module instances per case — apiBase is read at call time, but the
 *  token store memoizes, and `upgradeOwnerCookie` holds a per-load memo. */
async function load() {
  vi.resetModules();
  return {
    ...(await import('./api-fetch')),
    ...(await import('./asset-url')),
  };
}

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('owner transport — same origin, apiBase SET (the default production box)', () => {
  const ORIGIN = 'https://mantle.example.com';

  it('sends cookies: the API is on this very origin, so it is not split', async () => {
    withWindow({ apiBase: ORIGIN, serverOrigin: ORIGIN }, ORIGIN);
    const { withAuth } = await load();
    expect(withAuth().credentials).toBe('include');
  });

  it('leaves asset paths alone rather than signing them with a token', async () => {
    withWindow({ apiBase: ORIGIN, serverOrigin: ORIGIN }, ORIGIN);
    const { assetUrl, setAssetToken } = await load();
    setAssetToken('short-lived-asset-token');
    // Unchanged path ⇒ the session cookie authenticates it, and no credential
    // ends up in the <img> src (and so in history / access logs).
    expect(assetUrl('/api/files/files/f1?raw=1')).toBe('/api/files/files/f1?raw=1');
  });
});

describe('owner transport — genuinely split (client and API on different origins)', () => {
  it('omits credentials: CORS here never allows them, by design', async () => {
    withWindow(
      { apiBase: 'https://brain.example.com', serverOrigin: 'https://brain.example.com' },
      'https://app.example.com',
    );
    const { withAuth } = await load();
    expect(withAuth().credentials).toBe('omit');
  });

  it('signs asset srcs, which cannot carry an Authorization header', async () => {
    withWindow(
      { apiBase: 'https://brain.example.com', serverOrigin: 'https://brain.example.com' },
      'https://app.example.com',
    );
    const { assetUrl, setAssetToken } = await load();
    setAssetToken('tok123');
    expect(assetUrl('/api/files/files/f1?raw=1')).toBe(
      'https://brain.example.com/api/files/files/f1?raw=1&at=tok123',
    );
  });
});

describe('owner transport — plain monolith (no apiBase at all)', () => {
  it('is untouched: cookies, bare asset paths', async () => {
    withWindow({}, 'https://mantle.example.com');
    const { withAuth, assetUrl } = await load();
    expect(withAuth().credentials).toBe('include');
    expect(assetUrl('/api/files/files/f1?raw=1')).toBe('/api/files/files/f1?raw=1');
  });
});

describe('upgradeOwnerCookie', () => {
  const ORIGIN = 'https://mantle.example.com';

  it('does nothing without a stored bearer — a cookie session has nothing to upgrade', async () => {
    withWindow({ apiBase: ORIGIN, serverOrigin: ORIGIN }, ORIGIN);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { upgradeOwnerCookie } = await load();

    await upgradeOwnerCookie();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does nothing cross-origin — there the bearer IS the credential', async () => {
    withWindow(
      { apiBase: 'https://brain.example.com', serverOrigin: 'https://brain.example.com' },
      'https://app.example.com',
    );
    vi.stubGlobal('window', {
      __MANTLE_ENV__: { apiBase: 'https://brain.example.com' },
      location: { origin: 'https://app.example.com', href: 'https://app.example.com/pages' },
      localStorage: { getItem: () => 'a-stored-bearer', setItem: () => {}, removeItem: () => {} },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { upgradeOwnerCookie } = await load();

    await upgradeOwnerCookie();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('upgrades a same-origin bearer-only session, sending the bearer to prove it', async () => {
    vi.stubGlobal('window', {
      __MANTLE_ENV__: { apiBase: ORIGIN, serverOrigin: ORIGIN },
      location: { origin: ORIGIN, href: `${ORIGIN}/pages` },
      localStorage: { getItem: () => 'a-stored-bearer', setItem: () => {}, removeItem: () => {} },
    });
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const { upgradeOwnerCookie } = await load();

    await upgradeOwnerCookie();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${ORIGIN}/api/auth/sso`);
    expect(init.method).toBe('POST');
    // The bearer is the credential being exchanged; the cookie it mints is
    // what the browser-native loaders will use.
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer a-stored-bearer');
    expect(init.credentials).toBe('include');
  });

  it('fires at most once per page load, however many callers ask', async () => {
    vi.stubGlobal('window', {
      __MANTLE_ENV__: { apiBase: ORIGIN, serverOrigin: ORIGIN },
      location: { origin: ORIGIN, href: `${ORIGIN}/pages` },
      localStorage: { getItem: () => 'a-stored-bearer', setItem: () => {}, removeItem: () => {} },
    });
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const { upgradeOwnerCookie } = await load();

    await Promise.all([upgradeOwnerCookie(), upgradeOwnerCookie(), upgradeOwnerCookie()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
