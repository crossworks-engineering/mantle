import { presentPosterSrc } from '@mantle/content-core/markdown-refs';
import type { Context } from 'hono';
import { getPage, getDraw, getDrawSvg, referencedPresentIds } from '@mantle/content';
import { getPresentEmbedFacts } from '@/lib/presents';
import { requireOwnerForRender } from '@/lib/auth';
import { renderPageDoc } from '@/lib/render-page-doc';
import { htmlPage } from './template';
import { jsonForScript } from '@/lib/json-script';
import { loadAppearanceAttrs } from './appearance';
import type { PageRoute } from '../route-loader';

/**
 * Content Security Policy for the print surfaces: this origin only, and no
 * script at all. A render engine (the documents engine, or the browser
 * sidecar) loads these pages carrying a render cookie
 * (lib/render-sandbox.ts, packages/documents), so a page image or any other
 * subresource with an outside src must not load: the engine's allow list or
 * the sidecar's interception refuses it,
 * and this policy refuses it again in the page itself (audit F01). data: and
 * blob: stay open for images and fonts (the draw snapshot is a data: image).
 */
export const PRINT_CSP = [
  "default-src 'none'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * The draw render surface runs our own bundle (the Excalidraw renderer), so it
 * needs script; the point of this policy is the same as PRINT_CSP's: nothing
 * outside this origin. Eval and wasm stay allowed for the renderer's font
 * subsetting; they cannot reach another origin either.
 */
export const RENDER_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self' data: blob:",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data: blob:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

// Draws: the committed SVG snapshot on a white sheet. No scripts at all —
// the snapshot is already final pixels (fonts inlined by exportToSvg), so
// there is no data-diagram-print marker and render-pdf doesn't wait.
//
// The snapshot is embedded as a data: IMAGE, not as inline markup. This page
// is loaded by headless Chromium carrying an owner render cookie, so markup
// injected here would execute authenticated as that admin. As an <img> it is
// a script-disabled document, and a `data:` source can't reach the network
// either.
async function printDraw(c: Context): Promise<Response> {
  const id = c.req.param('id') ?? '';
  const user = await requireOwnerForRender(id); // throws RedirectError → 307 /login
  const svg = await getDrawSvg(user.id, id);
  if (!svg) return c.notFound();
  c.header('Content-Security-Policy', PRINT_CSP);
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
}

// Regeneration surface for the draw snapshot cache. Not a print page and not
// linked from anywhere: the browser sidecar loads it, the render island runs
// the real (browser-only) Excalidraw renderer here, and lib/render-draw-svg.ts
// reads the SVG back out. Authed exactly like /print, so the sidecar must
// carry a render cookie for this drawing. See docs/draw-render-fallback-plan.md.
async function renderDraw(c: Context): Promise<Response> {
  const id = c.req.param('id') ?? '';
  const user = await requireOwnerForRender(id); // throws RedirectError → 307 /login
  const draw = await getDraw(user.id, id);
  if (!draw) return c.notFound();
  c.header('Content-Security-Policy', RENDER_CSP);
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
}

// A Page (port of app/print/pages/[id]): just the content in the shared
// `.ProseMirror .prose` container, so it reuses the editor CSS from the
// compiled share-runtime stylesheet.
async function printPage(c: Context): Promise<Response> {
  const id = c.req.param('id') ?? '';
  const user = await requireOwnerForRender(id); // throws RedirectError → 307 /login
  const page = await getPage(user.id, id);
  if (!page) return c.notFound();
  // An image with an outside src (a page built from web or email content
  // can carry one) prints as a broken image: the policy refuses it.
  c.header('Content-Security-Policy', PRINT_CSP);

  // The canvases the page embeds that have a snapshot for this caller: the
  // rest print as a bare placeholder, never a broken picture with its alt.
  const printable = new Set<string>();
  for (const cid of new Set(referencedPresentIds(page.doc))) {
    const facts = await getPresentEmbedFacts(user.id, cid).catch(() => null);
    if (facts?.posterRev != null) printable.add(cid);
  }

  // Same authed asset path the in-app editor uses; the render cookie is
  // accepted there, so embedded images load in the sidecar.
  const html = renderPageDoc(page.doc, {
    assetUrl: (fileId: string) => `/api/files/files/${fileId}?raw=1`,
    // nofill=1 is REQUIRED here: this page is loaded by a render engine, so
    // a render triggered from it would need a second sidecar session while
    // this one blocks on the image (both engines wait for the network to go
    // idle).
    // The export route warms the cache before printing; an unrendered
    // drawing degrades to its placeholder rather than deadlocking.
    drawUrl: (drawId: string) => `/api/draws/${encodeURIComponent(drawId)}/svg?raw=1&nofill=1`,
    // A canvas's snapshot is a stored picture, never rendered on read, so
    // it needs no nofill: the poster route spends no sidecar time.
    presentUrl: (presentId: string) =>
      printable.has(presentId) ? presentPosterSrc(presentId) : null,
    // A render engine prints the document as one: every image must be in
    // (a lazy image below the fold loaded today only because page.pdf
    // forces layout; task 5dda95ee).
    imageLoading: 'eager',
  });
  const widthClass = page.width === 'wide' ? 'max-w-5xl' : 'max-w-3xl';

  // Legacy `diagram` blocks print as their degrade markup (a labelled source
  // block) — the Mermaid engine was retired 2026-08; render-pdf's wait
  // tolerates the missing data-diagram-print script and passes immediately.

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
      `<article class="ProseMirror prose prose-accent prose-document mx-auto ${widthClass} px-10 py-8"><div>${html}</div></article>`,
    ),
  );
}

/**
 * The render surfaces: admin-only pages with no app chrome. A render engine
 * (the documents engine or the browser sidecar, lib/render-pdf.ts) navigates
 * here with a render cookie for the acting admin and prints the page for the
 * `?format=pdf` download.
 * Not linked from the UI. Every surface here opens for an admin session, or
 * for a render cookie naming the node in the URL (requireOwnerForRender).
 *
 * The route loader registers them with their ROUTE_POLICY rows (class
 * 'render', registerPages; arch A4 step 2), and the gate runs each through
 * enterCall, as system(http:render) (the row's startsAs) until
 * requireOwnerForRender names its login. This list is the one place the
 * render patterns are named: a row is class 'render' because app.ts
 * registers it from here with that class.
 */
export const PRINT_PAGES: readonly PageRoute[] = [
  { pattern: '/print/draws/:id', methods: ['GET'], handle: printDraw },
  { pattern: '/render/draws/:id', methods: ['GET'], handle: renderDraw },
  { pattern: '/print/pages/:id', methods: ['GET'], handle: printPage },
];
