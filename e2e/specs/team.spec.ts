import { expect, test } from '../lib/fixtures';

/**
 * Team surface — the member workspace on the CLIENT origin (the T3/T4 member
 * carve: /team moved off the server app; the server keeps a redirect stub for
 * canonical-domain bookmarks). Mints a contact team token via the owner API,
 * then walks the member entry: /team → token gate → workspace. The gate
 * exchanges the token for the signed team bearer when the client runs
 * detached (mode:'bearer'), or the classic cookie same-origin — this spec
 * exercises whichever the topology produces, plus the server stub's redirect
 * (navigating the SERVER origin's /team must land a member in the same gate).
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

      // Enter via the SERVER origin on purpose: bookmarks predate the carve,
      // and the redirect stub must land members on the client origin's gate.
      await visitorPage.goto(`${serverURL}/team`);
      // Token gate (components/team-chat/token-gate.tsx): an Input with a
      // sample-token placeholder + a submit Button (onClick — Enter is not
      // wired). Generous timeout: dev-mode first-compile of /team is slow.
      const input = visitorPage.getByPlaceholder(/Xk3mP2vQ/);
      await expect(input).toBeVisible({ timeout: 30_000 });
      await input.fill(token);
      await visitorPage.getByRole('button').filter({ hasNotText: /^$/ }).first().click();

      // The workspace shell replaces the gate once the credential lands.
      await expect(input).toBeHidden({ timeout: 15_000 });
      await expect(visitorPage.locator('body')).not.toContainText(/invalid|expired/i);
    } finally {
      await ownerApi.post(`/api/contacts/${contactId}/team`, { data: { action: 'disable' } });
      await ownerApi.delete(`/api/contacts/${contactId}`);
    }
  });
});
