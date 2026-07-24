import { expect, test } from '../lib/fixtures';

declare global {
  interface Window {
    __e2eSSE?: { opened: boolean; text: string; status: number; error?: string };
  }
}

/**
 * SSE transport smoke — the split's riskiest transport after assets. Opens
 * /api/realtime from the BROWSER (so cookies/bearer flow exactly as the app's
 * apiEventStream would), CONFIRMS the ': connected' preamble (which is sent
 * before the route's LISTEN is fully established — and in dev the route
 * compiles on first hit), and only then creates a note via the API, expecting
 * its `node_ingested` fanout to arrive as a data frame.
 */
test.describe('realtime SSE', () => {
  test('stream opens and delivers a change event', async ({ ownerPage, ownerApi }) => {
    await ownerPage.goto('/');

    // Start a background reader that accumulates frames into a window global.
    await ownerPage.evaluate(() => {
      const state: NonNullable<Window['__e2eSSE']> = { opened: false, text: '', status: 0 };
      window.__e2eSSE = state;
      void (async () => {
        try {
          const token = window.localStorage.getItem('mantle_token');
          const base =
            (window as unknown as { __MANTLE_ENV__?: { apiBase?: string } }).__MANTLE_ENV__
              ?.apiBase ?? '';
          const res = await fetch(`${base}/api/realtime?types=note`, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            credentials: token ? 'omit' : 'include',
          });
          state.status = res.status;
          if (!res.ok || !res.body) return;
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          for (;;) {
            const { value, done } = await reader.read();
            if (value) {
              state.text += decoder.decode(value, { stream: true });
              if (state.text.includes(': connected')) state.opened = true;
            }
            if (done) break;
          }
        } catch (err) {
          state.error = String(err);
        }
      })();
    });

    // Stream confirmed open BEFORE the poke. The route sends ': connected'
    // and THEN awaits its LISTEN setup (pg connect + subscribe) — give that a
    // beat to land so the poke's NOTIFY can't slip through the gap.
    await ownerPage.waitForFunction(() => window.__e2eSSE?.opened === true, undefined, {
      timeout: 30_000,
    });
    await ownerPage.waitForTimeout(750);

    const note = await ownerApi.post('/api/notes', {
      data: { title: `E2E realtime poke ${Date.now()}`, content: 'sse smoke' },
    });
    expect(note.ok()).toBeTruthy();
    const { note: created } = (await note.json()) as { note: { id: string } };

    try {
      await ownerPage.waitForFunction(
        () => (window.__e2eSSE?.text ?? '').includes('data:'),
        undefined,
        { timeout: 20_000 },
      );
      const state = await ownerPage.evaluate(() => window.__e2eSSE);
      expect(state?.error).toBeUndefined();
      expect(state?.text ?? '').toContain('data:');
    } finally {
      await ownerApi.delete(`/api/notes/${created.id}`);
    }
  });
});
