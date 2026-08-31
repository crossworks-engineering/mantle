/**
 * Autodesk DWF (Design Web Format) → text digest.
 *
 * A `.dwf` is a **published plot set**, not a live drawing: a ZIP container
 * holding one `ePlot` section per sheet, each with a descriptor (XML property
 * soup), a W2D graphics stream, and a thumbnail PNG. The vector linework sits
 * in binary W2D opcodes this parser deliberately does not decode — that would
 * mean a full W2D reader for data the source DWG carries better. What a DWF
 * *does* give up readily, and what this parser extracts:
 *
 *   - the manifest's sheet list — titles carry drawing numbers + revisions
 *     ("90-10-01 Rev 2");
 *   - per-sheet descriptor properties — the SOURCE DWG FILENAME, author,
 *     creator, layout and paper size (so an answer can always say which DWG
 *     to fetch for real geometry);
 *   - layer names from each W2D stream's ASCII opcode preamble — on
 *     circuitization sets these are the circuit registry itself
 *     ("Circuit 90000-001-01");
 *   - annotation text labels from the W2D streams (pipe sizes, tags, line
 *     numbers) — the strings are plainly embedded even though their placement
 *     opcodes are binary.
 *
 * The digest is deliberately small and text-shaped: it flows through the
 * normal file-extract path (summary + embedding + chunks) and stays within a
 * few KB per sheet, so a 9-sheet plot set indexes like one document — never
 * like a hundred thousand entities. That is the contract with the retrieval
 * layer; keep the caps below when extending. Labels are kept by a CHARACTER
 * budget, not a top-N cut: the rare, distinctive tags (a valve number that
 * appears once) are exactly what a query names, so frequency orders the list
 * but never selects it.
 *
 * Container quirks, all observed on real AutoCAD output:
 *   - the ZIP is prefixed with an ASCII `(DWF V06.20)` magic. JSZip's own
 *     prepended-data correction handles both offset conventions writers use
 *     (absolute-from-file-start on AutoCAD output, archive-relative on
 *     repackaged containers), so the container is opened in ONE pass on the
 *     whole buffer — do not "fix" this by slicing at the first PK signature;
 *   - entry names use BACKSLASHES as separators;
 *   - descriptor XML is flat attribute soup (`<ePlot:Property name value/>`),
 *     matched with narrow regexes rather than a namespace-aware parse —
 *     attribute ORDER is not assumed, and values are entity-decoded at the
 *     boundary;
 *   - W2D opcode strings are usually ASCII, sometimes UTF-8; each extracted
 *     run is re-decoded as UTF-8 with a latin1 fallback so non-English layer
 *     names survive.
 *
 * Memory safety: every entry read is preflighted against the ZIP central
 * directory's DECLARED uncompressed size before inflating (same defence as
 * sheet-read.ts's `sheetXmlBytes`), so a deflate bomb degrades that sheet to
 * metadata-only instead of allocating gigabytes in-process.
 *
 * DWFx (`.dwfx`) is a different container (OPC/XPS) and stream format — it is
 * routed to an honest export-required skip in ./slug.ts, not here. Dispatch in
 * parse.ts is gated on {@link sniffDwf}, so a mislabelled `.dwf` (usually a
 * renamed DWFx) yields '' and takes the extractor's honest hollow-skip rather
 * than indexing its own filename.
 */
import JSZip from 'jszip';
import { describeImageBytes, type EmbeddedImage } from './embedded-images';
import type { ParsedSheet } from './sheet-to-grid';

/** True when the bytes carry the classic DWF magic (`(DWF Vnn.nn)`). */
export function sniffDwf(bytes: Buffer): boolean {
  return bytes.subarray(0, 5).toString('latin1') === '(DWF ';
}

export type DwfSheet = {
  /** Manifest title — the drawing number/revision as published. */
  title: string;
  /** Section name inside the container (`com.autodesk.dwf.ePlot_<guid>`). */
  section: string;
  /** "File Name" descriptor property — the source DWG behind the sheet. */
  sourceFile: string | null;
  author: string | null;
  creator: string | null;
  /** Layout name ("Model", "Layout1"). */
  layout: string | null;
  /** Human form, e.g. `17.0 × 11.0 in`. */
  paper: string | null;
  /** Layer names in stream order, deduped. */
  layers: string[];
  /** Unique annotation labels with occurrence counts, most frequent first. */
  labels: Array<{ text: string; count: number }>;
  /** Total label occurrences before dedupe (a density signal). */
  labelTotal: number;
  /** Container path of the sheet's thumbnail PNG, when present. */
  thumbnailPath: string | null;
};

