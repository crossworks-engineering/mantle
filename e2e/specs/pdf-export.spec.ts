import { makeDoc } from '../lib/doc';
import { SKIP_PDF } from '../lib/env';
import { expect, test } from '../lib/fixtures';

/**
 * PDF export — the server's headless-Chrome-renders-live-UI loop
 * (lib/render-pdf.ts → browserless sidecar → /print/pages/[id]). The audit
 * flags this as a break risk for bearer-authed owners (the route forwards the
 * caller's Cookie header); Phase 2 fixes it with a server-minted print cookie.
 * This spec gates that: a %PDF comes back for the suite's auth mode.
 */
test.describe('pdf export', () => {
  test.skip(SKIP_PDF, 'E2E_SKIP_PDF=1 — stack has no browserless sidecar');

  test('page exports as a real PDF', async ({ ownerApi }) => {
    const title = `E2E pdf page ${Date.now()}`;
    const created = await ownerApi.post('/api/pages', {
      data: { title, doc: makeDoc(title, 'PDF export smoke.') },
    });
    expect(created.ok()).toBeTruthy();
    const { page: row } = (await created.json()) as { page: { id: string } };

    try {
      const res = await ownerApi.get(`/api/export/${row.id}?format=pdf`, {
        timeout: 45_000,
        failOnStatusCode: false,
      });
      expect(res.status(), await res.text().catch(() => '')).toBe(200);
      expect(res.headers()['content-type'] ?? '').toContain('application/pdf');
      const body = await res.body();
      expect(body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(body.length).toBeGreaterThan(1_000);
    } finally {
      await ownerApi.delete(`/api/pages/${row.id}`);
    }
  });
});
