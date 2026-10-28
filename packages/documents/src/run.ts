import { InputError } from '@mantle/std';
import { saveExport } from '@mantle/files';
import { callGotenberg, type GotenbergAnswer } from './client';
import { appendOptions, checkOptions } from './form';
import {
  resolveInputs,
  type DocumentsCaller,
  type DocumentsInputs,
  type InputDeps,
} from './inputs';
import { findRoute, type RouteDef } from './routes';

/**
 * One call of the documents engine, from any surface: the route by key, the
 * inputs resolved for the caller, the options checked, the form posted, and
 * the answer either landed as a file node (the saveExport rules: Auto-filed /
 * Exports for an Admin user, else the top of Files) or handed back as bytes.
 * The two JSON routes (metadata/read, bookmarks/read) answer JSON and save
 * nothing.
 */
export type DocumentsCall = {
  /** The route key: the Gotenberg path without `/forms/`. */
  route: string;
  inputs?: DocumentsInputs | Record<string, unknown>;
  options?: Record<string, unknown>;
  /** The output name's stem (the extension follows the output kind). */
  filename?: string;
};

export type DocumentsFile = {
  id: string;
  name: string;
  path: string;
  sizeBytes: number;
  mimeType: string;
  landedIn: { id: string; name: string } | null;
};

export type DocumentsResult =
  | { kind: 'file'; route: string; file: DocumentsFile }
  | { kind: 'bytes'; route: string; bytes: Buffer; contentType: string; filename: string }
  | { kind: 'json'; route: string; json: unknown };

/** The extension an answer's content type gets. */
export function extensionFor(contentType: string): string {
  switch (contentType) {
    case 'application/pdf':
      return 'pdf';
    case 'application/zip':
      return 'zip';
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    default:
      return 'bin';
  }
}

const OP_SUFFIX: Record<string, string> = {
  'pdfengines/merge': 'merged',
  'pdfengines/split': 'split',
  'pdfengines/flatten': 'flat',
  'pdfengines/convert': 'archival',
  'pdfengines/metadata/write': 'tagged',
  'pdfengines/encrypt': 'locked',
  'pdfengines/embed': 'with-attachments',
  'pdfengines/watermark': 'watermarked',
  'pdfengines/stamp': 'stamped',
  'pdfengines/rotate': 'rotated',
  'pdfengines/bookmarks/write': 'outlined',
  'pdfengines/optimize': 'small',
  'pdfengines/factur-x': 'factur-x',
};

/** A safe stem: the caller's, or the input's, with the op's suffix for a
 *  PDF tool, cut to what a filename takes. */
export function outputStem(
  route: RouteDef,
  callerStem: string | undefined,
  inputStem: string,
): string {
  const given = (callerStem ?? '').trim().replace(/\.(pdf|zip|png|jpe?g|webp)$/i, '');
  const base =
    (given || inputStem)
      .replace(/[^\p{L}\p{N} ._()[\]-]+/gu, '-')
      .replace(/\.{2,}/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 120) || 'document';
  const suffix = given ? '' : OP_SUFFIX[route.key];
  return suffix ? `${base}-${suffix}` : base;
}

/** The route for a call, or an InputError that names the keys. */
export function routeFor(key: string): RouteDef {
  const route = findRoute(key);
  if (!route) {
    throw new InputError(
      `unknown documents route '${key}'; the routes are chromium/convert/{html,markdown,url}, chromium/screenshot/{html,markdown,url}, libreoffice/convert and pdfengines/{merge,split,flatten,convert,metadata/read,metadata/write,encrypt,embed,watermark,stamp,rotate,bookmarks/read,bookmarks/write,optimize,factur-x}`,
    );
  }
  return route;
}

/** The bounded diagram wait of a page print: the print surface marks
 *  data-diagrams-ready when its diagrams rendered (or failed); a page with
 *  none passes at once; a hung render prints the source blocks after 15 s,
 *  never a failed export (plan section 2). */
export const PAGE_WAIT_EXPRESSION =
  "!document.querySelector('script[data-diagram-print]') || document.documentElement.hasAttribute('data-diagrams-ready') || performance.now() > 15000";
