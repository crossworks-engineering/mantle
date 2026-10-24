/**
 * The frame document of a Present canvas, for the frame route
 * (server/web/lib/canvas-frame.ts) and the sidecar render (./sidecar.ts)
 * alike: one builder, so a picture shows what the frame runs. Server only:
 * it reads the brain's public files and the owner's appearance.
 *
 * Here, not in server/web, because every process that runs a tool may
 * render a canvas: the agent turns run in server/api, the local MCP in
 * server/mcp. One image ships them all, and server/web/public with them.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCanvasFrameHtml } from '@mantle/share-ui/canvas-frame-html';
import { appearanceFontVars, resolveAppearanceAttrs } from '@mantle/share-ui/appearance';
import { INTER_FONT_FACE_CSS, displayFontFaceCss } from '@mantle/client-types/display-fonts';
import { loadProfilePreferences } from '@mantle/content';
import type { PresentMeta } from '@mantle/db';

/** The brain's public directory (server/web/public): found from this
 *  module's place in the repo, then from the process's cwd (server/web
 *  runs there, server/api and server/mcp beside it). */
export function publicDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const tries = [
    resolve(here, '../../../../server/web/public'),
    resolve(process.cwd(), 'public'),
    resolve(process.cwd(), '../web/public'),
    resolve(process.cwd(), 'server/web/public'),
  ];
  return tries.find((d) => existsSync(join(d, 'canvas-runtime'))) ?? tries[0]!;
}

/** The canvas runtime import map, read once from the generated public/
 *  asset (packages/app-build canvas-runtime.ts). The file changes only on
 *  deploy. */
let importMapPromise: Promise<string> | null = null;
export function loadCanvasImportMap(): Promise<string> {
  if (!importMapPromise) {
    importMapPromise = readFile(join(publicDir(), 'canvas-runtime/manifest.json'), 'utf8')
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
 *  Fail-soft: unreadable prefs keep the defaults (the fresh-install look,
 *  as server/web/server/pages/appearance.ts reads them). */
export async function canvasFontCss(ownerId: string): Promise<string> {
  let attrs;
  try {
    const prefs = await loadProfilePreferences(ownerId);
    attrs = resolveAppearanceAttrs({
      colorTheme: prefs.colorTheme ?? null,
      fontLogo: prefs.fontLogo ?? null,
      fontTitle: prefs.fontTitle ?? null,
      fontUi: prefs.fontUi ?? null,
      fontProse: prefs.fontProse ?? null,
      fontSize: prefs.fontSize ?? null,
      fontLogoSize: prefs.fontLogoSize ?? null,
      fontTitleSize: prefs.fontTitleSize ?? null,
      fontProseSize: prefs.fontProseSize ?? null,
      avatarStyle: prefs.avatarStyle ?? null,
      avatarTint: prefs.avatarTint ?? null,
      backgrounds: prefs.backgrounds ?? null,
    });
  } catch {
    attrs = resolveAppearanceAttrs(null);
  }
  const vars = attrs ? Object.entries(appearanceFontVars(attrs)) : [];
  const root = vars.length ? `:root{${vars.map(([k, v]) => `${k}:${v}`).join(';')}}` : '';
  return [INTER_FONT_FACE_CSS, displayFontFaceCss(), root].filter(Boolean).join('\n');
}

/** The frame document of a canvas. `nonce` is the frame's proof for its
 *  parent page (none for a sidecar render, which has no parent). */
export async function canvasFrameDocument(
  ownerId: string,
  canvas: { source: string; css: string; meta: PresentMeta },
  theme: { cls: string; colorTheme: string | null },
  nonce?: string,
): Promise<string> {
  const [importMapJson, fontCss] = await Promise.all([
    loadCanvasImportMap(),
    canvasFontCss(ownerId),
  ]);
  return buildCanvasFrameHtml({
    source: canvas.source,
    css: canvas.css,
    importMapJson,
    cls: theme.cls.slice(0, 200),
    colorTheme: theme.colorTheme?.slice(0, 60) || null,
    size: canvas.meta.size,
    theme: canvas.meta.theme,
    fontCss,
    ...(nonce ? { nonce } : {}),
  });
}
