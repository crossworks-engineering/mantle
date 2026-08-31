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
 *     ("23-62-06 Rev 13");
 *   - per-sheet descriptor properties — the SOURCE DWG FILENAME, author,
 *     creator, layout and paper size (so an answer can always say which DWG
 *     to fetch for real geometry);
 *   - layer names from each W2D stream's ASCII opcode preamble — on
 *     circuitization sets these are the circuit registry itself
 *     ("Circuit 21000-002-01");
 *   - annotation text labels from the W2D streams (pipe sizes, tags, line
 *     numbers) — the strings are plainly embedded even though their placement
 *     opcodes are binary.
 *
 * The digest is deliberately small and text-shaped: it flows through the
 * normal file-extract path (summary + embedding + chunks) and stays within a
 * few KB per sheet, so a 9-sheet plot set indexes like one document — never
 * like a hundred thousand entities. That is the contract with the retrieval
 * layer; keep the caps below when extending.
 *
 * Container quirks, all observed on real AutoCAD output:
 *   - the ZIP is prefixed with an ASCII `(DWF V06.20)` header, so the archive
 *     is opened from the first local-file signature, not byte 0;
 *   - entry names use BACKSLASHES as separators;
 *   - descriptor XML is flat attribute soup (`<ePlot:Property name value/>`),
 *     matched with narrow regexes rather than a namespace-aware parse.
 *
 * DWFx (`.dwfx`) is a different container (OPC/XPS) and stream format — it is
 * routed to an honest export-required skip in ./slug.ts, not here.
 */
import JSZip from 'jszip';

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
// a memory spike. Real plot sets sit far below all of these.
const MAX_SHEETS = 64;
const MAX_LAYERS_PER_SHEET = 500;
const MAX_UNIQUE_LABELS_PER_SHEET = 2000;
const MAX_W2D_SCAN_BYTES = 16 * 1024 * 1024;
const DIGEST_LABELS_PER_SHEET = 60;
const DIGEST_LAYERS_PER_SHEET = 80;

/** Normalise a container path: backslashes → slashes. */
function norm(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Pull one `attr="value"` off an XML tag's attribute string. */
function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m?.[1] ?? null;
}

/** `<ePlot:Property name="X" value="Y"/>` lookup (first match wins). */
function property(xml: string, name: string): string | null {
  const m = new RegExp(`<[^>]*Property[^>]*name="${name}"[^>]*value="([^"]*)"`).exec(xml);
  return m?.[1] ?? null;
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
    const name = (m[1] ?? '').trim();
    if (!name || seenLayers.has(name)) continue;
    seenLayers.add(name);
    layers.push(name);
    if (layers.length >= MAX_LAYERS_PER_SHEET) break;
  }

  const counts = new Map<string, number>();
  let labelTotal = 0;
  for (const m of body.matchAll(/'([^'\n]{1,120})'V/g)) {
    const text = (m[1] ?? '').trim();
    // Leader-line artifacts ('____') and lone punctuation carry no meaning.
    if (!/[a-zA-Z0-9]/.test(text)) continue;
    labelTotal += 1;
    if (counts.size < MAX_UNIQUE_LABELS_PER_SHEET || counts.has(text)) {
      counts.set(text, (counts.get(text) ?? 0) + 1);
    }
  }
  const labels = [...counts.entries()]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));

  return { layers, labels, labelTotal };
}

