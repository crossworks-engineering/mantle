/**
 * Server-side renderer for the mini-app sandbox FRAME document (see
 * @mantle/share-ui/app-frame-html for the document itself and why it exists).
 * Shared by the owner route (/api/apps/[id]/frame, draft build allowed) and
 * the share route (/s/[token]/frame, published build only). Auth happens in
 * the routes (frame ticket verification); this module only loads and renders.
 */
import { readFile } from 'node:fs/promises';
import { NextResponse } from '@/server/http-compat';
import { getContent } from '@mantle/storage';
import { buildAppFrameCsp, buildAppFrameHtml } from '@mantle/share-ui/app-frame-html';
import { requestOrigin } from '@/lib/auth-constants';
import type { Readable } from 'node:stream';

/** The shared-runtime import map, read once from the generated public/ asset
 *  (cwd is server/web in dev and in the image — same relative convention as
 *  the other on-disk reads). Cached for the process: the file only changes on
 *  deploy. */
let importMapJsonPromise: Promise<string> | null = null;
function loadImportMapJson(): Promise<string> {
  if (!importMapJsonPromise) {
    importMapJsonPromise = readFile('public/app-runtime/manifest.json', 'utf8')
      .then((raw) => {
        const m = JSON.parse(raw) as { imports: Record<string, string> };
        return JSON.stringify({ imports: m.imports });
      })
      .catch((e: unknown) => {
        importMapJsonPromise = null; // let the next request retry
        throw e;
      });
  }
  return importMapJsonPromise;
}

async function streamToString(body: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

/** A build as the routes hand it over — the JS key plus the optional CSS
 *  sidecar (absent on builds that predate per-app CSS). */
export type FrameBuild = { storageKey: string; css?: { storageKey: string } | null };

/**
 * Render the frame document for an already-authorized build. Query params
 * carry PRESENTATION only (theme class/attr + frame mode) — they are baked
 * into the document but grant nothing, so they ride the URL unverified.
 */
export async function renderAppFrame(req: Request, build: FrameBuild): Promise<Response> {
  const url = new URL(req.url);
  const [bundleCode, appCss, importMapJson] = await Promise.all([
    getContent(build.storageKey).then(({ body }) => streamToString(body)),
    build.css
      ? getContent(build.css.storageKey)
          .then(({ body }) => streamToString(body))
          .catch(() => '')
      : Promise.resolve(''),
    loadImportMapJson(),
  ]);
  const html = buildAppFrameHtml({
    bundleCode,
    appCss,
    importMapJson,
    cls: url.searchParams.get('cls') ?? '',
    colorTheme: url.searchParams.get('ct'),
    viewport: url.searchParams.get('vp') === '1',
  });
  return new NextResponse(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // The strict sandbox policy, as a HEADER — stronger than the old
      // srcdoc <meta> tag and applied before any parsing.
      'content-security-policy': buildAppFrameCsp(requestOrigin(req)),
      // The ticket in the URL is single-purpose and seconds-lived, but keep
      // the document itself out of shared caches.
      'cache-control': 'private, no-store',
    },
  });
}
