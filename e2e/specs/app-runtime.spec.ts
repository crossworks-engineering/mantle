import { expect, test } from '../lib/fixtures';

/**
 * /app-runtime — the mini-app runtime served with ACAO:* for opaque-origin
 * (Origin: null) sandboxed iframes. After the split BOTH origins that render
 * sandboxes serve their own copy; this spec runs per-project so the split
 * project exercises the client origin's copy too (baseURL = CLIENT_URL).
 */
test.describe('app-runtime', () => {
  test('manifest + a module are served with ACAO:*', async ({ clientURL, playwright }) => {
    const anon = await playwright.request.newContext();
    try {
      const manifest = await anon.get(`${clientURL}/app-runtime/manifest.json`, {
        headers: { Origin: 'null' },
        failOnStatusCode: false,
      });
      expect(manifest.status()).toBe(200);
      expect(manifest.headers()['access-control-allow-origin']).toBe('*');

      // Import-map shape: { imports: { specifier: "/app-runtime/<hash>.js" } }
      const { imports } = (await manifest.json()) as { imports: Record<string, string> };
      const first = Object.values(imports ?? {}).find(
        (v) => typeof v === 'string' && v.endsWith('.js'),
      );
      expect(first, 'manifest lists at least one module').toBeTruthy();

      const mod = await anon.get(`${clientURL}${first as string}`, {
        headers: { Origin: 'null' },
        failOnStatusCode: false,
      });
      expect(mod.status()).toBe(200);
      expect(mod.headers()['access-control-allow-origin']).toBe('*');
      expect(mod.headers()['content-type'] ?? '').toContain('javascript');
    } finally {
      await anon.dispose();
    }
  });
});
