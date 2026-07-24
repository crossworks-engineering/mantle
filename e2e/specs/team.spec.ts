import { expect, test } from '../lib/fixtures';

/**
 * Team surface — cookie-based multi-user auth on the SERVER origin (locked
 * decision 4: move-frozen through the split). Mints a contact team token via
 * the owner API, then walks the member entry: /team → token gate → workspace.
 */
test.describe('team workspace', () => {
  test('a contact team token opens the member workspace', async ({
    ownerApi,
    visitorPage,
    serverURL,
  }) => {
    const created = await ownerApi.post('/api/contacts', {
      data: { first_name: 'E2E', last_name: `Member ${Date.now()}` },
    });
    expect(created.ok()).toBeTruthy();
    const cBody = (await created.json()) as { contact?: { id?: string }; id?: string };
    const contactId = cBody.contact?.id ?? cBody.id;
    expect(contactId).toBeTruthy();

    try {
      const minted = await ownerApi.post(`/api/contacts/${contactId}/team`, {
        data: { action: 'enable' },
      });
      expect(minted.ok()).toBeTruthy();
      const { token } = (await minted.json()) as { token: string };
      expect(token).toBeTruthy();

      await visitorPage.goto(`${serverURL}/team`);
      // Token gate (components/team-chat/token-gate.tsx): an Input with a
      // sample-token placeholder + a submit Button (onClick — Enter is not
      // wired). Generous timeout: dev-mode first-compile of /team is slow.
      const input = visitorPage.getByPlaceholder(/Xk3mP2vQ/);
      await expect(input).toBeVisible({ timeout: 30_000 });
      await input.fill(token);
      await visitorPage.getByRole('button').filter({ hasNotText: /^$/ }).first().click();

      // The workspace shell replaces the gate once the cookie lands.
      await expect(input).toBeHidden({ timeout: 15_000 });
      await expect(visitorPage.locator('body')).not.toContainText(/invalid|expired/i);
    } finally {
      await ownerApi.post(`/api/contacts/${contactId}/team`, { data: { action: 'disable' } });
      await ownerApi.delete(`/api/contacts/${contactId}`);
    }
  });
});
