/**
 * Server-side renderer for a Present canvas's sandbox FRAME document (see
 * @mantle/share-ui/canvas-frame-html for the document and why it is built
 * this way; docs/proposals/canvas-files.md section 5.2). Auth is the route's
 * (a canvas frame ticket); this module only renders.
 */
import { NextResponse } from '@/server/http-compat';
import { buildCanvasFrameCsp } from '@mantle/share-ui/canvas-frame-html';
import type { PresentMeta } from '@mantle/db';
import { env } from '@mantle/config';
import { requestOrigin } from '@/lib/auth-constants';
import { canvasFrameDocument, loadCanvasImportMap } from '@mantle/tools/canvas-frame-document';

export { canvasFrameDocument };

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

/** The canvas runtime's import map specifiers (what a canvas may import by
 *  name), for the save check (content-core canvasLoadProblems). */
export async function canvasModuleNames(): Promise<string[]> {
  return Object.keys((JSON.parse(await loadCanvasImportMap()) as { imports: object }).imports);
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
  nonce: string,
): Promise<Response> {
  const url = new URL(req.url);
  const html = await canvasFrameDocument(
    ownerId,
    canvas,
    { cls: url.searchParams.get('cls') ?? '', colorTheme: url.searchParams.get('ct') },
    nonce,
  );
  return new NextResponse(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // The sandbox and the no-network policy, as a HEADER, applied before
      // any parsing (section 5.2).
      'content-security-policy': buildCanvasFrameCsp(requestOrigin(req), frameAncestors()),
      'x-content-type-options': 'nosniff',
      // No DNS lookups ahead of a navigation a canvas names (a prefetch is
      // a lookup the CSP does not see).
      'x-dns-prefetch-control': 'off',
      // The parent embeds the frame with a required CSP (the iframe's `csp`
      // attribute, canvas-sandbox.tsx): this document takes it. A page the
      // canvas navigated to that does not say so is not loaded at all.
      'allow-csp-from': '*',
      // No Cache-Control here: /api answers no-store by default.
      'referrer-policy': 'no-referrer',
    },
  });
}
