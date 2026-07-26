import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '../lib/fixtures';
import { TEAM_TOKEN_STORAGE_KEY } from '../lib/contract';
import { CLIENT_URL, SERVER_URL } from '../lib/env';
import { makeDoc } from '../lib/doc';

/**
 * The /team INLINE share reader (no iframe): selecting a shared page in the
 * workspace renders its CONTENT in the reader pane via GET /s/<token>/view.
 *
 * This spec exists because the predicate guarding the old reader was wrong in
 * a way no project covered: "apiBase configured" was read as "cross-origin",
 * but the DEFAULT deployment is one domain path-routed with an absolute
 * MANTLE_SERVER_ORIGIN — same-origin with apiBase set. Every production box
 * was in that shape, and every member got a redirect card instead of content.
 *
 *   same-origin project — content renders inline; no iframe in the pane.
 *   split project       — the fallback card offers the top-level SSO open
 *                         (inline reading would strand cookie-authenticated
 *                         subresources like page images).
 */
test.describe('team inline share reader', () => {
  async function mintMember(ownerApi: APIRequestContext) {
    const created = await ownerApi.post('/api/contacts', {
      data: { first_name: 'E2E', last_name: `Reader ${Date.now()}` },
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

  test('a shared page reads inline in the workspace pane', async ({
    ownerApi,
    visitorPage,
    serverURL,
  }) => {
    const title = `E2E reader page ${Date.now()}`;
    const body = 'Inline reader body text for the e2e suite.';
    const created = await ownerApi.post('/api/pages', {
      data: { title, doc: makeDoc(title, body) },
    });
    expect(created.ok()).toBeTruthy();
    const { page: row } = (await created.json()) as { page: { id: string } };

    const { contactId, token } = await mintMember(ownerApi);
    try {
      const share = await ownerApi.post('/api/shares', { data: { nodeId: row.id } });
      expect(share.ok()).toBeTruthy();
      const { share: link } = (await share.json()) as { share: { token: string } };

      // Authenticate the member (bearer exchange + seeded storage — the
      // deterministic boot team-bearer.spec established).
      const exchange = await visitorPage.request.post(`${serverURL}/api/team/auth`, {
        data: { token, mode: 'bearer' },
      });
      expect(exchange.ok()).toBeTruthy();
      const { teamToken } = (await exchange.json()) as { teamToken: string };
      await visitorPage.goto(`${CLIENT_URL}/team`);
      await visitorPage.evaluate(
        ([key, value]) => window.localStorage.setItem(key!, value!),
        [TEAM_TOKEN_STORAGE_KEY, teamToken],
      );

      // Deep-link the selection — the reader pane is URL-driven (?s=).
      await visitorPage.goto(`${CLIENT_URL}/team/pages?s=${link.token}`);

      if (CLIENT_URL === SERVER_URL) {
        // Same-origin: the CONTENT is in the pane itself — no iframe.
        await expect(visitorPage.getByText(body).first()).toBeVisible({ timeout: 30_000 });
        await expect(visitorPage.locator('iframe')).toHaveCount(0);
      } else {
        // Split: no inline reading — the pane offers the top-level open.
        await expect(visitorPage.getByText(/opens on the brain/i)).toBeVisible({
          timeout: 30_000,
        });
        await expect(visitorPage.getByText(body)).toBeHidden();
      }
    } finally {
      await ownerApi.post(`/api/contacts/${contactId}/team`, { data: { action: 'disable' } });
      await ownerApi.delete(`/api/contacts/${contactId}`);
      await ownerApi.delete(`/api/pages/${row.id}`);
    }
  });
});