export type DwfParsed = {
  /** `V06.20` from the container magic, or null when absent. */
  version: string | null;
  sheets: DwfSheet[];
};

/* ------------------------------------------------------------------- caps */
// A malformed or adversarial container must degrade to a shorter digest, not
// a memory spike. Real plot sets sit far below all of these. The two entry
// caps are enforced BEFORE inflation via the central directory's declared
// uncompressed size — that is what makes them real.
const MAX_SHEETS = 64;
const MAX_LAYERS_PER_SHEET = 500;
const MAX_UNIQUE_LABELS_PER_SHEET = 2000;
/** Ceiling on an inflated W2D stream — declared-size preflight, then scan. */
const MAX_W2D_SCAN_BYTES = 16 * 1024 * 1024;
/** Ceiling on an inflated XML entry (manifest / descriptor). */
const MAX_XML_BYTES = 4 * 1024 * 1024;
/** Ceiling on an inflated sheet thumbnail (real ones are ~5-10 KB). */
const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;
/** Row ceiling for the Labels tab of the auto-imported registry workbook. */
const MAX_LABEL_ROWS = 20_000;
const DIGEST_LAYERS_PER_SHEET = 80;
/** Per-sheet character budget for the label list — keeps ALL unique labels on
 *  real sheets (~a few hundred short strings); cuts only pathological ones. */
const DIGEST_LABEL_CHARS_PER_SHEET = 8000;
const DIGEST_REGISTRY_LAYERS = 400;
const DIGEST_REGISTRY_SHEETS_PER_LAYER = 12;

/** Normalise a container path: backslashes → slashes. */
function norm(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Decode the five XML entities descriptor values actually use. */
function unxml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Pull one `attr="value"` off an XML tag's attribute string, entity-decoded.
 *  `name` must be a literal without regex metacharacters. */
function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m?.[1] != null ? unxml(m[1]) : null;
}

/** All `<ePlot:Property name value/>` pairs of a descriptor, one scan,
 *  attribute order free (first occurrence of a name wins). */
function properties(xml: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of xml.matchAll(/<[^>]*Property\b[^>]*>/g)) {
    const name = attr(m[0], 'name');
    const value = attr(m[0], 'value');
    if (name !== null && value !== null && !map.has(name)) map.set(name, value);
  }
  return map;
}

/** The entry's declared uncompressed size from the central directory, without
 *  inflating anything. JSZip keeps it on the internal `_data` slot (the same
 *  access sheet-read.ts uses); unknown → -1, treated as "trust but it will be
 *  the writer's problem" only for tiny XML entries, never for W2D. */
function declaredSize(entry: JSZip.JSZipObject): number {
  const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data
    ?.uncompressedSize;
  return typeof size === 'number' && Number.isFinite(size) ? size : -1;
}

/** Inflate a text entry, refusing past `cap` on declared size ('' instead). */
async function entryText(entry: JSZip.JSZipObject | undefined, cap: number): Promise<string> {
  if (!entry) return '';
  const size = declaredSize(entry);
  if (size > cap) return '';
  return entry.async('string');
}

/** W2D opcode strings are usually ASCII, occasionally UTF-8. The scrape
 *  matches on a latin1 view (byte-faithful); each captured run is re-decoded
 *  as UTF-8, falling back to the latin1 form when it doesn't round-trip. */
function w2dDecode(latin1Run: string): string {
  const utf8 = Buffer.from(latin1Run, 'latin1').toString('utf8');
  return utf8.includes('�') ? latin1Run : utf8;
}

/** At least one letter or digit in ANY script — filters leader-line artifacts
 *  ('____') without dropping non-Latin annotations. */
const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Scrape a W2D stream for layer names and annotation label strings.
 *
 * The stream opens with ASCII extended opcodes — `(Layer 12 'Circuit …')` —
 * and the drawing body is binary, but every text label still appears as a
 * quoted run followed by the binary opcode tail (observed shape: `'2"'V…`).
 * Matching that quoted-run-plus-`V` shape recovers the labels without
 * decoding W2D. Placement/rotation stay unread — the digest wants the WORDS
 * on the sheet, not their coordinates.
 */
