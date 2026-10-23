/**
 * Server-side renderer for a Present canvas's sandbox FRAME document (see
 * @mantle/share-ui/canvas-frame-html for the document and why it is built
 * this way; docs/proposals/canvas-files.md section 5.2). Auth is the route's
 * (a canvas frame ticket); this module only renders.
 */
import { readFile } from 'node:fs/promises';
import { NextResponse } from '@/server/http-compat';
import { buildCanvasFrameCsp, buildCanvasFrameHtml } from '@mantle/share-ui/canvas-frame-html';
import { appearanceFontVars } from '@mantle/share-ui/appearance';
import { INTER_FONT_FACE_CSS, displayFontFaceCss } from '@mantle/client-types/display-fonts';
import type { PresentMeta } from '@mantle/db';
import { env } from '@mantle/config';
import { requestOrigin } from '@/lib/auth-constants';
import { loadAppearanceAttrs } from '@/server/pages/appearance';

/** The canvas runtime import map, read once from the generated public/
 *  asset (packages/app-build canvas-runtime.ts; cwd is server/web, as for
 *  the app runtime). The file changes only on deploy. */
let importMapPromise: Promise<string> | null = null;
function loadCanvasImportMap(): Promise<string> {
  if (!importMapPromise) {
    importMapPromise = readFile('public/canvas-runtime/manifest.json', 'utf8')
      .then((raw) => {
        const m = JSON.parse(raw) as { imports: Record<string, string> };
        return JSON.stringify({ imports: m.imports });
      })
      .catch((e: unknown) => {
        importMapPromise = null; // let the next request retry
        throw e;
      });
  }
  return importMapPromise;
}

/** Inter, the Appearance library faces, and the owner's chosen interface
 *  and prose fonts as the root vars a canvas reads (`var(--font-sans)`).
 *  Fail-soft: unreadable prefs keep the defaults. */
async function canvasFontCss(ownerId: string): Promise<string> {
  const attrs = await loadAppearanceAttrs(ownerId);
  const vars = attrs ? Object.entries(appearanceFontVars(attrs)) : [];
  const root = vars.length ? `:root{${vars.map(([k, v]) => `${k}:${v}`).join(';')}}` : '';
  return [INTER_FONT_FACE_CSS, displayFontFaceCss(), root].filter(Boolean).join('\n');
}

/** The local owner UIs: the desktop app serves its renderer from
 *  http://127.0.0.1 on a port it picks at launch, and the detached dev
 *  frontend runs on localhost. Neither origin is ever a stranger's site, and
 *  a page there still needs the owner's credential to mint a ticket. */
const LOCAL_CLIENT_ANCESTORS = ['http://127.0.0.1:*', 'http://localhost:*'];

const ORIGIN_RE = /^https?:\/\/[^\s;,'"*]+$/;

/** The origins that may frame a canvas (CSP frame-ancestors): the brain's
 *  own, the split owner UI's, the named cross-origin clients and the local
 *  ones. A `*` in MANTLE_API_CORS_ORIGINS (any origin may call) is not
 *  carried over: a canvas is framed only by an origin named here. */
function frameAncestors(): string[] {
  const named = (env('MANTLE_API_CORS_ORIGINS') ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter((s) => ORIGIN_RE.test(s));
  const client = (env('MANTLE_CLIENT_ORIGIN') ?? '').trim().replace(/\/+$/, '');
  return [...(ORIGIN_RE.test(client) ? [client] : []), ...named, ...LOCAL_CLIENT_ANCESTORS];
}

/**
 * Render the frame document of a canvas already authorized. Query params
 * carry PRESENTATION only (the host's theme class and data-color-theme) and
 * grant nothing.
 */
export async function renderCanvasFrame(
  req: Request,
  ownerId: string,
  canvas: { source: string; css: string; meta: PresentMeta },
): Promise<Response> {
  const url = new URL(req.url);
  const [importMapJson, fontCss] = await Promise.all([
    loadCanvasImportMap(),
    canvasFontCss(ownerId),
  ]);
  const html = buildCanvasFrameHtml({
    source: canvas.source,
    css: canvas.css,
    importMapJson,
    cls: (url.searchParams.get('cls') ?? '').slice(0, 200),
    colorTheme: url.searchParams.get('ct')?.slice(0, 60) || null,
    size: canvas.meta.size,
    theme: canvas.meta.theme,
    fontCss,
  });
  return new NextResponse(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // The sandbox and the no-network policy, as a HEADER, applied before
      // any parsing (section 5.2).
      'content-security-policy': buildCanvasFrameCsp(requestOrigin(req), frameAncestors()),
      'x-content-type-options': 'nosniff',
      // No Cache-Control here: /api answers no-store by default.
      'referrer-policy': 'no-referrer',
    },
  });
}