/** A drawing print: its one image decoded. */
export const DRAW_WAIT_EXPRESSION =
  "(() => { const i = document.querySelector('img'); return !!i && i.complete && i.naturalWidth > 0; })()";

/** The engine's main-URL status codes a node print fails on: the print
 *  surface answers 403 for a render cookie it refuses and 404 for a node
 *  with nothing to print; the engine's own default covers 499 and 599. */
const NODE_FAIL_CODES = [403, 404, 499, 599];

/** The whole form of one call: the parts, the node URL and cookie, and the
 *  options (with the node defaults a caller did not set). Exported for
 *  tests; runDocuments posts it. */
export async function buildForm(
  call: DocumentsCall,
  caller: DocumentsCaller,
  deps?: InputDeps,
): Promise<{ route: RouteDef; form: FormData; stem: string; exportOf: string | null }> {
  const route = routeFor(call.route);
  const options = checkOptions(route, call.options);
  const resolved = await resolveInputs(route, call.inputs, caller, deps);
  const form = new FormData();
  for (const p of resolved.parts) {
    form.append(p.field, new Blob([new Uint8Array(p.bytes)]), p.filename);
  }
  if (resolved.node) {
    form.append('url', resolved.node.url);
    form.append('cookies', resolved.node.cookieJson);
    // A caller may add codes, never take the surface's refusals (403, 404)
    // or the engine's own ranges away: an error page is never the document.
    const given = (options.failOnHttpStatusCodes as number[] | undefined) ?? [];
    options.failOnHttpStatusCodes = [...new Set([...given, ...NODE_FAIL_CODES])];
    if (options.waitForExpression === undefined) {
      options.waitForExpression =
        resolved.node.kind === 'page' ? PAGE_WAIT_EXPRESSION : DRAW_WAIT_EXPRESSION;
    }
    if (route.output === 'pdf' && options.skipNetworkIdleEvent === undefined)
      options.skipNetworkIdleEvent = false;
    if (route.output === 'pdf' && options.printBackground === undefined)
      options.printBackground = true;
    if (route.output === 'image' && resolved.node.kind === 'draw' && options.selector === undefined)
      options.selector = 'img';
  }
  appendOptions(form, options);
  return {
    route,
    form,
    stem: outputStem(route, call.filename, resolved.stem),
    exportOf: resolved.exportOf,
  };
}

/** Run one call: land the answer as a file (`mode` 'file'), or hand the
 *  bytes back ('bytes'); a JSON route answers JSON either way. */
export async function runDocuments(
  call: DocumentsCall,
  caller: DocumentsCaller,
  mode: 'file' | 'bytes' = 'file',
  deps?: InputDeps,
): Promise<DocumentsResult> {
  const { route, form, stem, exportOf } = await buildForm(call, caller, deps);
  const answer: GotenbergAnswer = await callGotenberg(route, form, { outputName: stem });
  if (route.output === 'json') {
    let json: unknown;
    try {
      json = JSON.parse(answer.bytes.toString('utf8'));
    } catch {
      throw new InputError(`the engine answered ${route.key} with something other than JSON`);
    }
    return { kind: 'json', route: route.key, json };
  }
  const filename = `${stem}.${extensionFor(answer.contentType)}`;
  if (mode === 'bytes') {
    return {
      kind: 'bytes',
      route: route.key,
      bytes: answer.bytes,
      contentType: answer.contentType,
      filename,
    };
  }
  const saved = await saveExport({
    ownerId: caller.ownerId,
    filename,
    bytes: answer.bytes,
    data: { ...(exportOf ? { exportOf } : {}), documentsRoute: route.key },
  });
  return {
    kind: 'file',
    route: route.key,
    file: {
      id: saved.file.id,
      name: saved.file.filename,
      path: `${saved.file.parentPath}/${saved.file.filename}`,
      sizeBytes: saved.file.sizeBytes,
      mimeType: saved.file.mimeType,
      landedIn: saved.landedIn,
    },
  };
}