/** Open the container and extract every ePlot sheet's metadata + scrape. */
export async function parseDwfStructured(bytes: Buffer): Promise<DwfParsed> {
  const versionMatch = /^\(DWF (V[\d.]+)\)/.exec(bytes.subarray(0, 16).toString('latin1'));
  // The ZIP sits after the DWF magic, and writers disagree about what its
  // internal offsets are relative to. AutoCAD's own output uses ABSOLUTE file
  // offsets (they include the magic), so the whole buffer parses as-is; a
  // container assembled by prefixing a standalone archive uses archive-relative
  // offsets and only parses from the first local-file signature. Try absolute
  // first (the real-world case), fall back to the slice.
  const zipStart = bytes.indexOf(Buffer.from('PK\x03\x04', 'latin1'));
  if (zipStart < 0) throw new Error('dwf: no ZIP archive found in container');
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    zip = await JSZip.loadAsync(bytes.subarray(zipStart));
  }

  // Entry lookup by normalised path (container uses backslashes).
  const entries = new Map<string, JSZip.JSZipObject>();
  zip.forEach((path, file) => entries.set(norm(path), file));

  const manifestEntry = entries.get('manifest.xml');
  const manifest = manifestEntry ? await manifestEntry.async('string') : '';

  // Manifest sections carry the published sheet titles in order.
  const sections: Array<{ name: string; title: string }> = [];
  for (const m of manifest.matchAll(/<[^>]*Section\b[^>]*>/g)) {
    const name = attr(m[0], 'name');
    const title = attr(m[0], 'title');
    if (!name || !title || !name.includes('ePlot_')) continue;
    sections.push({ name, title: unxml(title) });
    if (sections.length >= MAX_SHEETS) break;
  }

  const sheets: DwfSheet[] = [];
  for (const { name, title } of sections) {
    const inSection = (suffix: string): string | null => {
      for (const path of entries.keys()) {
        if (path.startsWith(`${name}/`) && path.endsWith(suffix)) return path;
      }
      return null;
    };

    const descPath = inSection('descriptor.xml');
    const desc = descPath ? await entries.get(descPath)!.async('string') : '';
    const paperTag = /<[^>]*Paper\b[^>]*>/.exec(desc)?.[0] ?? '';
    const paperUnits = attr(paperTag, 'units');
    const paperW = Number(attr(paperTag, 'width'));
    const paperH = Number(attr(paperTag, 'height'));

    const w2dPath = inSection('.w2d');
    const scraped = w2dPath
      ? scrapeW2d(await entries.get(w2dPath)!.async('nodebuffer'))
      : { layers: [], labels: [], labelTotal: 0 };

    sheets.push({
      title,
      section: name,
      sourceFile: property(desc, 'File Name'),
      author: property(desc, 'Author'),
      creator: property(desc, 'Creator'),
      layout: property(desc, 'Layout Name'),
      paper:
        paperUnits && Number.isFinite(paperW) && Number.isFinite(paperH)
          ? `${paperW.toFixed(1)} × ${paperH.toFixed(1)} ${paperUnits}`
          : null,
      thumbnailPath: inSection('.png'),
      ...scraped,
    });
  }

  return { version: versionMatch?.[1] ?? null, sheets };
}

/**
 * DWF → the plain-text digest the extract pipeline indexes.
 *
 * Shape: a set header, one block per sheet (identity, source DWG, layers,
 * top labels), then the cross-sheet layer registry — on circuitization sets
 * that registry is the list of circuits the whole file exists to publish.
 * Returns '' when the container holds no ePlot sheets at all (e.g. a 3D
 * eModel DWF), which the extractor records as its honest no-text skip.
 */
export async function parseDwf(bytes: Buffer): Promise<string> {
  const { version, sheets } = await parseDwfStructured(bytes);
  if (sheets.length === 0) return '';

  const out: string[] = [];
  out.push(
    `DWF drawing set${version ? ` (${version})` : ''} — ${sheets.length} sheet${sheets.length === 1 ? '' : 's'}. ` +
      'Published plot: sheet metadata, layers and annotation text below; vector geometry stays in the source DWGs named per sheet.',
  );

  const registry = new Map<string, string[]>(); // layer → sheet titles
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
      for (const layer of s.layers) {
        const on = registry.get(layer) ?? [];
        on.push(s.title);
        registry.set(layer, on);
      }
    }
    if (s.labels.length) {
      const top = s.labels
        .slice(0, DIGEST_LABELS_PER_SHEET)
        .map((l) => (l.count > 1 ? `${l.text} (×${l.count})` : l.text));
      out.push(
        `Annotation text (${s.labelTotal} labels, ${s.labels.length} unique): ${top.join(', ')}` +
          (s.labels.length > DIGEST_LABELS_PER_SHEET ? ', …' : ''),
      );
    }
  }

  if (registry.size) {
    out.push('');
    out.push(`## Layer registry across sheets (${registry.size})`);
    for (const [layer, on] of registry) {
      out.push(`${layer} — on sheet${on.length === 1 ? '' : 's'} ${on.join(', ')}`);
    }
  }

  return out.join('\n');
}
