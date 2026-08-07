import { expect, test } from '../lib/fixtures';

/**
 * The draw lifecycle, end to end against a real database.
 *
 * This exists because the draft/commit/etag machinery had no automated
 * coverage at all (G1 in docs/draw-audit-handover.md): the original 18-step
 * check was run by hand once and deleted. Everything here is a claim the
 * feature makes about itself, so a regression fails loudly instead of being
 * rediscovered by an auditor.
 */

const NS = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"';
const GOOD_SVG = `<svg ${NS}><rect width="100" height="100" fill="#eee"/><text>canary</text></svg>`;

/** A scene whose text walker output contains `term`. */
function sceneWith(term: string) {
  return {
    elements: [
      {
        id: 'a1',
        type: 'text',
        x: 0,
        y: 0,
        width: 100,
        height: 20,
        text: term,
        version: 1,
        isDeleted: false,
      },
    ],
    appState: { viewBackgroundColor: '#ffffff' },
  };
}

test.describe('draws lifecycle', () => {
  test.skip(({ topology }) => topology === 'same-origin', 'owner UI lives on the client app');

  test('create → draft → stale rev 409 → commit → discard → delete', async ({ ownerApi }) => {
    const title = `E2E draw ${Date.now()}`;
    const created = await ownerApi.post('/api/draws', { data: { title } });
    expect(created.ok()).toBeTruthy();
    const { draw } = (await created.json()) as { draw: { id: string; hasSvg: boolean } };
    expect(draw.id).toBeTruthy();
    expect(draw.hasSvg).toBe(false);

    try {
      // ── Autosave a draft, and get the etag back ──────────────────────────
      const d1 = await ownerApi.put(`/api/draws/${draw.id}/draft`, {
        data: { scene: sceneWith('draft-only text'), if_rev: 0 },
      });
      expect(d1.ok()).toBeTruthy();
      const { draft_rev: rev1 } = (await d1.json()) as { draft_rev: number };
      expect(rev1).toBeGreaterThan(0);

      // A draft is private: it must NOT be indexed, so scene_text is still
      // empty and the drawing is not findable by its draft contents.
      const notYet = await ownerApi.get('/api/draws?q=draft-only');
      expect(JSON.stringify(await notYet.json())).not.toContain(title);

      // ── A stale etag conflicts and mutates nothing ───────────────────────
      const stale = await ownerApi.put(`/api/draws/${draw.id}/draft`, {
        data: { scene: sceneWith('clobbered'), if_rev: rev1 - 1 },
      });
      expect(stale.status()).toBe(409);
      const conflict = (await stale.json()) as { current_rev: number };
      expect(conflict.current_rev).toBe(rev1);

      // ── Commit: publishes, indexes, stores the validated snapshot ────────
      const committed = await ownerApi.post(`/api/draws/${draw.id}/commit`, {
        data: { scene: sceneWith('canary-committed'), svg: GOOD_SVG, if_rev: rev1 },
      });
      expect(committed.ok()).toBeTruthy();
      const after = (await committed.json()) as {
        draw: { hasSvg: boolean; draft: unknown; draftRev: number };
      };
      expect(after.draw.hasSvg).toBe(true);
      expect(after.draw.draft).toBeNull(); // commit clears the draft

      const svg = await ownerApi.get(`/api/draws/${draw.id}/svg`);
      expect(((await svg.json()) as { svg: string }).svg).toContain('canary');

      // Committed content IS searchable by what the drawing says.
      const found = await ownerApi.get('/api/draws?q=canary-committed');
      expect(JSON.stringify(await found.json())).toContain(title);

      // ── Discard drops a later draft without touching the commit ──────────
      const d2 = await ownerApi.put(`/api/draws/${draw.id}/draft`, {
        data: { scene: sceneWith('second draft'), if_rev: after.draw.draftRev },
      });
      expect(d2.ok()).toBeTruthy();
      const discarded = await ownerApi.post(`/api/draws/${draw.id}/discard-draft`, { data: {} });
      expect(discarded.ok()).toBeTruthy();
      const reread = await ownerApi.get(`/api/draws/${draw.id}`);
      expect(((await reread.json()) as { draw: { draft: unknown } }).draw.draft).toBeNull();
    } finally {
      const del = await ownerApi.delete(`/api/draws/${draw.id}`);
      expect(del.ok()).toBeTruthy();
    }

    const gone = await ownerApi.get(`/api/draws/${draw.id}`);
    expect(gone.status()).toBe(404);
  });

  test('a hostile snapshot is dropped and clears the stored one', async ({ ownerApi }) => {
    // Both payloads defeated the original validator and were confirmed
    // executing in a browser (docs/draw-audit-findings.md §2). Storing either
    // one must be impossible; a commit carrying one still succeeds, because
    // the snapshot is best-effort and the scene is what matters.
    const hostile = [
      `<svg ${NS}><image href="/x"/onerror="fetch('/api/draws')"/></svg>`,
      `<svg ${NS}><a xlink:href="&#106;avascript:alert(1)"><rect/></a></svg>`,
    ];

    const created = await ownerApi.post('/api/draws', {
      data: { title: `E2E hostile svg ${Date.now()}` },
    });
    const { draw } = (await created.json()) as { draw: { id: string } };

    try {
      // A good snapshot first, so we can prove a bad one CLEARS it rather
      // than leaving a stale render behind.
      let rev = 0;
      const ok = await ownerApi.post(`/api/draws/${draw.id}/commit`, {
        data: { scene: sceneWith('safe'), svg: GOOD_SVG, if_rev: rev },
      });
      const okBody = (await ok.json()) as { draw: { hasSvg: boolean; draftRev: number } };
      expect(okBody.draw.hasSvg).toBe(true);
      rev = okBody.draw.draftRev;

      for (const svg of hostile) {
        const res = await ownerApi.post(`/api/draws/${draw.id}/commit`, {
          data: { scene: sceneWith('safe'), svg, if_rev: rev },
        });
        expect(res.ok()).toBeTruthy(); // the commit itself never fails on the svg
        const body = (await res.json()) as { draw: { hasSvg: boolean; draftRev: number } };
        expect(body.draw.hasSvg).toBe(false);
        rev = body.draw.draftRev;

        const stored = await ownerApi.get(`/api/draws/${draw.id}/svg`);
        expect(((await stored.json()) as { svg: string | null }).svg).toBeNull();
      }
    } finally {
      await ownerApi.delete(`/api/draws/${draw.id}`);
    }
  });

  test('an oversized scene is refused, not truncated', async ({ ownerApi }) => {
    const created = await ownerApi.post('/api/draws', {
      data: { title: `E2E huge scene ${Date.now()}` },
    });
    const { draw } = (await created.json()) as { draw: { id: string } };
    try {
      const huge = { elements: Array.from({ length: 20_001 }, (_, i) => ({ id: `e${i}` })) };
      const res = await ownerApi.put(`/api/draws/${draw.id}/draft`, {
        data: { scene: huge, if_rev: 0 },
      });
      expect(res.status()).toBe(413);
    } finally {
      await ownerApi.delete(`/api/draws/${draw.id}`);
    }
  });
});

