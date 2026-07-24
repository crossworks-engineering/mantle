import type { Hono } from 'hono';
import { getPage } from '@mantle/content';
import { requireOwner } from '@/lib/auth';
import { renderPageDoc } from '@/lib/render-page-doc';
import { htmlPage } from './template';

/**
 * Owner-only print surface for a Page (port of app/print/pages/[id]) — no app
 * chrome, just the content in the shared `.ProseMirror .prose` container so it
 * reuses the editor CSS from the compiled share-runtime stylesheet. Headless
 * Chromium (lib/render-pdf.ts) navigates here with the owner's session cookie
 * and print-to-PDFs it for the `?format=pdf` download. Not linked from the UI.
 */
export function mountPrint(app: Hono): void {
  app.get('/print/pages/:id', async (c) => {
    const user = await requireOwner(); // throws RedirectError → 307 /login
    const page = await getPage(user.id, c.req.param('id'));
    if (!page) return c.notFound();

    // Same authed asset path the in-app editor uses, so embedded images load
    // under the forwarded owner cookie.
    const html = renderPageDoc(page.doc, {
      assetUrl: (fileId: string) => `/api/files/files/${fileId}?raw=1`,
    });
    const widthClass = page.width === 'wide' ? 'max-w-5xl' : 'max-w-3xl';

    return c.html(
      htmlPage(
        {
          title: page.title ?? 'Page', // htmlPage escapes
          // The compiled stylesheet pins html/body to overflow:hidden for the
          // app shell; a printed document needs natural height so Chromium
          // paginates it all. Force a white page too — a PDF should print
          // light regardless of theme.
          extraHead: `<style>html,body{overflow:visible!important;height:auto!important;background:#fff}</style>`,
        },
        // WYSIWYG: render only the page content — no injected page-name
        // heading, matching the public share surface and the Markdown export.
        `<article class="ProseMirror prose prose-accent mx-auto ${widthClass} px-10 py-8"><div>${html}</div></article>`,
      ),
    );
  });
}
