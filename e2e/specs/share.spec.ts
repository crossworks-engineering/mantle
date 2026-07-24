import { makeDoc } from '../lib/doc';
import { expect, test } from '../lib/fixtures';

/**
 * Public share surface — /s/[token] lives on the SERVER origin by design
 * (locked decision 4) and must keep rendering for anonymous visitors through
 * every phase of the split.
 */
test.describe('public share', () => {
  test('anonymous visitor renders a shared page', async ({ ownerApi, visitorPage, serverURL }) => {
    const title = `E2E shared page ${Date.now()}`;
    const created = await ownerApi.post('/api/pages', {
      data: { title, doc: makeDoc(title, 'Shared for the e2e suite.') },
    });
    expect(created.ok()).toBeTruthy();
    const { page: row } = (await created.json()) as { page: { id: string } };

    try {
      const share = await ownerApi.post('/api/shares', { data: { nodeId: row.id } });
      expect(share.ok()).toBeTruthy();
      const { share: link } = (await share.json()) as { share: { token: string; path: string } };
      expect(link.token).toBeTruthy();

      await visitorPage.goto(`${serverURL}/s/${link.token}`);
      await expect(visitorPage.getByText(title).first()).toBeVisible({ timeout: 15_000 });
    } finally {
      await ownerApi.delete(`/api/pages/${row.id}`);
    }
  });
});
