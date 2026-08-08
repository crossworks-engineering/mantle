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
        // The client's payload was refused, so the commit stored no snapshot.
        expect(body.draw.hasSvg).toBe(false);
        rev = body.draw.draftRev;

        // Reading it back does NOT return null any more: with the render
        // fallback in place the server regenerates a snapshot from the scene
        // through the sidecar. That is the point — what must never happen is
        // the ATTACKER's bytes being stored or served, so assert on the
        // payload, not on emptiness.
        const stored = await ownerApi.get(`/api/draws/${draw.id}/svg`);
        const storedSvg = ((await stored.json()) as { svg: string | null }).svg ?? '';
        expect(storedSvg).not.toContain('onerror');
        expect(storedSvg).not.toContain('javascript:');
        expect(storedSvg).not.toContain('&#106;');
        // Anything served is our own render, not the submitted document.
        if (storedSvg) expect(storedSvg).toContain('svg-source:excalidraw');
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

test.describe('snapshot cache', () => {
  test.skip(({ topology }) => topology === 'same-origin', 'owner UI lives on the client app');

  test('an owner view re-renders a missing snapshot; the public route does not', async ({
    ownerApi,
    visitorPage,
    serverURL,
  }) => {
    const title = `E2E render fallback ${Date.now()}`;
    const created = await ownerApi.post('/api/draws', { data: { title } });
    const { draw } = (await created.json()) as { draw: { id: string } };

    try {
      // Commit WITHOUT an svg: exactly the state an agent-authored drawing
      // lands in, and the state that used to be a permanent dead end.
      const committed = await ownerApi.post(`/api/draws/${draw.id}/commit`, {
        data: { scene: sceneWith('render fallback canary'), if_rev: 0 },
      });
      expect(committed.ok()).toBeTruthy();
      expect(((await committed.json()) as { draw: { hasSvg: boolean } }).draw.hasSvg).toBe(false);

      // The public share surface must NOT trigger a render — spawning a
      // browser is not something anonymous traffic gets to do.
      const share = await ownerApi.post('/api/shares', { data: { nodeId: draw.id } });
      const { share: link } = (await share.json()) as { share: { token: string } };
      const beforeFill = await visitorPage.request.get(`${serverURL}/s/${link.token}/draw`);
      expect(beforeFill.status()).toBe(404);

      // An owner view fills the cache through the browser sidecar.
      const filled = await ownerApi.get(`/api/draws/${draw.id}/svg`);
      expect(filled.ok()).toBeTruthy();
      const svg = ((await filled.json()) as { svg: string | null }).svg;
      expect(svg).toBeTruthy();
      expect(svg).toContain('<svg');

      // Now it is cached, so the public route serves it without rendering.
      const afterFill = await visitorPage.request.get(`${serverURL}/s/${link.token}/draw`);
      expect(afterFill.ok()).toBeTruthy();
      expect(afterFill.headers()['content-type']).toContain('image/svg+xml');
    } finally {
      await ownerApi.delete(`/api/draws/${draw.id}`);
    }
  });
});

test.describe('drawing embedded in a page', () => {
  test.skip(({ topology }) => topology === 'same-origin', 'owner UI lives on the client app');

  test('renders on the shared page, and only for the page that embeds it', async ({
    ownerApi,
    visitorPage,
    serverURL,
  }) => {
    const created = await ownerApi.post('/api/draws', {
      data: { title: `E2E embedded draw ${Date.now()}` },
    });
    const { draw } = (await created.json()) as { draw: { id: string } };
    // A second page that does NOT embed it, to prove the share gate is scoped
    // to the doc rather than to "any drawing this owner has".
    // The doc form of `![Sketch](draw:<id>)` — an image node whose bytes come
    // from a drawing rather than an uploaded file.
    const host = await ownerApi.post('/api/pages', {
      data: {
        title: `E2E host page ${Date.now()}`,
        doc: {
          type: 'doc',
          content: [{ type: 'image', attrs: { src: null, alt: 'Sketch', drawId: draw.id } }],
        },
      },
    });
    const { page: hostPage } = (await host.json()) as { page: { id: string } };
    const other = await ownerApi.post('/api/pages', {
      data: {
        title: `E2E other page ${Date.now()}`,
        doc: { type: 'doc', content: [{ type: 'paragraph' }] },
      },
    });
    const { page: otherPage } = (await other.json()) as { page: { id: string } };

    try {
      await ownerApi.post(`/api/draws/${draw.id}/commit`, {
        data: { scene: sceneWith('embedded canary'), svg: GOOD_SVG, if_rev: 0 },
      });

      const share = await ownerApi.post('/api/shares', { data: { nodeId: hostPage.id } });
      const { share: link } = (await share.json()) as { share: { token: string } };

      await visitorPage.goto(`${serverURL}/s/${link.token}`);
      // The drawing is an <img> into the share's own draw route — never inline
      // SVG markup on a page an anonymous visitor is looking at.
      await expect(
        visitorPage.locator(`img[src="/s/${link.token}/draw/${draw.id}"]`),
      ).toBeVisible();
      expect(await visitorPage.content()).not.toContain('<svg');

      const asset = await visitorPage.request.get(`${serverURL}/s/${link.token}/draw/${draw.id}`);
      expect(asset.ok()).toBeTruthy();
      expect(asset.headers()['content-type']).toContain('image/svg+xml');

      // A share of a page that does not embed the drawing must not serve it.
      const otherShare = await ownerApi.post('/api/shares', { data: { nodeId: otherPage.id } });
      const { share: otherLink } = (await otherShare.json()) as { share: { token: string } };
      const leaked = await visitorPage.request.get(
        `${serverURL}/s/${otherLink.token}/draw/${draw.id}`,
      );
      expect(leaked.status()).toBe(404);
    } finally {
      await ownerApi.delete(`/api/pages/${hostPage.id}`);
      await ownerApi.delete(`/api/pages/${otherPage.id}`);
      await ownerApi.delete(`/api/draws/${draw.id}`);
    }
  });
});

