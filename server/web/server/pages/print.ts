import type { Hono } from 'hono';
import { getPage, getDraw, getDrawSvg } from '@mantle/content';
import { requireOwner } from '@/lib/auth';
import { renderPageDoc } from '@/lib/render-page-doc';
import { htmlPage } from './template';
import { jsonForScript } from '@/lib/json-script';
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
  // Draws: the committed SVG snapshot on a white sheet. No scripts at all —
  // the snapshot is already final pixels (fonts inlined by exportToSvg), so
  // there is no data-diagram-print marker and render-pdf doesn't wait.
  //
  // The snapshot is embedded as a data: IMAGE, not as inline markup. This page
  // is loaded by headless Chromium carrying an owner render cookie, so markup
  // injected here would execute authenticated as the owner — the most valuable
  // context in the system. As an <img> it is a script-disabled document, and a
  // `data:` source can't reach the network either.
  app.get('/print/draws/:id', async (c) => {
    const user = await requireOwner(); // throws RedirectError → 307 /login
    const svg = await getDrawSvg(user.id, c.req.param('id'));
    if (!svg) return c.notFound();
    const src = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
    return c.html(
      htmlPage(
        {
          title: 'Drawing',
          appearance: await loadAppearanceAttrs(user.id),
          extraHead: `<style>html,body{overflow:visible!important;height:auto!important;background:#fff}img{max-width:100%;height:auto}</style>`,
        },
        `<div style="padding:2rem"><img src="${src}" alt=""></div>`,
      ),
    );
  });

  // Regeneration surface for the draw snapshot cache. Not a print page and not
  // linked from anywhere: the browser sidecar loads it, the render island runs
  // the real (browser-only) Excalidraw renderer here, and lib/render-draw-svg.ts
  // reads the SVG back out. Owner-authed exactly like /print, so the sidecar
  // must carry the internal render cookie. See docs/draw-render-fallback-plan.md.
  app.get('/render/draws/:id', async (c) => {
    const user = await requireOwner(); // throws RedirectError → 307 /login
    const draw = await getDraw(user.id, c.req.param('id'));
    if (!draw) return c.notFound();
    // The COMMITTED scene only. A draft must never reach a render surface,
    // for the same reason it never reaches a share or an export.
    return c.html(
      htmlPage(
        {
          title: 'Rendering drawing',
          extraHead:
            `<style>html,body{margin:0;background:#fff}</style>` +
            // Must be set before the package initialises, or it reaches for
            // the CDN. This tier serves its own copy of the fonts (they get
            // inlined into the SVG, so they have to be the same files).
            `<script>window.EXCALIDRAW_ASSET_PATH='/excalidraw-assets/';` +
            `window.__mantleDrawScene=${jsonForScript(draw.scene)};` +
            // Scene images live in the files pipeline; without the map the
            // render would draw empty frames and then overwrite a good
            // snapshot with the worse one.
            `window.__mantleDrawFileRefs=${jsonForScript(draw.fileRefs)};</script>` +
            `<script type="module" src="/share-runtime/draw-render.js"></script>`,
        },
        '',
      ),
    );
  });

  app.get('/print/pages/:id', async (c) => {
    const user = await requireOwner(); // throws RedirectError → 307 /login
    const page = await getPage(user.id, c.req.param('id'));
    if (!page) return c.notFound();

    // Same authed asset path the in-app editor uses, so embedded images load
    // under the forwarded owner cookie.
    const html = renderPageDoc(page.doc, {
      assetUrl: (fileId: string) => `/api/files/files/${fileId}?raw=1`,
      // nofill=1 is REQUIRED here: this page is loaded by the sidecar, so a
      // render triggered from it would need a second sidecar session while
      // this one blocks on the image (renderUrlToPdf waits for networkidle0).
      // The export route warms the cache before printing; an unrendered
      // drawing degrades to its placeholder rather than deadlocking.
      drawUrl: (drawId: string) => `/api/draws/${encodeURIComponent(drawId)}/svg?raw=1&nofill=1`,
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
        `<article class="ProseMirror prose prose-accent prose-document mx-auto ${widthClass} px-10 py-8"><div>${html}</div></article>${diagramScripts}`,
      ),
    );
  });
}