export function scrapeW2d(stream: Buffer): {
  layers: string[];
  labels: Array<{ text: string; count: number }>;
  labelTotal: number;
} {
  const body = stream.subarray(0, MAX_W2D_SCAN_BYTES).toString('latin1');

  const layers: string[] = [];
  const seenLayers = new Set<string>();
  for (const m of body.matchAll(/\(Layer \d+ '([^']{1,200})'/g)) {
    const name = w2dDecode((m[1] ?? '').trim());
    if (!name || seenLayers.has(name)) continue;
    seenLayers.add(name);
    layers.push(name);
    if (layers.length >= MAX_LAYERS_PER_SHEET) break;
  }

  const counts = new Map<string, number>();
  let labelTotal = 0;
  for (const m of body.matchAll(/'([^'\n]{1,120})'V/g)) {
    const text = w2dDecode((m[1] ?? '').trim());
    // Leader-line artifacts ('____') and lone punctuation carry no meaning.
    if (!HAS_WORD_CHAR.test(text)) continue;
    labelTotal += 1;
    if (counts.size < MAX_UNIQUE_LABELS_PER_SHEET || counts.has(text)) {
      counts.set(text, (counts.get(text) ?? 0) + 1);
    }
  }
  const labels = [...counts.entries()]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));

  return { layers, labels, labelTotal };
}

/** Per-section entry paths, resolved in one pass over the archive. */
type SectionEntries = { desc?: string; w2d?: string; png?: string };

type OpenedDwf = {
  version: string | null;
  entries: Map<string, JSZip.JSZipObject>;
  sectionEntries: Map<string, SectionEntries>;
  /** ePlot sections in manifest order: sheet identity for every consumer. */
  sections: Array<{ name: string; title: string }>;
};

/** Open the container, map every entry, and read the manifest's sheet list —
 *  the shared front half of the digest, thumbnail and grid producers. */
async function openDwf(bytes: Buffer): Promise<OpenedDwf> {
  const versionMatch = /^\(DWF (V[\d.]+)\)/.exec(bytes.subarray(0, 16).toString('latin1'));
  // One load on the whole buffer: JSZip corrects for the DWF magic prefix
  // itself, for both offset conventions (see the header comment). Rethrown
  // with a named message so the trace says WHAT was wrong, not just where.
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`dwf: no readable ZIP archive in container (${msg})`, { cause: err });
  }

  // One pass: normalised path → entry, plus per-section-directory roles.
  const entries = new Map<string, JSZip.JSZipObject>();
  const sectionEntries = new Map<string, SectionEntries>();
  zip.forEach((path, file) => {
    const p = norm(path);
    entries.set(p, file);
    const slash = p.indexOf('/');
    if (slash <= 0) return;
    const dir = p.slice(0, slash);
    const rec = sectionEntries.get(dir) ?? {};
    if (p.endsWith('descriptor.xml')) rec.desc ??= p;
    else if (p.endsWith('.w2d')) rec.w2d ??= p;
    else if (p.endsWith('.png')) rec.png ??= p;
    sectionEntries.set(dir, rec);
  });

  const manifest = await entryText(entries.get('manifest.xml'), MAX_XML_BYTES);

  // Manifest sections carry the published sheet titles in order.
  const sections: Array<{ name: string; title: string }> = [];
  for (const m of manifest.matchAll(/<[^>]*Section\b[^>]*>/g)) {
    const name = attr(m[0], 'name');
    const title = attr(m[0], 'title');
    if (!name || !title || !name.includes('ePlot_')) continue;
    sections.push({ name, title });
    if (sections.length >= MAX_SHEETS) break;
  }

  return { version: versionMatch?.[1] ?? null, entries, sectionEntries, sections };
}

