/**
 * A drawing's committed SVG snapshot (`draws.scene_svg`) rendered to a PNG,
 * for agents that can see images. The text an agent reads (`scene_text`)
 * keeps labels and `A -> B` relations but loses positions, colours, ticks,
 * switches and layout; a picture of the same drawing keeps all of it.
 *
 * Pure library, no browser: resvg (a Rust SVG renderer behind N-API) draws the
 * snapshot as stored. Nothing is re-rendered from the scene, so an uncommitted
 * draft can never reach a picture, and the picture is exactly what /s, the
 * list preview and export show.
 *
 * Fonts: exportToSvg inlines the fonts it used as `@font-face` rules with a
 * `data:font/woff2` source (subset to the glyphs in the drawing). resvg reads
 * no CSS fonts and no woff2, so each one is unpacked to TTF (wawoff2, wasm),
 * written to a temp folder for this one render and handed over as a font
 * file. System fonts load too, as a fallback for a glyph no embedded font has.
 *
 * Links: resvg loads an `<image href>` that is a bare file path from the local
 * disk. The snapshot is user data, so every `href` that is not an inline
 * picture (`data:image/…`) or a reference inside the document (`#id`) is
 * blanked before rendering. An inline SVG picture is safe: resvg does not
 * follow file paths inside it.
 *
 * Callers own access: hand this only an SVG the reader may see, with the
 * images they may not see already taken out (draw-reader.ts).
 */
// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- loads the local ambient type for the untyped wawoff2 module
/// <reference path="./wawoff2.d.ts" />
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The long edge of a rendered picture, in pixels. Big enough to read a
 *  whiteboard's small print, small enough to stay well under every vision
 *  model's image limits (the providers scale larger images down anyway). */
export const DRAW_PNG_LONG_EDGE = 2000;

/** A part of the scene, as fractions of its width and height (0 to 1, from
 *  the top-left corner). `{ x: 0.5, y: 0, width: 0.5, height: 0.5 }` is the
 *  top-right quarter. Rendered at the full long edge, so it zooms in. */
export type DrawRegion = { x: number; y: number; width: number; height: number };

export type DrawPng = {
  png: Buffer;
  width: number;
  height: number;
  /** The scene's own size (its viewBox), before any region. */
  sceneWidth: number;
  sceneHeight: number;
};

