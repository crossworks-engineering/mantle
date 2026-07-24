import { expect, test } from '../lib/fixtures';

/**
 * The `?at=` asset-token transport — the one auth channel for browser-native
 * <img>/<iframe>/download srcs that can't carry a header. Flagged in the audit
 * as the least-smoked path; this pins it: upload → mint asset token via
 * /api/shell → fetch the bytes with NO cookie and NO bearer, `?at=` only.
 */
test.describe('assets', () => {
  test('uploaded file bytes are served via ?at= token alone', async ({
    ownerApi,
    serverURL,
    playwright,
  }) => {
    const content = `e2e asset smoke ${Date.now()}`;
    const up = await ownerApi.post('/api/files/files', {
      data: { parentPath: 'files', filename: `e2e-asset-${Date.now()}.txt`, content },
    });
    expect(up.ok()).toBeTruthy();
    const upBody = (await up.json()) as { file?: { id?: string }; id?: string };
    const fileId = upBody.file?.id ?? upBody.id;
    expect(fileId).toBeTruthy();

    const shell = await ownerApi.get('/api/shell');
    const { assetToken } = (await shell.json()) as { assetToken: string };
    expect(assetToken).toBeTruthy();

    const anon = await playwright.request.newContext({ baseURL: serverURL });
    try {
      const raw = await anon.get(`/api/files/files/${fileId}?raw=1&at=${assetToken}`, {
        failOnStatusCode: false,
      });
      expect(raw.status()).toBe(200);
      expect(await raw.text()).toContain(content);

      // Same URL WITHOUT the token must 401 — the token is doing the work.
      const bare = await anon.get(`/api/files/files/${fileId}?raw=1`, {
        failOnStatusCode: false,
      });
      expect(bare.status()).toBe(401);
    } finally {
      await anon.dispose();
      await ownerApi.delete(`/api/files/files/${fileId}`);
    }
  });
});
