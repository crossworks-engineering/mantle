import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '../lib/fixtures';
import { TEAM_TOKEN_STORAGE_KEY } from '../lib/contract';
import { CLIENT_URL } from '../lib/env';

/**
 * The member carve's credential plumbing (T1–T4): the contact team token
 * exchanges for a SIGNED bearer, the bearer authenticates /api/team/* and the
 * workspace with no cookie anywhere, the SSO handoff turns it back into a
 * server-origin cookie for share reading, and the /s app brokers answer CORS
 * preflights for the client origin.
 */
test.describe('team bearer (split member carve)', () => {
  /** Mint a member (contact + team token), returning ids for cleanup. */
  async function mintMember(ownerApi: APIRequestContext) {
    const created = await ownerApi.post('/api/contacts', {
      data: { first_name: 'E2E', last_name: `Bearer ${Date.now()}` },
    });
    expect(created.ok()).toBeTruthy();
    const cBody = (await created.json()) as { contact?: { id?: string }; id?: string };
    const contactId = (cBody.contact?.id ?? cBody.id)!;
    const minted = await ownerApi.post(`/api/contacts/${contactId}/team`, {
      data: { action: 'enable' },
    });
    expect(minted.ok()).toBeTruthy();
    const { token } = (await minted.json()) as { token: string };
    return { contactId, token };
  }

  async function cleanup(ownerApi: APIRequestContext, contactId: string) {
    await ownerApi.post(`/api/contacts/${contactId}/team`, { data: { action: 'disable' } });
    await ownerApi.delete(`/api/contacts/${contactId}`);
  }

  test('the token exchanges for a bearer that authenticates /api/team/*', async ({
    ownerApi,
    visitorPage,
    serverURL,
  }) => {
    const { contactId, token } = await mintMember(ownerApi);
    try {
      // Exchange (mode:'bearer') — no Set-Cookie, credential in the body.
      const exchange = await visitorPage.request.post(`${serverURL}/api/team/auth`, {
        data: { token, mode: 'bearer' },
      });
      expect(exchange.ok()).toBeTruthy();
      expect(exchange.headers()['set-cookie']).toBeUndefined();
      const { teamToken, expiresAt } = (await exchange.json()) as {
        teamToken?: string;
        expiresAt?: number;
      };
      expect(teamToken).toBeTruthy();
      expect(expiresAt ?? 0).toBeGreaterThan(Date.now() / 1000);

      // The signed bearer opens the gated API with no cookie jar at all.
      const ws = await visitorPage.request.get(`${serverURL}/api/team/workspace`, {
        headers: { Authorization: `Bearer ${teamToken}` },
      });
      expect(ws.ok()).toBeTruthy();
      const body = (await ws.json()) as { counts?: Record<string, number> };
      expect(body.counts).toBeTruthy();

      // A garbage bearer stays out (and never falls through to cookies).
      const bad = await visitorPage.request.get(`${serverURL}/api/team/workspace`, {
        headers: { Authorization: 'Bearer not-a-real-credential' },
      });
      expect(bad.status()).toBe(401);
    } finally {
      await cleanup(ownerApi, contactId);
    }
  });

  test('a stored bearer renders the workspace cookie-free', async ({
    ownerApi,
    visitorPage,
    serverURL,
  }) => {
    const { contactId, token } = await mintMember(ownerApi);
    try {
      const exchange = await visitorPage.request.post(`${serverURL}/api/team/auth`, {
        data: { token, mode: 'bearer' },
      });
      const { teamToken } = (await exchange.json()) as { teamToken: string };

      // Land on the FINAL origin first (the server stub may redirect), then
      // seed the contract key and reload — the shell must boot straight into
      // the workspace, no gate, with zero cookies involved.
      await visitorPage.goto(`${CLIENT_URL}/team`);
      await visitorPage.evaluate(
        ([key, value]) => window.localStorage.setItem(key!, value!),
        [TEAM_TOKEN_STORAGE_KEY, teamToken],
      );
      await visitorPage.reload();
      await expect(visitorPage.getByRole('link', { name: 'Forum' }).first()).toBeVisible({
        timeout: 30_000,
      });
      expect(visitorPage.getByPlaceholder(/Xk3mP2vQ/)).toBeHidden();
      const cookies = await visitorPage.context().cookies();
      expect(cookies.find((c) => c.name === 'mantle_team_chat')).toBeUndefined();
    } finally {
      await cleanup(ownerApi, contactId);
    }
  });

  test('the SSO handoff mints a server-origin cookie and 303s to the share', async ({
    ownerApi,
    visitorPage,
    serverURL,
  }) => {
    const { contactId, token } = await mintMember(ownerApi);
    try {
      const exchange = await visitorPage.request.post(`${serverURL}/api/team/auth`, {
        data: { token, mode: 'bearer' },
      });
      const { teamToken } = (await exchange.json()) as { teamToken: string };

      // The handoff validates the bearer + the next SHAPE (the share itself
      // resolves at render time), sets the cookie, and 303s.
      const sso = await visitorPage.request.post(`${serverURL}/api/team/sso`, {
        form: { tb: teamToken, next: '/s/E2eShareTok' },
        maxRedirects: 0,
      });
      expect(sso.status()).toBe(303);
      expect(sso.headers()['location']).toContain('/s/E2eShareTok');
      expect(sso.headers()['set-cookie']).toContain('mantle_team_chat=');

      // Open-redirect shapes die with 403, cookie-less.
      const evil = await visitorPage.request.post(`${serverURL}/api/team/sso`, {
        form: { tb: teamToken, next: 'https://evil.example/s/x' },
        maxRedirects: 0,
      });
      expect(evil.status()).toBe(403);
      expect(evil.headers()['set-cookie']).toBeUndefined();
    } finally {
      await cleanup(ownerApi, contactId);
    }
  });

  test('the /s app brokers answer a CORS preflight for the client origin', async ({
    visitorPage,
    serverURL,
  }) => {
    // Preflights are answered by the middleware BEFORE share resolution, so
    // any token shape works — this asserts the CORS surface, not the share.
    const preflight = await visitorPage.request.fetch(`${serverURL}/s/AnyTok/db-broker`, {
      method: 'OPTIONS',
      headers: {
        Origin: CLIENT_URL,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization, content-type',
      },
    });
    expect(preflight.status()).toBe(204);
    expect(preflight.headers()['access-control-allow-origin']).toBeTruthy();
    expect(preflight.headers()['access-control-allow-headers']?.toLowerCase()).toContain(
      'authorization',
    );
    // The non-broker /s page gets NO CORS treatment — scoped, not blanket.
    const page = await visitorPage.request.fetch(`${serverURL}/s/AnyTok`, {
      method: 'OPTIONS',
      headers: { Origin: CLIENT_URL, 'Access-Control-Request-Method': 'GET' },
    });
    expect(page.headers()['access-control-allow-origin']).toBeUndefined();
  });
});