/** Open the container and extract every ePlot sheet's metadata + scrape. */
export async function parseDwfStructured(bytes: Buffer): Promise<DwfParsed> {
  const { version, entries, sectionEntries, sections } = await openDwf(bytes);

  const sheets: DwfSheet[] = [];
  for (const { name, title } of sections) {
    const paths = sectionEntries.get(name) ?? {};
    const desc = await entryText(paths.desc ? entries.get(paths.desc) : undefined, MAX_XML_BYTES);
    const props = properties(desc);
    const paperTag = /<[^>]*Paper\b[^>]*>/.exec(desc)?.[0] ?? '';
    const paperUnits = attr(paperTag, 'units');
    const paperWRaw = attr(paperTag, 'width');
    const paperHRaw = attr(paperTag, 'height');
    const paperW = paperWRaw ? Number(paperWRaw) : NaN;
    const paperH = paperHRaw ? Number(paperHRaw) : NaN;

    // W2D scrape, declared-size preflighted: an oversized (or bomb) stream
    // degrades this sheet to metadata-only instead of inflating unbounded.
    let scraped: ReturnType<typeof scrapeW2d> = { layers: [], labels: [], labelTotal: 0 };
    const w2dEntry = paths.w2d ? entries.get(paths.w2d) : undefined;
    if (w2dEntry) {
      const size = declaredSize(w2dEntry);
      if (size >= 0 && size <= MAX_W2D_SCAN_BYTES) {
        scraped = scrapeW2d(await w2dEntry.async('nodebuffer'));
      }
    }

    sheets.push({
      title,
      section: name,
      sourceFile: props.get('File Name') ?? null,
      author: props.get('Author') ?? null,
      creator: props.get('Creator') ?? null,
      layout: props.get('Layout Name') ?? null,
      paper:
        paperUnits && Number.isFinite(paperW) && Number.isFinite(paperH)
          ? `${paperW.toFixed(1)} × ${paperH.toFixed(1)} ${paperUnits}`
          : null,
      thumbnailPath: paths.png ?? null,
      ...scraped,
    });
  }

  return { version, sheets };
}

/**
 * The per-sheet thumbnail PNGs, shaped for the shared embedded-image pipeline
 * (`extractEmbeddedImages` → gate → file nodes). Each published sheet carries
 * exactly one raster preview — the only picture the drawing has until real
 * geometry rendering exists — so every thumbnail is marked `essential`: the
 * decoration size floors don't apply (they are 262×170 on real AutoCAD
 * output, under the generic 200 px floor), while renderability and dedupe
 * still do. `location.sheet` carries the sheet title so the naming cascade
 * yields "… (21-62-09)"-style node titles.
 */
export async function extractDwfImages(bytes: Buffer): Promise<EmbeddedImage[]> {
  if (!sniffDwf(bytes)) return [];
  const { entries, sectionEntries, sections } = await openDwf(bytes);
  const images: EmbeddedImage[] = [];
  for (const { name, title } of sections) {
    const pngPath = sectionEntries.get(name)?.png;
    const entry = pngPath ? entries.get(pngPath) : undefined;
    if (!entry) continue;
    const size = declaredSize(entry);
    if (size < 0 || size > MAX_THUMBNAIL_BYTES) continue;
    const png = await entry.async('nodebuffer');
    images.push({
      bytes: png,
      ordinal: images.length + 1,
      location: { sheet: title },
      altText: `Sheet ${title}`,
      essential: true,
      ...describeImageBytes(png, 'png'),
    });
  }
  return images;
}

/**
 * The registry workbook: the same `ParsedSheet[]` shape spreadsheets and
 * MSPDI plans produce, so the extractor's auto-table pass turns a DWF into a
 * queryable Table with three tabs —
 *
 *   - **Sheets**: one row per published sheet (title, source DWG, layout,
 *     author, paper, layer/label counts);
 *   - **Layers**: the cross-sheet layer registry — on circuitization sets,
 *     the circuit list itself — with the sheets each layer appears on;
 *   - **Labels**: every unique annotation string with its total count and
 *     sheets, so "which sheet carries valve tag X" is one `table_sql` query.
 *
 * Returns [] when the container has no 2D sheets, which the auto-table pass
 * treats as "not tabular" and skips.
 */
export async function parseDwfToGrids(bytes: Buffer): Promise<ParsedSheet[]> {
  const { sheets } = await parseDwfStructured(bytes);
  if (sheets.length === 0) return [];

  const sheetRows = sheets.map((s) => [
    s.title,
    s.sourceFile,
    s.layout,
    s.author,
    s.paper,
    s.layers.length,
    s.labelTotal,
  ]);

  const layerMap = new Map<string, string[]>();
  const labelMap = new Map<string, { count: number; sheets: string[] }>();
  for (const s of sheets) {
    for (const layer of s.layers) {
      const on = layerMap.get(layer) ?? [];
      on.push(s.title);
      layerMap.set(layer, on);
    }
    for (const l of s.labels) {
      const rec = labelMap.get(l.text) ?? { count: 0, sheets: [] };
      rec.count += l.count;
      rec.sheets.push(s.title);
      labelMap.set(l.text, rec);
    }
  }

  const layerRows = [...layerMap.entries()].map(([layer, on]) => [
    layer,
    on.join(', '),
    on.length,
  ]);
  const labelRows = [...labelMap.entries()]
    .slice(0, MAX_LABEL_ROWS)
    .map(([text, rec]) => [text, rec.count, rec.sheets.join(', ')]);

  return [
    {
      name: 'Sheets',
      columns: [
        { name: 'Sheet', type: 'text' },
        { name: 'Source DWG', type: 'text' },
        { name: 'Layout', type: 'text' },
        { name: 'Author', type: 'text' },
        { name: 'Paper', type: 'text' },
        { name: 'Layer count', type: 'number' },
        { name: 'Label count', type: 'number' },
      ],
      rows: sheetRows,
    },
    {
      name: 'Layers',
      columns: [
        { name: 'Layer', type: 'text' },
        { name: 'Sheets', type: 'text' },
        { name: 'Sheet count', type: 'number' },
      ],
      rows: layerRows,
    },
    {
      name: 'Labels',
      columns: [
        { name: 'Label', type: 'text' },
        { name: 'Total count', type: 'number' },
        { name: 'Sheets', type: 'text' },
      ],
      rows: labelRows,
    },
  ];
}

