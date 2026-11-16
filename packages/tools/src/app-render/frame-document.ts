/**
 * The frame document of a mini app for a picture (app-render/sidecar.ts):
 * the same builder and CSP the frame route uses
 * (@mantle/share-ui/app-frame-html, server/web/lib/app-frame.ts), so a
 * picture shows what the app runs. The bundle and its CSS are read from
 * object storage here, in the tool's process; the sidecar holds no ticket.
 *
 * Here, not in server/web, for the canvas's reason (canvas-render/
 * frame-document.ts): every process that runs a tool may draw an app.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { getContent } from '@mantle/storage';
import {
  appLibraryScripts,
  buildAppFrameCsp,
  buildAppFrameHtml,
} from '@mantle/share-ui/app-frame-html';
import { decodeDriftSpec, encodeDriftSpec } from '@mantle/content-core/drift-spec';
import { loadProfilePreferences } from '@mantle/content';
import type { AppViewer } from '@mantle/client-types/app-viewer';
import { publicDir } from '../canvas-render/frame-document';

/** The app runtime import map and the library files it names, read once
 *  from the generated public/ asset (it changes only on deploy). */
type ImportMap = { json: string; libraryScripts: string[] };
let importMapPromise: Promise<ImportMap> | null = null;
export function loadAppImportMap(): Promise<ImportMap> {
  if (!importMapPromise) {
    importMapPromise = readFile(join(publicDir(), 'app-runtime/manifest.json'), 'utf8')
      .then((raw) => {
        const m = JSON.parse(raw) as { imports: Record<string, string> };
        return {
          json: JSON.stringify({ imports: m.imports }),
          libraryScripts: appLibraryScripts(m.imports),
        };
      })
      .catch((e: unknown) => {
        importMapPromise = null; // let the next render retry
        throw e;
      });
  }
  return importMapPromise;
}

async function storedText(key: string): Promise<string> {
  const { body } = await getContent(key);
  const chunks: Buffer[] = [];
  for await (const chunk of body as Readable) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

/** The brain's backdrop (Drift) and color theme, as the owner frame reads
 *  them. Fail-soft: unreadable prefs draw the plain themed ground. */
async function appearance(ownerId: string): Promise<{ neat: string | null; ct: string | null }> {
  try {
    const prefs = await loadProfilePreferences(ownerId);
    const spec = decodeDriftSpec(prefs.neatBackground);
    return {
      neat: spec ? encodeDriftSpec(spec) : null,
      ct: typeof prefs.colorTheme === 'string' ? prefs.colorTheme.slice(0, 60) : null,
    };
  } catch {
    return { neat: null, ct: null };
  }
}

/** The frame document, its CSP (for `origin`) and the library files the
 *  render may serve. */
export async function appFrameDocument(
  ownerId: string,
  origin: string,
  build: { storageKey: string; css?: { storageKey: string } | null },
  viewer: AppViewer | null,
  theme: 'light' | 'dark',
): Promise<{ html: string; csp: string; libraryScripts: readonly string[] }> {
  const [bundleCode, appCss, importMap, look] = await Promise.all([
    storedText(build.storageKey),
    build.css ? storedText(build.css.storageKey).catch(() => '') : Promise.resolve(''),
    loadAppImportMap(),
    appearance(ownerId),
  ]);
  const html = buildAppFrameHtml({
    bundleCode,
    appCss,
    importMapJson: importMap.json,
    cls: theme === 'dark' ? 'dark' : '',
    colorTheme: look.ct,
    // The app's own full screen: the iframe is the viewport.
    viewport: true,
    neatSpec: look.neat,
    viewer,
  });
  return {
    html,
    csp: buildAppFrameCsp(origin, importMap.libraryScripts),
    libraryScripts: importMap.libraryScripts,
  };
}
