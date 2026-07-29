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
 * Theme comes from the page's own resolved CSS tokens — fills use chart-1..5,
 * label text uses foreground roles, matching the in-editor NodeView. On any
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
    const cs = getComputedStyle(document.documentElement);
    const t = (n, f) => (cs.getPropertyValue(n) || '').trim() || f;
    const charts = [1, 2, 3, 4, 5].map((i) =>
      t('--chart-' + i, ['#666ed1', '#ae467f', '#ad5700', '#4b830f', '#00889b'][i - 1]),
    );
    const fg = t('--foreground', '#1f2328');
    const vars = {
      fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
      background: t('--background', '#ffffff'),
      mainBkg: t('--muted', '#f6f8fa'),
      primaryColor: t('--muted', '#f6f8fa'),
      primaryTextColor: fg,
      primaryBorderColor: t('--border', '#d1d9e0'),
      secondaryColor: t('--card', '#ffffff'),
      secondaryTextColor: fg,
      secondaryBorderColor: t('--border', '#d1d9e0'),
      tertiaryColor: t('--background', '#ffffff'),
      tertiaryTextColor: fg,
      tertiaryBorderColor: t('--border', '#d1d9e0'),
      lineColor: t('--muted-foreground', '#59636e'),
      textColor: fg,
      noteBkgColor: t('--muted', '#f6f8fa'),
      noteTextColor: fg,
      noteBorderColor: t('--border', '#d1d9e0'),
    };
    charts.forEach((c, i) => {
      vars['pie' + (i + 1)] = c;
      vars['cScale' + i] = c;
      vars['git' + i] = c;
    });
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      themeVariables: vars,
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
      ? `<script src="/share-runtime/mermaid.min.js"></script><script data-diagram-print>${DIAGRAM_PRINT_SCRIPT}</script>`
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