/** One tag's attributes, quoted values skipped whole. */
const ATTRS = `(?:[^>"']|"[^"]*"|'[^']*')*`;
const ROOT_SVG = new RegExp(`<svg\\b${ATTRS}>`, 'i');
const LINK_ATTR = /(\s)((?:xlink:)?href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const FONT_FACE = /@font-face\s*\{([^}]*)\}/gi;
const FONT_FAMILY_DECL = /font-family\s*:\s*([^;]+)/i;
const DATA_URL = /url\(\s*(["']?)(data:[^"')\s]+)\1\s*\)/gi;
const FONT_FAMILY_ATTR = /(\sfont-family\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi;
const FONT_FAMILY_STYLE = /(font-family\s*:\s*)([^;"']+)/gi;

/** Embedded fonts read per render. A real export holds a handful (one per
 *  family the drawing uses). */
const MAX_FONTS = 24;

/** The SVG with every link that could reach outside the document blanked. */
export function blankExternalHrefs(svg: string): string {
  return svg.replace(LINK_ATTR, (whole, sp: string, name: string, a?: string, b?: string) => {
    const v = (a ?? b ?? '').trim();
    return v.startsWith('#') || /^data:image\//i.test(v) ? whole : `${sp}${name}=""`;
  });
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? '') : null;
}

function setAttr(tag: string, name: string, value: string): string {
  const re = new RegExp(`(\\s${name}\\s*=\\s*)(?:"[^"]*"|'[^']*')`, 'i');
  if (re.test(tag)) return tag.replace(re, `$1"${value}"`);
  return tag.replace(/\s*\/?>$/, (end) => ` ${name}="${value}"${end.trim()}`);
}

/** The root viewBox: the attribute, else `0 0 width height`. */
function sceneBox(rootTag: string): [number, number, number, number] | null {
  const vb = attr(rootTag, 'viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (vb && vb.length === 4 && vb.every(Number.isFinite) && vb[2]! > 0 && vb[3]! > 0) {
    return vb as [number, number, number, number];
  }
  const w = parseFloat(attr(rootTag, 'width') ?? '');
  const h = parseFloat(attr(rootTag, 'height') ?? '');
  return w > 0 && h > 0 ? [0, 0, w, h] : null;
}

/** Whether a region is a usable part of the scene. */
export function validRegion(r: DrawRegion): boolean {
  const ok = (n: number) => Number.isFinite(n) && n >= 0 && n <= 1;
  return (
    ok(r.x) &&
    ok(r.y) &&
    ok(r.width) &&
    ok(r.height) &&
    r.width > 0 &&
    r.height > 0 &&
    r.x + r.width <= 1.000001 &&
    r.y + r.height <= 1.000001
  );
}

/** The family name an sfnt font calls itself (name table: typographic family
 *  16, else family 1). Null when the table is missing or unreadable. */
export function sfntFamilyName(font: Uint8Array): string | null {
  const v = new DataView(font.buffer, font.byteOffset, font.byteLength);
  try {
    const numTables = v.getUint16(4);
    let nameOff = -1;
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16;
      const tag = String.fromCharCode(font[rec]!, font[rec + 1]!, font[rec + 2]!, font[rec + 3]!);
      if (tag === 'name') nameOff = v.getUint32(rec + 8);
    }
    if (nameOff < 0) return null;
    const count = v.getUint16(nameOff + 2);
    const strings = nameOff + v.getUint16(nameOff + 4);
    const found = new Map<number, string>();
    for (let i = 0; i < count; i++) {
      const r = nameOff + 6 + i * 12;
      const platform = v.getUint16(r);
      const nameId = v.getUint16(r + 6);
      if ((nameId !== 1 && nameId !== 16) || found.has(nameId)) continue;
      const len = v.getUint16(r + 8);
      const at = strings + v.getUint16(r + 10);
      const bytes = font.subarray(at, at + len);
      let s = '';
      if (platform === 0 || platform === 3) {
        for (let j = 0; j + 1 < bytes.length; j += 2)
          s += String.fromCharCode((bytes[j]! << 8) | bytes[j + 1]!);
      } else {
        s = Buffer.from(bytes).toString('latin1');
      }
      if (s.trim()) found.set(nameId, s.trim());
    }
    return found.get(16) ?? found.get(1) ?? null;
  } catch {
    return null;
  }
}

function bareFamily(f: string): string {
  return f
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();
}

type EmbeddedFont = { cssFamily: string; sfnt: Uint8Array };

/** The fonts the snapshot inlines, unpacked to sfnt, and the SVG without
 *  their `@font-face` rules (resvg does not use them, and they are most of
 *  a snapshot's bytes). */
async function takeEmbeddedFonts(svg: string): Promise<{ svg: string; fonts: EmbeddedFont[] }> {
  const faces = [...svg.matchAll(FONT_FACE)].slice(0, MAX_FONTS);
  if (faces.length === 0) return { svg, fonts: [] };
  const { decompress } = await import('wawoff2');
  const fonts: EmbeddedFont[] = [];
  for (const face of faces) {
    const body = face[1] ?? '';
    const cssFamily = bareFamily(FONT_FAMILY_DECL.exec(body)?.[1] ?? '');
    for (const m of body.matchAll(DATA_URL)) {
      const comma = m[2]!.indexOf(',');
      if (comma < 0 || !/;base64$/i.test(m[2]!.slice(0, comma))) continue;
      const bytes = Buffer.from(m[2]!.slice(comma + 1), 'base64');
      const magic = bytes.subarray(0, 4).toString('latin1');
      try {
        if (magic === 'wOF2') fonts.push({ cssFamily, sfnt: await decompress(bytes) });
        else if (magic === 'OTTO' || magic === 'true' || bytes.readUInt32BE(0) === 0x00010000) {
          fonts.push({ cssFamily, sfnt: bytes });
        }
      } catch {
        // A font that does not unpack costs its glyphs (the fallback font
        // draws them), never the picture.
      }
    }
  }
  return { svg: svg.replace(FONT_FACE, ''), fonts };
}

/** Rename font families in the SVG's text to the names the font files carry,
 *  where the `@font-face` rule called a font something else. */
function renameFamilies(svg: string, rename: Map<string, string>): string {
  if (rename.size === 0) return svg;
  const mapList = (list: string) =>
    list
      .split(',')
      .map((f) => rename.get(bareFamily(f).toLowerCase()) ?? f.trim())
      .join(', ');
  return svg
    .replace(FONT_FAMILY_ATTR, (_w, pre: string, a?: string, b?: string) =>
      a !== undefined ? `${pre}"${mapList(a)}"` : `${pre}'${mapList(b ?? '')}'`,
    )
    .replace(FONT_FAMILY_STYLE, (_w, pre: string, list: string) => `${pre}${mapList(list)}`);
}

// Two renders at a time: each one holds a decoded scene and a full-size
// pixel buffer, and a burst of tool calls must not stack them up.
const MAX_CONCURRENT = 2;
let active = 0;
const waiting: (() => void)[] = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

/**
 * Render a committed snapshot to a PNG on white: the whole scene, or one
 * region of it, with the long edge at `DRAW_PNG_LONG_EDGE`. Throws when the
 * SVG has no usable size or does not parse.
 */
export async function renderDrawSvgPng(
  svg: string,
  opts: { region?: DrawRegion; longEdge?: number } = {},
): Promise<DrawPng> {
  const longEdge = opts.longEdge ?? DRAW_PNG_LONG_EDGE;
  const root = ROOT_SVG.exec(svg)?.[0];
  const box = root ? sceneBox(root) : null;
  if (!root || !box)
    throw new Error('the snapshot has no usable size (no viewBox or width/height)');
  let [x, y, w, h] = box;
  const sceneWidth = w;
  const sceneHeight = h;
  if (opts.region) {
    const r = opts.region;
    x += r.x * sceneWidth;
    y += r.y * sceneHeight;
    w = r.width * sceneWidth;
    h = r.height * sceneHeight;
  }
  let rootOut = setAttr(root, 'viewBox', `${x} ${y} ${w} ${h}`);
  rootOut = setAttr(rootOut, 'width', String(w));
  rootOut = setAttr(rootOut, 'height', String(h));
  let doc = blankExternalHrefs(svg.replace(root, rootOut));

  const taken = await takeEmbeddedFonts(doc);
  doc = taken.svg;
  const rename = new Map<string, string>();
  const families: string[] = [];
  for (const f of taken.fonts) {
    const own = sfntFamilyName(f.sfnt);
    if (own) families.push(own);
    if (own && f.cssFamily && own.toLowerCase() !== f.cssFamily.toLowerCase()) {
      rename.set(f.cssFamily.toLowerCase(), own);
    }
  }
  doc = renameFamilies(doc, rename);

  return withSlot(async () => {
    const dir = taken.fonts.length ? await mkdtemp(join(tmpdir(), 'mantle-draw-fonts-')) : null;
    try {
      const fontFiles: string[] = [];
      if (dir) {
        for (const [i, f] of taken.fonts.entries()) {
          const file = join(dir, `${i}.ttf`);
          await writeFile(file, f.sfnt);
          fontFiles.push(file);
        }
      }
      const { renderAsync } = await import('@resvg/resvg-js');
      // Unknown option keys make resvg-js drop the WHOLE options object
      // without a word (it is sent across as JSON), so keep to its typed set.
      const img = await renderAsync(doc, {
        background: '#ffffff',
        fitTo: w >= h ? { mode: 'width', value: longEdge } : { mode: 'height', value: longEdge },
        font: {
          loadSystemFonts: true,
          fontFiles,
          ...(families[0] ? { defaultFontFamily: families[0] } : {}),
        },
        logLevel: 'off',
      });
      return {
        png: img.asPng(),
        width: img.width,
        height: img.height,
        sceneWidth,
        sceneHeight,
      };
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });
}

// ─── cache ────────────────────────────────────────────────────────────────
// Keyed by the caller (drawing id + commit version + reader + region), and
// consulted only AFTER the caller's own access check, so a hit never skips
// one. Memory only; a restart starts cold.
const CACHE_MAX_ENTRIES = 24;
const CACHE_MAX_BYTES = 48_000_000;
const cache = new Map<string, DrawPng>();
let cacheBytes = 0;

export function cachedDrawPng(key: string): DrawPng | null {
  const hit = cache.get(key);
  if (!hit) return null;
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

export function cacheDrawPng(key: string, png: DrawPng): void {
  if (png.png.length > CACHE_MAX_BYTES / 4) return;
  const old = cache.get(key);
  if (old) {
    cache.delete(key);
    cacheBytes -= old.png.length;
  }
  cache.set(key, png);
  cacheBytes += png.png.length;
  while (cache.size > CACHE_MAX_ENTRIES || cacheBytes > CACHE_MAX_BYTES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cacheBytes -= cache.get(oldest)!.png.length;
    cache.delete(oldest);
  }
}