test.describe('shared drawing', () => {
  test('renders for an anonymous visitor as an IMAGE, never inline markup', async ({
    ownerApi,
    visitorPage,
    serverURL,
  }) => {
    const title = `E2E shared draw ${Date.now()}`;
    const created = await ownerApi.post('/api/draws', { data: { title } });
    const { draw } = (await created.json()) as { draw: { id: string } };

    try {
      const committed = await ownerApi.post(`/api/draws/${draw.id}/commit`, {
        data: { scene: sceneWith('shared canary'), svg: GOOD_SVG, if_rev: 0 },
      });
      expect(committed.ok()).toBeTruthy();

      const share = await ownerApi.post('/api/shares', { data: { nodeId: draw.id } });
      expect(share.ok()).toBeTruthy();
      const { share: link } = (await share.json()) as { share: { token: string } };

      await visitorPage.goto(`${serverURL}/s/${link.token}`);
      await expect(visitorPage.getByText(title).first()).toBeVisible({ timeout: 15_000 });

      // The snapshot is an <img> pointing at the share's own image route, and
      // the document contains NO inline <svg> and no <script>. This is the
      // architectural fix from the audit: markup from the column never becomes
      // markup on the page, so the safety of this surface does not depend on a
      // validator being exhaustive.
      const img = visitorPage.locator(`img[src="/s/${link.token}/draw"]`);
      await expect(img).toBeVisible();
      const html = await visitorPage.content();
      expect(html).not.toContain('<svg');
      expect(html).not.toContain('<script');

      // The image route itself serves the bytes, script-disabled.
      const asset = await visitorPage.request.get(`${serverURL}/s/${link.token}/draw`);
      expect(asset.ok()).toBeTruthy();
      expect(asset.headers()['content-type']).toContain('image/svg+xml');
      expect(asset.headers()['content-security-policy']).toContain('sandbox');
    } finally {
      await ownerApi.delete(`/api/draws/${draw.id}`);
    }
  });
});