test.describe('the /drawing slash item', () => {
  test.skip(({ topology }) => topology === 'same-origin', 'owner UI lives on the client app');

  test('opens the picker and embeds the chosen drawing at the caret', async ({
    ownerApi,
    ownerPage,
  }) => {
    // The human entry point for 4a in docs/draw-audit-handover.md: before the
    // picker existed only markdown or an agent could create a draw embed.
    const title = `E2E pickable draw ${Date.now()}`;
    const created = await ownerApi.post('/api/draws', { data: { title } });
    const { draw } = (await created.json()) as { draw: { id: string } };
    const host = await ownerApi.post('/api/pages', {
      data: {
        title: `E2E picker host ${Date.now()}`,
        doc: { type: 'doc', content: [{ type: 'paragraph' }] },
      },
    });
    const { page: hostPage } = (await host.json()) as { page: { id: string } };

    try {
      await ownerApi.post(`/api/draws/${draw.id}/commit`, {
        data: { scene: sceneWith('picker canary'), svg: GOOD_SVG, if_rev: 0 },
      });

      await ownerPage.goto(`/pages/${hostPage.id}`);
      const editor = ownerPage.locator('.ProseMirror');
      await editor.click();
      await ownerPage.keyboard.type('/drawing');
      // "Drawing" is the only slash item matching the query; Enter commits it.
      await expect(ownerPage.getByRole('button', { name: /^Drawing/ })).toBeVisible();
      await ownerPage.keyboard.press('Enter');

      // The picker dialog lists drawings; search narrows to ours.
      const dialog = ownerPage.getByRole('dialog');
      await expect(dialog.getByText('Embed a drawing')).toBeVisible();
      await dialog.getByPlaceholder('Search drawings…').fill(title);
      await dialog.getByRole('button', { name: title }).click();

      // The embed is the standard image node backed by the drawing (the same
      // shape `![alt](draw:<id>)` parses into), rendered live in the editor.
      await expect(editor.locator(`img[data-draw-id="${draw.id}"]`)).toHaveCount(1);

      // And the autosaved page draft carries the drawId reference.
      await expect
        .poll(
          async () => JSON.stringify(await (await ownerApi.get(`/api/pages/${hostPage.id}`)).json()),
          { timeout: 15_000 },
        )
        .toContain(draw.id);
    } finally {
      await ownerApi.delete(`/api/pages/${hostPage.id}`);
      await ownerApi.delete(`/api/draws/${draw.id}`);
    }
  });
});

test.describe('scene image integrity', () => {
  test.skip(({ topology }) => topology === 'same-origin', 'owner UI lives on the client app');

  test('deleting an image a drawing still uses is refused, not silently broken', async ({
    ownerApi,
  }) => {
    // A drawing whose file_refs point at a real file — the shape the editor
    // produces when you paste an image onto the canvas.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const upload = await ownerApi.post('/api/files/files', {
      multipart: {
        // Required by the route; without it the upload 400s.
        parentPath: 'files',
        file: { name: 'scene-image.png', mimeType: 'image/png', buffer: png },
      },
    });
    expect(upload.ok()).toBeTruthy();
    const uploaded = (await upload.json()) as { file: { id: string } };
    const fileId = uploaded.file?.id ?? '';
    expect(fileId).toBeTruthy();

    const created = await ownerApi.post('/api/draws', {
      data: { title: `E2E scene image ${Date.now()}` },
    });
    const { draw } = (await created.json()) as { draw: { id: string } };

    try {
      // The scene must actually PLACE the image: the guard checks for a live
      // image element referencing the BinaryFile id, not merely a file_refs
      // entry, because that map is append-only and would otherwise block
      // deletes for images the user had already removed.
      const sceneWithImage = {
        elements: [
          {
            id: 'img1',
            type: 'image',
            fileId: 'excalidraw-file-1',
            x: 0,
            y: 0,
            width: 10,
            height: 10,
            version: 1,
            isDeleted: false,
          },
        ],
        appState: { viewBackgroundColor: '#ffffff' },
      };
      await ownerApi.post(`/api/draws/${draw.id}/commit`, {
        data: {
          scene: sceneWithImage,
          svg: GOOD_SVG,
          file_refs: { 'excalidraw-file-1': fileId },
          if_rev: 0,
        },
      });

      // Used to succeed, leaving the canvas quietly missing the image while
      // the committed snapshot kept showing it (the bytes are inlined there).
      const del = await ownerApi.delete(`/api/files/files/${fileId}`);
      expect(del.status()).toBe(409);
      const body = (await del.json()) as { reason?: string; error?: string };
      expect(body.reason).toBe('in_drawing');
      expect(body.error).toContain('drawing');
    } finally {
      await ownerApi.delete(`/api/draws/${draw.id}`);
      await ownerApi.delete(`/api/files/files/${fileId}`);
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
