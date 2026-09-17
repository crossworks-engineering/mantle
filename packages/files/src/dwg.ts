/**
 * AutoCAD DWG/DXF → text digest, registry workbook, and model-space render.
 *
 * A `.dwg` is the LIVE drawing (unlike a `.dwf`, which is a published plot
 * set); a `.dxf` is the same drawing in AutoCAD's interchange encoding
 * (ASCII or binary). Both are routed formats this process cannot parse
 * locally: everything comes from ONE media-sidecar exchange
 * (`mediaDwgRender`), whose worker sniffs the bytes — DWG magic takes the
 * converter chain (dwg2dxf primary, ezdwg fallback — the 2026-08-31 bake-off
 * found real files each converter fails and the other saves), a DXF is read
 * natively by ezdxf (converter "none") — and extracts with ezdxf either way.
 * The three extractor passes (text digest, auto-table workbook, image node)
 * all consume the SAME memoised sidecar reply, so a drawing costs one upload
 * however many passes run. The `.dxf` public surface (parseDxf & co) lives
 * in ./dxf.ts as thin re-exports of the wrappers defined here; the code path
 * is this one file.
 *
 * Digest philosophy mirrors ./dwf.ts: small and text-shaped, indexes like one
 * document. Layers ordered by entity count; text labels deduped and kept by a
 * CHARACTER budget (frequency orders, never selects — the once-only valve tag
 * is exactly what a query names). Bake-off reality baked in: these drawings
 * carry ZERO DIMENSION entities — the labels ARE the annotation layer, which
 * is why the workbook keeps per-text coordinates for the geometry phase.
 *
 * Failure honesty: no sidecar (or a pre-DWG image) throws a typed Error so
 * the extract shows a real error and a re-queue after enabling the sidecar
 * heals the node — silently indexing a filename would poison retrieval. The
 * only '' return is a sniff miss (not actually DWG/DXF bytes), which takes
 * the extractor's hollow-skip carve-out like a renamed DWFx does on the dwf
 * route.
 */
import { createHash } from 'node:crypto';
import { describeImageBytes, type EmbeddedImage } from './embedded-images';
import { mediaDwgRender, mediaSidecarEnabled, type DwgRender } from './media-sidecar';
import type { ParsedSheet } from './sheet-to-grid';
import { env } from '@mantle/config';

/** True when the bytes open with a DWG version magic (`AC1012`…`AC1032`). */
export function sniffDwg(bytes: Buffer): boolean {
  return /^AC1\d{3}$/.test(bytes.subarray(0, 6).toString('latin1'));
}

/** The binary-DXF sentinel, byte-exact per the DXF reference. */
const DXF_BINARY_SENTINEL = 'AutoCAD Binary DXF\r\n\x1a\x00';

/**
 * True when the bytes look like a DXF. Binary DXF is the fixed 22-byte
 * sentinel. ASCII DXF is group-code/value line pairs from the top: the first
 * non-comment pair must be `0` / `SECTION` (group codes may be space-padded;
 * `999` pairs are comments and legitimately lead the file; a UTF-8 BOM is
 * tolerated). A DWG (binary, starts `AC1…`) and arbitrary text both fail the
 * pair check, which is the point — the '' hollow-skip path keys off this.
 */
export function sniffDxf(bytes: Buffer): boolean {
  if (bytes.subarray(0, 22).toString('latin1') === DXF_BINARY_SENTINEL) return true;
  const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const lines = bytes
    .subarray(start, start + 8192)
    .toString('latin1')
    .split(/\r?\n/);
  for (let i = 0; i + 1 < lines.length; i += 2) {
    if (lines[i]!.trim() === '999') continue; // leading comment pair
    return lines[i]!.trim() === '0' && lines[i + 1]!.trim().toUpperCase() === 'SECTION';
  }
  return false;
}

/** The two formats this module serves; picks the sniff and the wording. */
type CadFormat = 'DWG' | 'DXF';

function sniffFor(format: CadFormat, bytes: Buffer): boolean {
  return format === 'DWG' ? sniffDwg(bytes) : sniffDxf(bytes);
}

