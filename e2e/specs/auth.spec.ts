import { OWNER_EMAIL } from '../lib/env';
import { expect, test } from '../lib/fixtures';

test.describe('auth', () => {
  test('bad password is rejected with 401 JSON (not an HTML redirect)', async ({
    ownerApi,
    serverURL,
  }) => {
    const res = await ownerApi.fetch(`${serverURL}/api/auth/login`, {
      method: 'POST',
      data: { email: OWNER_EMAIL, password: 'definitely-not-the-password' },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(401);
    expect(res.headers()['content-type'] ?? '').toContain('application/json');
  });

  test('authenticated owner reaches the app shell', async ({ ownerApi }) => {
    const res = await ownerApi.get('/api/shell');
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { assetToken?: string };
    expect(typeof body.assetToken).toBe('string');
  });

  test('owner page load is not bounced to /login', async ({ ownerPage }) => {
    await ownerPage.goto('/');
    await ownerPage.waitForLoadState('domcontentloaded');
    expect(new URL(ownerPage.url()).pathname).not.toBe('/login');
  });

  test('anonymous visitor is bounced to /login', async ({ visitorPage, clientURL }) => {
    await visitorPage.goto(`${clientURL}/pages`);
    await visitorPage.waitForURL(/\/login/);
    expect(new URL(visitorPage.url()).pathname).toBe('/login');
  });

  test('anonymous /api request gets 401 JSON', async ({ serverURL, playwright }) => {
    const anon = await playwright.request.newContext({ baseURL: serverURL });
    const res = await anon.get('/api/pages', { failOnStatusCode: false });
    expect(res.status()).toBe(401);
    expect(res.headers()['content-type'] ?? '').toContain('application/json');
    await anon.dispose();
  });
});
