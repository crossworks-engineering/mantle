import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The token-endpoint calls. Two behaviours here decide whether a connected
 * account survives, so they're pinned:
 *
 *   - `refreshTokens` must NOT send a `scope` parameter. Azure only accepts
 *     scopes that are a subset of what the user consented to; sending the
 *     app's *current* scope list meant that every time a new scope was added
 *     (Mail.Send, 0.19.x), accounts connected before it became unrefreshable
 *     — `AADSTS65001`, dead at the next access-token expiry. The authorize +
 *     code-exchange legs still ask for the full set, which is where consent
 *     actually happens.
 *   - an `invalid_grant` answer must surface as `status: 401`, so callers
 *     (the drive browser, the sync workers) can tell "reconnect the account"
 *     apart from a transient Graph failure worth retrying.
 *
 * Seam: global fetch. Everything else is real.
 */

import { exchangeCode, refreshTokens, type MsAuthError, type MsOAuthConfig } from './index';

const cfg: MsOAuthConfig = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  tenant: 'tenant-id',
  redirectUri: 'https://brain.example.com/api/microsoft/oauth/callback',
};

const fetchMock = vi.fn();

/** The form body of call `i`, parsed. */
function bodyOf(i: number): URLSearchParams {
  const call = fetchMock.mock.calls[i];
  if (!call) throw new Error(`expected a fetch call at ${i}`);
  return call[1].body as URLSearchParams;
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('refreshTokens', () => {
  it('sends no scope parameter, so a widened app scope list cannot orphan an older account', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        access_token: 'at',
        expires_in: 3600,
        refresh_token: 'rt-rotated',
        scope: 'Files.Read.All Sites.Read.All',
        token_type: 'Bearer',
      }),
    );

    const set = await refreshTokens(cfg, 'rt-old');

    const body = bodyOf(0);
    expect(body.has('scope')).toBe(false);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('rt-old');
    // The granted set comes back on the response — that's what gates send.
    expect(set.scope).toBe('Files.Read.All Sites.Read.All');
    expect(set.refreshToken).toBe('rt-rotated');
  });

  it('reports invalid_grant as 401 so callers prompt a reconnect instead of retrying', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: 'invalid_grant',
          error_description: 'AADSTS65001: The user or administrator has not consented…',
        },
        400,
      ),
    );

    const err = await refreshTokens(cfg, 'rt-dead').then(
      () => {
        throw new Error('expected the refresh to reject');
      },
      (e: MsAuthError) => e,
    );

    expect(err.status).toBe(401);
    expect(err.oauthError).toBe('invalid_grant');
    expect(err.message).toContain('AADSTS65001');
  });

  it('reports a non-grant failure with its HTTP status, not 401', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'temporarily_unavailable', error_description: 'try later' }, 503),
    );

    const err = await refreshTokens(cfg, 'rt').then(
      () => {
        throw new Error('expected the refresh to reject');
      },
      (e: MsAuthError) => e,
    );

    expect(err.status).toBe(503);
  });
});

describe('exchangeCode', () => {
  it('still asks for the full app scope list — consent happens on this leg', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ access_token: 'at', expires_in: 3600, scope: 'x', token_type: 'Bearer' }),
    );

    await exchangeCode(cfg, { code: 'code', verifier: 'verifier' });

    const scope = bodyOf(0).get('scope') ?? '';
    expect(scope).toContain('offline_access');
    expect(scope).toContain('Files.Read.All');
    expect(scope).toContain('Mail.Send');
  });
});