/** Human name for the release behind a DXF/DWG version code, when known. */
const VERSION_NAMES: Record<string, string> = {
  AC1012: 'R13',
  AC1014: 'R14',
  AC1015: 'AutoCAD 2000',
  AC1018: 'AutoCAD 2004',
  AC1021: 'AutoCAD 2007',
  AC1024: 'AutoCAD 2010',
  AC1027: 'AutoCAD 2013',
  AC1032: 'AutoCAD 2018',
};

/* ------------------------------------------------------------------- caps */
const DIGEST_LAYERS = 400;
/** Character budget for the label list — same rationale as the DWF digest. */
const DIGEST_LABEL_CHARS = 12_000;
/** Row ceiling for the Texts tab of the auto-imported registry workbook. */
const MAX_TEXT_ROWS = 20_000;

/** Env dial for render sharpness, mirroring DWF_RENDER_DPI (docs there).
 *  One dial for DWG and DXF — same sidecar route, same rasteriser.
 *
 *  `raw <= 0` is UNSET, not "smallest allowed". The compose env anchor passes
 *  `DWG_RENDER_DPI: ${DWG_RENDER_DPI:-}`, so an operator who never sets the
 *  dial hands this function the EMPTY STRING — and `Number('')` is 0, which is
 *  finite. Without the `<= 0` arm (the guard ./dwf.ts has always had) that 0
 *  clamped up to the 50 floor instead of falling back to 300, and every DWG on
 *  every default box rendered at 50 dpi: an 800×500 smudge of a P&ID, small
 *  enough (~1 KB) that the embedded-image gate then dropped it as
 *  `too_few_bytes` and the drawing got no picture at all. Found on NATREF
 *  2026-09-02 — a 563 KB P&ID rendered 1003 bytes at 50 dpi, 15 KB at 300. */
export function dwgRenderDpi(): number {
  const raw = Number(env('DWG_RENDER_DPI'));
  if (!Number.isFinite(raw) || raw <= 0) return 300;
  return Math.max(50, Math.min(600, Math.round(raw)));
}

/**
 * One sidecar exchange per drawing per process. Keyed by CONTENT HASH, not
 * Buffer identity: the extractor's byte cache can evict and re-read a file
 * between passes under load, and a fresh Buffer of the same bytes must reuse
 * the exchange rather than pay a second upload. Tiny LRU (a node's passes run
 * back-to-back, so 2 in-flight drawings is the realistic ceiling). The
 * PROMISE is memoised so concurrent passes share the in-flight upload; a
 * failed exchange is evicted so a retry actually retries — but its failure
 * message is kept (per hash) so a later pass can explain the missing image.
 */
const RENDER_MEMO_MAX = 2;
const renderMemo = new Map<string, Promise<Awaited<ReturnType<typeof mediaDwgRender>>>>();
const failureMemo = new Map<string, string>();

function dwgHash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fetchDwgRender(bytes: Buffer) {
  const key = dwgHash(bytes);
  let entry = renderMemo.get(key);
  if (!entry) {
    entry = mediaDwgRender(bytes, { dpi: dwgRenderDpi() }).then((res) => {
      if (!res.ok) {
        renderMemo.delete(key);
        failureMemo.set(key, `${res.code}: ${res.message}`);
        if (failureMemo.size > RENDER_MEMO_MAX) {
          const oldest = failureMemo.keys().next().value;
          if (oldest !== undefined) failureMemo.delete(oldest);
        }
      } else {
        failureMemo.delete(key);
      }
      return res;
    });
    renderMemo.set(key, entry);
    if (renderMemo.size > RENDER_MEMO_MAX) {
      const oldest = renderMemo.keys().next().value;
      if (oldest !== undefined) renderMemo.delete(oldest);
    }
  }
  return entry;
}

function requireSidecar(format: CadFormat): void {
  if (!mediaSidecarEnabled()) {
    throw new Error(
      `${format} extraction needs the media sidecar CAD tier (compose profile \`media\` + MEDIA_SIDECAR_TOKEN, image v0.232.99+); enable it and re-queue this file`,
    );
  }
}

