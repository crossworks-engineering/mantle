import type { Hono } from 'hono';
import { getPage } from '@mantle/content';
import { requireOwner } from '@/lib/auth';
import { renderPageDoc } from '@/lib/render-page-doc';
import { htmlPage } from './template';
import { loadAppearanceAttrs } from './appearance';

/**
 * Upgrades diagram degrade blocks to real Mermaid SVG *inside the PDF
 * sidecar's Chromium* — the print page is already a real browser, so it does
 * the render itself; no second pipeline, and nothing is stored or inlined
 * server-side (the SVG becomes pixels in the PDF).
 *
 * Static script, no interpolated user data: each block's source is read back
 * from the degrade markup's <pre><code> textContent (the DOM un-escapes it).
 * Theme comes from the page's own resolved CSS tokens via the shared map in
 * @mantle/web-ui/mermaid-theme, which the in-editor NodeView also calls — this
 * script can't import, so it reads it off globalThis (see
 * server/islands/diagram-theme.ts). `<html>` never carries `dark` here, so the
 * map resolves light tokens, which is what a forced-light PDF wants. On any
 * failure the source block simply stays. `data-diagrams-ready` on <html> is
 * the completion signal lib/render-pdf.ts waits for; it is set on success,
 * failure, and the no-mermaid path alike so the PDF wait can never hang.
 */
const DIAGRAM_PRINT_SCRIPT = `
(async () => {
  const done = () => document.documentElement.setAttribute('data-diagrams-ready', '1');
  try {
    const blocks = Array.from(document.querySelectorAll('.diagram[data-diagram-source]'));
    if (!blocks.length || typeof mermaid === 'undefined') return done();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      // The ONE token map, shared with the in-app NodeView — bundled to
      // share-runtime/diagram-theme.js because this script can't import.
      // Absent (a stale share-runtime build), base's own defaults render
      // rather than nothing.
      themeVariables:
        typeof mantleMermaidTheme === 'function' ? mantleMermaidTheme() : undefined,
      // BOTH levels: v11 flowchart only honours the top-level flag.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      // Invalid source keeps its labelled source block — never mermaid's
      // injected bomb/"Syntax error" graphic in the PDF.
      suppressErrorRendering: true,
    });
    let seq = 0;
    for (const el of blocks) {
      const code = el.querySelector('pre code');
      const src = ((code && code.textContent) || '').trim();
      if (!src) continue;
      try {
        const { svg } = await mermaid.render('print-diagram-' + ++seq, src);
        const host = document.createElement('div');
        host.className = 'diagram-render';
        host.innerHTML = svg;
        el.replaceWith(host);
      } catch (e) {
        /* invalid source: the labelled source block stays in the PDF */
      }
    }
  } finally {
    done();
  }
})();
`;

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

    // Diagram blocks render client-side in the sidecar's Chromium (script
    // above). The script tag carries data-diagram-print so render-pdf can tell
    // "no diagrams on this page" from "diagrams still rendering".
    const diagramScripts = html.includes('data-diagram-source')
      ? `<script src="/share-runtime/mermaid.min.js"></script><script src="/share-runtime/diagram-theme.js"></script><script data-diagram-print>${DIAGRAM_PRINT_SCRIPT}</script>`
      : '';

    return c.html(
      htmlPage(
        {
          title: page.title ?? 'Page', // htmlPage escapes
          // The brain's brand palette + display fonts, rendered into <html>,
          // so an exported PDF carries the same typography and accents as
          // every other surface. The forced white background below still wins:
          // the colour theme is the accent palette, not the light/dark mode,
          // so a PDF keeps printing light regardless of it.
          appearance: await loadAppearanceAttrs(user.id),
          // The compiled stylesheet pins html/body to overflow:hidden for the
          // app shell; a printed document needs natural height so Chromium
          // paginates it all.
          extraHead: `<style>html,body{overflow:visible!important;height:auto!important;background:#fff}</style>`,
        },
        // WYSIWYG: render only the page content — no injected page-name
        // heading, matching the public share surface and the Markdown export.
        `<article class="ProseMirror prose prose-accent mx-auto ${widthClass} px-10 py-8"><div>${html}</div></article>${diagramScripts}`,
      ),
    );
  });
}
