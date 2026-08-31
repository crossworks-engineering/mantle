/**
 * AutoCAD DWG → text digest, registry workbook, and model-space render.
 *
 * A `.dwg` is the LIVE drawing (unlike a `.dwf`, which is a published plot
 * set), and it is the one routed format this process cannot parse locally:
 * everything comes from ONE media-sidecar exchange (`mediaDwgRender`), whose
 * worker converts DWG→DXF (dwg2dxf primary, ezdwg fallback — the 2026-08-31
 * bake-off found real files each converter fails and the other saves) and
 * extracts with ezdxf. The three extractor passes (text digest, auto-table
 * workbook, image node) all consume the SAME memoised sidecar reply, so a
 * DWG costs one upload however many passes run.
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
 * only '' return is a sniff miss (not actually DWG bytes), which takes the
 * extractor's hollow-skip carve-out like a renamed DWFx does on the dwf route.
 */
import { describeImageBytes, type EmbeddedImage } from './embedded-images';
import { mediaDwgRender, mediaSidecarEnabled, type DwgRender } from './media-sidecar';
import type { ParsedSheet } from './sheet-to-grid';

/** True when the bytes open with a DWG version magic (`AC1012`…`AC1032`). */
export function sniffDwg(bytes: Buffer): boolean {
  return /^AC1\d{3}$/.test(bytes.subarray(0, 6).toString('latin1'));
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

/** Env dial for render sharpness, mirroring DWF_RENDER_DPI (docs there). */
export function dwgRenderDpi(): number {
  const raw = Number(process.env.DWG_RENDER_DPI);
  if (!Number.isFinite(raw)) return 300;
  return Math.max(50, Math.min(600, Math.round(raw)));
}

/**
 * One sidecar exchange per Buffer per process — extractor passes hand every
 * pass the same Buffer (see loadFileBytes), which is what makes this memo
 * work. The PROMISE is memoised so concurrent passes share the in-flight
 * upload; a failed exchange is evicted so a retry actually retries.
 */
const renderMemo = new WeakMap<Buffer, Promise<Awaited<ReturnType<typeof mediaDwgRender>>>>();

function fetchDwgRender(bytes: Buffer) {
  let entry = renderMemo.get(bytes);
  if (!entry) {
    entry = mediaDwgRender(bytes, { dpi: dwgRenderDpi() }).then((res) => {
      if (!res.ok) renderMemo.delete(bytes);
      return res;
    });
    renderMemo.set(bytes, entry);
  }
  return entry;
}

function requireSidecar(): void {
  if (!mediaSidecarEnabled()) {
    throw new Error(
      'DWG extraction needs the media sidecar CAD tier (compose profile `media` + MEDIA_SIDECAR_TOKEN, image v0.232.99+); enable it and re-queue this file',
    );
  }
}

async function renderOrThrow(bytes: Buffer): Promise<DwgRender> {
  requireSidecar();
  const res = await fetchDwgRender(bytes);
  if (!res.ok) throw new Error(`DWG extraction failed (${res.code}): ${res.message}`);
  return res.value;
}

/* ----------------------------------------------------------------- digest */

/**
 * The indexable text digest. Returns '' only on a sniff miss (bytes are not
 * DWG — hollow-skip); throws when the sidecar is missing or the exchange
 * fails, so the node shows an honest extract error instead of junk.
 */
export async function parseDwg(bytes: Buffer): Promise<string> {
  if (!sniffDwg(bytes)) return '';
  const r = await renderOrThrow(bytes);
  const out: string[] = [];
  const versionName = (r.version && VERSION_NAMES[r.version]) || null;
  out.push(
    `AutoCAD DWG drawing${r.version ? ` (${r.version}${versionName ? ` / ${versionName}` : ''})` : ''} — ` +
      `${r.entities} model-space entities, ${r.layers.length} layers` +
      `${r.capped ? ' (registry capped)' : ''}. Converted via ${r.converter}.`,
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

/* ---------------------------------------------------------------- workbook */

/**
 * Registry workbook tabs for the auto-table pass: Layers, Texts (with model
 * coordinates — the geometry phase's feed), and entity-type Counts.
 */
export async function parseDwgToGrids(bytes: Buffer): Promise<ParsedSheet[]> {
  if (!sniffDwg(bytes)) return [];
  const r = await renderOrThrow(bytes);
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
  return sheets;
}

/* ------------------------------------------------------------------ images */

/**
 * The model-space render as a single essential image node. Unlike DWF there
 * is no thumbnail fallback tier inside the file: no sidecar (or a failed
 * render) yields [] and the file simply has no image child — the honest
 * outcome, and the extract-images trace records the reason upstream.
 */
export async function extractDwgImages(bytes: Buffer): Promise<EmbeddedImage[]> {
  if (!sniffDwg(bytes)) return [];
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