/**
 * DWF → the plain-text digest the extract pipeline indexes.
 *
 * Shape: a set header, one block per sheet (identity, source DWG, layers,
 * labels under a character budget), then the cross-sheet layer registry — on
 * circuitization sets that registry is the list of circuits the whole file
 * exists to publish. Every section is capped; the caps are the retrieval
 * contract. Returns '' when the container holds no ePlot sheets at all (a 3D
 * eModel DWF, or a foreign ZIP renamed `.dwf`), which the extractor records
 * as its honest hollow skip.
 */
export async function parseDwf(bytes: Buffer): Promise<string> {
  const { version, sheets } = await parseDwfStructured(bytes);
  if (sheets.length === 0) return '';

  const out: string[] = [];
  out.push(
    `DWF drawing set${version ? ` (${version})` : ''} — ${sheets.length} sheet${sheets.length === 1 ? '' : 's'}. ` +
      'Published plot: sheet metadata, layers and annotation text below; vector geometry stays in the source DWGs named per sheet.',
  );

  for (const s of sheets) {
    out.push('');
    out.push(`## Sheet ${s.title}`);
    const facts: string[] = [];
    if (s.sourceFile) facts.push(`source drawing: ${s.sourceFile}`);
    if (s.layout) facts.push(`layout: ${s.layout}`);
    if (s.author) facts.push(`author: ${s.author}`);
    if (s.paper) facts.push(`paper: ${s.paper}`);
    if (facts.length) out.push(facts.join(' · '));
    if (s.layers.length) {
      out.push(
        `Layers (${s.layers.length}): ${s.layers.slice(0, DIGEST_LAYERS_PER_SHEET).join(', ')}` +
          (s.layers.length > DIGEST_LAYERS_PER_SHEET ? ', …' : ''),
      );
    }
    if (s.labels.length) {
      // Character budget, not top-N: the once-only labels are the searchable
      // tags. Frequency orders the list for readability; it never selects.
      const parts: string[] = [];
      let chars = 0;
      for (const l of s.labels) {
        const piece = l.count > 1 ? `${l.text} (×${l.count})` : l.text;
        if (chars + piece.length > DIGEST_LABEL_CHARS_PER_SHEET) break;
        parts.push(piece);
        chars += piece.length + 2;
      }
      const cut = s.labels.length - parts.length;
      out.push(
        `Annotation text (${s.labelTotal} labels, ${s.labels.length} unique): ${parts.join(', ')}` +
          (cut > 0 ? `, … and ${cut} more` : ''),
      );
    }
  }

  // Cross-sheet registry, built in its own pass and capped on both axes.
  const registry = new Map<string, string[]>();
  for (const s of sheets) {
    for (const layer of s.layers) {
      const on = registry.get(layer) ?? [];
      on.push(s.title);
      registry.set(layer, on);
    }
  }
  if (registry.size) {
    out.push('');
    out.push(`## Layer registry across sheets (${registry.size})`);
    let lines = 0;
    for (const [layer, on] of registry) {
      if (lines >= DIGEST_REGISTRY_LAYERS) {
        out.push(`… and ${registry.size - lines} more layers.`);
        break;
      }
      const shown = on.slice(0, DIGEST_REGISTRY_SHEETS_PER_LAYER);
      out.push(
        `${layer} — on sheet${on.length === 1 ? '' : 's'} ${shown.join(', ')}` +
          (on.length > shown.length ? ` and ${on.length - shown.length} more` : ''),
      );
      lines += 1;
    }
  }

  return out.join('\n');
}
