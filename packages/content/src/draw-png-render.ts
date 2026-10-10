/**
 * The renderer half of draw-png.ts, run in a worker thread so a slow or
 * hostile snapshot costs a terminated thread, never the server's event loop.
 *
 * resvg runs as WebAssembly here: it has no file system and no network, so
 * whatever a snapshot links to, the renderer cannot read it. Fonts arrive as
 * bytes (unpacked from the snapshot's woff2 sources, with bounds checked
 * BEFORE unpacking), plus one bundled fallback font for glyphs the snapshot
 * did not carry.
 *
 * Loaded by URL as a worker (Node strips the types), and imported normally
 * by draw-png.ts and the tests for the pure helpers, so it uses erasable
 * TypeScript only and imports no sibling file.
 */
// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- loads the local ambient type for the untyped wawoff2 module
/// <reference path="./wawoff2.d.ts" />
import { isMainThread, parentPort, workerData } from 'node:worker_threads';

export type RenderJob = {
  svg: string;
  fonts: { family: string; base64: string }[];
  fallbackFont: Uint8Array;
  longEdge: number;
  landscape: boolean;
};
export type RenderResult = { png: Uint8Array; width: number; height: number };

/** One unpacked font, and all of them together. A woff2 states its unpacked
 *  size in its header, so a font that would unpack past these is refused
 *  before any work. */
export const FONT_MAX_UNPACKED_BYTES = 8_000_000;
export const FONTS_MAX_UNPACKED_TOTAL = 24_000_000;

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
        for (let j = 0; j + 1 < bytes.length; j += 2) {
          s += String.fromCharCode((bytes[j]! << 8) | bytes[j + 1]!);
        }
      } else {
        for (const b of bytes) s += String.fromCharCode(b);
      }
      if (s.trim()) found.set(nameId, s.trim());
    }
    return found.get(16) ?? found.get(1) ?? null;
  } catch {
    return null;
  }
}

/** Unpack the snapshot's fonts to sfnt bytes, inside the size bounds. A font
 *  that is too big or does not unpack is skipped (its glyphs fall back). */
export async function unpackFonts(
  sources: { family: string; base64: string }[],
): Promise<{ family: string; sfnt: Uint8Array }[]> {
  const { decompress } = await import('wawoff2');
  const out: { family: string; sfnt: Uint8Array }[] = [];
  let total = 0;
  for (const src of sources) {
    const bytes = Buffer.from(src.base64, 'base64');
    if (bytes.length < 20) continue;
    const magic = bytes.subarray(0, 4).toString('latin1');
    let size: number;
    if (magic === 'wOF2') size = bytes.readUInt32BE(16);
    else if (magic === 'OTTO' || magic === 'true' || bytes.readUInt32BE(0) === 0x00010000) {
      size = bytes.length;
    } else continue;
    if (size > FONT_MAX_UNPACKED_BYTES || total + size > FONTS_MAX_UNPACKED_TOTAL) continue;
    try {
      const sfnt = magic === 'wOF2' ? await decompress(bytes) : new Uint8Array(bytes);
      if (sfnt.length > FONT_MAX_UNPACKED_BYTES) continue;
      total += sfnt.length;
      out.push({ family: src.family, sfnt });
    } catch {
      // A font that does not unpack costs its glyphs, never the picture.
    }
  }
  return out;
}

/** Rename font families in the (sanitized) SVG's text to the names the font
 *  files carry, where the `@font-face` rule called a font something else. */
export function renameFamilies(svg: string, rename: Map<string, string>): string {
  if (rename.size === 0) return svg;
  const mapList = (list: string) =>
    list
      .split(',')
      .map((f) => {
        const bare = f
          .trim()
          .replace(/^["']|["']$/g, '')
          .trim();
        return rename.get(bare.toLowerCase()) ?? f.trim();
      })
      .join(', ');
  return svg
    .replace(
      /(\sfont-family=")([^"]*)"/g,
      (_w, pre: string, list: string) => `${pre}${mapList(list)}"`,
    )
    .replace(
      /(font-family:)([^;"]+)/g,
      (_w, pre: string, list: string) => `${pre}${mapList(list)}`,
    );
}

let wasmReady: Promise<void> | null = null;

/** Render in THIS thread (the worker calls it; tests may too). */
export async function renderJob(job: RenderJob, wasm: WebAssembly.Module): Promise<RenderResult> {
  const { initWasm, Resvg } = await import('@resvg/resvg-wasm');
  // Once per thread; a second init (a test that also decodes with resvg in
  // the same thread) is not an error worth failing a render over.
  wasmReady ??= initWasm(wasm).catch((err: unknown) => {
    if (!/already initialized/i.test(String(err))) throw err;
  });
  await wasmReady;
  const fonts = await unpackFonts(job.fonts);
  const rename = new Map<string, string>();
  const families: string[] = [];
  for (const f of fonts) {
    const own = sfntFamilyName(f.sfnt);
    if (own) families.push(own);
    if (own && f.family && own.toLowerCase() !== f.family.toLowerCase()) {
      rename.set(f.family.toLowerCase(), own);
    }
  }
  const fallbackFamily = sfntFamilyName(job.fallbackFont) ?? undefined;
  const defaultFamily = families[0] ?? fallbackFamily;
  const svg = renameFamilies(job.svg, rename);
  const resvg = new Resvg(svg, {
    background: '#ffffff',
    fitTo: job.landscape
      ? { mode: 'width', value: job.longEdge }
      : { mode: 'height', value: job.longEdge },
    font: {
      fontBuffers: [...fonts.map((f) => f.sfnt), job.fallbackFont],
      ...(defaultFamily ? { defaultFontFamily: defaultFamily } : {}),
      ...(fallbackFamily ? { sansSerifFamily: fallbackFamily } : {}),
    },
  });
  try {
    const img = resvg.render();
    try {
      return { png: img.asPng(), width: img.width, height: img.height };
    } finally {
      img.free();
    }
  } finally {
    resvg.free();
  }
}

// Worker entry: one job per thread, then the thread ends.
if (
  !isMainThread &&
  parentPort &&
  (workerData as { kind?: string } | null)?.kind === 'mantle-draw-png'
) {
  const { job, wasm } = workerData as { kind: string; job: RenderJob; wasm: WebAssembly.Module };
  const port = parentPort;
  renderJob(job, wasm).then(
    (r) => port.postMessage({ ok: true, result: r }, [r.png.buffer as ArrayBuffer]),
    (err: unknown) =>
      port.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) }),
  );
}