async function renderOrThrow(bytes: Buffer, format: CadFormat): Promise<DwgRender> {
  requireSidecar(format);
  const res = await fetchDwgRender(bytes);
  if (!res.ok) throw new Error(`${format} extraction failed (${res.code}): ${res.message}`);
  return res.value;
}

/* ----------------------------------------------------------------- digest */

async function parseCad(bytes: Buffer, format: CadFormat): Promise<string> {
  if (!sniffFor(format, bytes)) return '';
  const r = await renderOrThrow(bytes, format);
  const out: string[] = [];
  const versionName = (r.version && VERSION_NAMES[r.version]) || null;
  out.push(
    `AutoCAD ${format} drawing${r.version ? ` (${r.version}${versionName ? ` / ${versionName}` : ''})` : ''} — ` +
      `${r.entities} model-space entities, ${r.layers.length} layers` +
      `${r.capped ? ' (registry capped)' : ''}. ` +
      (r.converter === 'none' ? 'Parsed natively as DXF.' : `Converted via ${r.converter}.`),
  );

  const typeLine = Object.entries(r.counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
  if (typeLine) out.push(`Entities: ${typeLine}`);

  if (r.layers.length) {
    out.push('', 'Layers (by entity count):');
    for (const layer of r.layers.slice(0, DIGEST_LAYERS)) {
      out.push(`  - ${layer.name || '(unnamed)'} (${layer.count})`);
    }
    if (r.layers.length > DIGEST_LAYERS) {
      out.push(`  … ${r.layers.length - DIGEST_LAYERS} more layers`);
    }
  }

  // Dedupe labels with counts; frequency orders the list, the character
  // budget cuts it — never a top-N (the singleton tag is the query target).
  const counts = new Map<string, number>();
  for (const t of r.texts) counts.set(t.text, (counts.get(t.text) ?? 0) + 1);
  if (counts.size) {
    const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    out.push('', `Annotation text (${r.texts.length} entities, ${counts.size} unique):`);
    let spent = 0;
    let shown = 0;
    for (const [text, n] of ordered) {
      const line = n > 1 ? `  - ${text} (×${n})` : `  - ${text}`;
      if (spent + line.length > DIGEST_LABEL_CHARS) break;
      out.push(line);
      spent += line.length;
      shown++;
    }
    if (shown < ordered.length) out.push(`  … ${ordered.length - shown} more unique labels`);
  }
  return out.join('\n');
}

/**
 * The indexable text digest. Returns '' only on a sniff miss (bytes are not
 * DWG — hollow-skip); throws when the sidecar is missing or the exchange
 * fails, so the node shows an honest extract error instead of junk.
 */
export async function parseDwg(bytes: Buffer): Promise<string> {
  return parseCad(bytes, 'DWG');
}

/** DXF twin of {@link parseDwg} — same contract, DXF sniff. */
export async function parseDxf(bytes: Buffer): Promise<string> {
  return parseCad(bytes, 'DXF');
}

/* ---------------------------------------------------------------- workbook */

export type DwgGrids = {
  sheets: ParsedSheet[];
  /** True when the registry is INCOMPLETE — the sidecar hit its text/layer
   *  caps or the Texts tab was cut at MAX_TEXT_ROWS. The auto-table
   *  description must not claim "every annotation string" then. */
  capped: boolean;
};

async function parseCadToGrids(bytes: Buffer, format: CadFormat): Promise<DwgGrids> {
  if (!sniffFor(format, bytes)) return { sheets: [], capped: false };
  const r = await renderOrThrow(bytes, format);
  const sheets: ParsedSheet[] = [];
  if (r.layers.length) {
    sheets.push({
      name: 'Layers',
      columns: [
        { name: 'Layer', type: 'text' },
        { name: 'Entities', type: 'number' },
      ],
      rows: r.layers.map((l) => [l.name, l.count]),
    });
  }
  if (r.texts.length) {
    sheets.push({
      name: 'Texts',
      columns: [
        { name: 'Text', type: 'text' },
        { name: 'Layer', type: 'text' },
        { name: 'X', type: 'number' },
        { name: 'Y', type: 'number' },
      ],
      rows: r.texts.slice(0, MAX_TEXT_ROWS).map((t) => [t.text, t.layer, t.x, t.y]),
    });
  }
  const countRows = Object.entries(r.counts).sort((a, b) => b[1] - a[1]);
  if (countRows.length) {
    sheets.push({
      name: 'Counts',
      columns: [
        { name: 'Entity type', type: 'text' },
        { name: 'Count', type: 'number' },
      ],
      rows: countRows,
    });
  }
  return { sheets, capped: r.capped || r.texts.length > MAX_TEXT_ROWS };
}

/**
 * Registry workbook tabs for the auto-table pass: Layers, Texts (with model
 * coordinates — the geometry phase's feed), and entity-type Counts.
 */
export async function parseDwgToGrids(bytes: Buffer): Promise<DwgGrids> {
  return parseCadToGrids(bytes, 'DWG');
}

/** DXF twin of {@link parseDwgToGrids} — same tabs, DXF sniff. */
export async function parseDxfToGrids(bytes: Buffer): Promise<DwgGrids> {
  return parseCadToGrids(bytes, 'DXF');
}

/* ------------------------------------------------------------------ images */

async function explainCadImageMiss(bytes: Buffer, format: CadFormat): Promise<string> {
  if (!sniffFor(format, bytes)) return `not ${format} bytes (sniff miss)`;
  if (!mediaSidecarEnabled()) {
    return 'media sidecar not enabled — no render tier on this box';
  }
  const key = dwgHash(bytes);
  const entry = renderMemo.get(key);
  if (entry) {
    // Settled by the time this runs (the image pass awaited the same promise).
    const res = await entry;
    if (res.ok) {
      if (res.value.renderError) return `sidecar render failed: ${res.value.renderError}`;
      if (!res.value.png) return 'the sidecar shipped the registry but no render and no reason';
      return 'a render exists for these bytes (not a miss)';
    }
  }
  const failure = failureMemo.get(key);
  if (failure) return `sidecar exchange failed (${failure})`;
  return 'no sidecar exchange was recorded for these bytes';
}

/**
 * Why {@link extractDwgImages} came back empty for these bytes, answered from
 * the memos alone — NEVER a fresh sidecar exchange (this runs after the image
 * pass on the same bytes, so retrying here would double a failed upload).
 * Feeds the extractor's zero-candidate `extract_images` trace step.
 */
export async function explainDwgImageMiss(bytes: Buffer): Promise<string> {
  return explainCadImageMiss(bytes, 'DWG');
}

/** DXF twin of {@link explainDwgImageMiss}. */
export async function explainDxfImageMiss(bytes: Buffer): Promise<string> {
  return explainCadImageMiss(bytes, 'DXF');
}

async function extractCadImages(bytes: Buffer, format: CadFormat): Promise<EmbeddedImage[]> {
  if (!sniffFor(format, bytes)) return [];
  if (!mediaSidecarEnabled()) return [];
  const res = await fetchDwgRender(bytes);
  if (!res.ok || !res.value.png) return [];
  return [
    {
      // sha256 + sniffed ext + dimensions, same helper as every other pass.
      ...describeImageBytes(res.value.png, 'png'),
      bytes: res.value.png,
      ordinal: 1,
      altText: 'Model space',
      // Bypasses the size floors like DWF sheet renders do — a drawing's one
      // render is content by construction, never decoration.
      essential: true,
      provenance: 'sidecar_render',
    },
  ];
}

/**
 * The model-space render as a single essential image node. Unlike DWF there
 * is no thumbnail fallback tier inside the file: no sidecar (or a failed
 * render) yields [] and the file simply has no image child — the honest
 * outcome, and the extract-images trace records the reason upstream.
 */
export async function extractDwgImages(bytes: Buffer): Promise<EmbeddedImage[]> {
  return extractCadImages(bytes, 'DWG');
}

/** DXF twin of {@link extractDwgImages}. */
export async function extractDxfImages(bytes: Buffer): Promise<EmbeddedImage[]> {
  return extractCadImages(bytes, 'DXF');
}
