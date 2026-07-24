import { expect, test } from '../lib/fixtures';

test.describe('pages CRUD', () => {
  test('create via API → visible in the owner UI list → delete', async ({
    ownerApi,
    ownerPage,
  }) => {
    const title = `E2E smoke page ${Date.now()}`;
    const created = await ownerApi.post('/api/pages', { data: { title } });
    expect(created.ok()).toBeTruthy();
    const { page: row } = (await created.json()) as { page: { id: string } };
    expect(row.id).toBeTruthy();

    try {
      // The /pages list is URL-driven SSR search — q=<title> must find it.
      await ownerPage.goto(`/pages?q=${encodeURIComponent(title)}`);
      await expect(ownerPage.getByText(title).first()).toBeVisible({ timeout: 15_000 });
    } finally {
      const del = await ownerApi.delete(`/api/pages/${row.id}`);
      expect(del.ok()).toBeTruthy();
    }

    // Gone after delete.
    const list = await ownerApi.get(`/api/pages?q=${encodeURIComponent(title)}`);
    expect(list.ok()).toBeTruthy();
    expect(JSON.stringify(await list.json())).not.toContain(title);
  });
});
