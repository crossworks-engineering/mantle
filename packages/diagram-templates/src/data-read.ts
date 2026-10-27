/**
 * How the browser runtime reads a canvas's data block, and when it trusts
 * the image check marks in it (DWG bones phase 6).
 *
 * The threat model (templates/pid/check.ts): a canvas's frame content is
 * author-controlled, and anyone with Write can draw any picture. What is
 * vouched for is narrower: the canonical template path never shows a mark
 * no save checked. A save holds every canvas whose data names the `pid`
 * template to exactly what buildCanvas writes (@mantle/content
 * drawing-seal, canvas.ts canonicalPidCanvas), its marks the ones
 * circuit_trace sealed. So the runtime trusts the marks it reads only in
 * a document laid out exactly that way, read the way buildCanvas's own
 * runtime reads it:
 *
 *  - the block sits where buildCanvas puts it: a plain HTML `<script
 *    type="application/json">`, the third child of `<body>`, after the
 *    empty `#diagram` and `#diagram-errors`, then the assets block when the
 *    drawing embeds crops, then the runtime;
 *  - the runtime is exactly the import buildCanvas writes (a module script
 *    with that text and no other attribute: IMPORT_RUNTIME_TEXT), never an
 *    inline copy or a script of the author's;
 *  - no other element in the body, no SVG or MathML anywhere (where a
 *    script's text reads differently), and no other script but one import
 *    map in the head (the Present frame's prelude holds one, and its
 *    classic script removes itself as it runs: share-ui
 *    canvas-frame-html.ts);
 *  - the data itself names the template (`template: "pid"`, canvas.ts
 *    isPidData): the head's meta may pick what to draw, never what to
 *    trust;
 *  - `mount()` is called on the live document (browser.ts): one parsed
 *    from a string (DOMParser) or another frame's is read as untrusted.
 *
 * What this does not do: it does not make an author's page honest. A
 * script of the author's that runs before the runtime and removes itself
 * leaves no trace in the document, and an author can draw any words in
 * their own markup. The runtime cannot tell such a page from the
 * template's own. A save does not store one as a canvas whose data names
 * `pid` (it rebuilds each of those exactly as buildCanvas writes it, with
 * no author script), but a canvas stored before those checks shipped
 * (until pid-canvas-resave writes it again) or a page served by another
 * path is not held to that, and what it shows is then the author's
 * picture, not the template's claim. The Checks tab of the drawing's
 * table stays the proof. Anywhere the layout does not hold, the runtime
 * draws every mark unchecked (GUESS, no evidence, no count of checked
 * guesses).
 *
 * The block is read once, when `mount()` is called (the import runs once
 * the document is parsed).
 */
import { ASSETS_ID, DATA_ID, IMPORT_RUNTIME_TEXT } from './canvas.ts';
import { honestImageChecks, mapDrawings, withImageCheckSummary } from './templates/pid/check.ts';
import { pidLimitsProblem } from './templates/pid/limits.ts';

const XHTML = 'http://www.w3.org/1999/xhtml';
const SVG = 'http://www.w3.org/2000/svg';
const MATHML = 'http://www.w3.org/1998/Math/MathML';

/** The data block's text as read at start, whether it sat where
 *  buildCanvas puts it, and the assets block's text (the image check's
 *  crops), read at the same time and only from that place: null when the
 *  block is not canonical or the canvas embeds no crops. The evidence view
 *  runs on a canonical read only. */
export type DataRead = { text: string | null; canonical: boolean; assets: string | null };

const isHtml = (el: Element | undefined, name: string): el is Element =>
  !!el && el.namespaceURI === XHTML && el.localName === name;

const isJsonScript = (el: Element | undefined): el is Element =>
  isHtml(el, 'script') && el.getAttribute('type') === 'application/json';

/** The runtime exactly as buildCanvas writes it: a module script whose
 *  only attribute is its type and whose text is the import (no `src`, no
 *  other script in its place). */
const isImportRuntime = (el: Element | undefined): el is Element =>
  isHtml(el, 'script') &&
  el.getAttribute('type') === 'module' &&
  el.getAttributeNames().length === 1 &&
  el.textContent === IMPORT_RUNTIME_TEXT;

/** The assets block of a document laid out as buildCanvas writes it (null
 *  when it embeds none), or false when `block` is not in that layout. */
function inCanonicalPlace(doc: Document, block: Element): Element | null | false {
  const body = doc.body;
  if (!body || block.parentElement !== body) return false;
  if (!isJsonScript(block)) return false;
  const kids = Array.from(body.children);
  // The assets block, when there is one, sits between the data block and
  // the runtime: the fifth child of five.
  if (kids.length !== 4 && kids.length !== 5) return false;
  const assets = kids.length === 5 ? kids[3]! : null;
  if (assets && (!isJsonScript(assets) || assets.id !== ASSETS_ID)) return false;
  const [main, errors, data] = kids;
  const runtime = kids[kids.length - 1];
  if (!isHtml(main, 'main') || main.id !== 'diagram' || main.childNodes.length) return false;
  if (!isHtml(errors, 'div') || errors.id !== 'diagram-errors' || errors.childNodes.length)
    return false;
  if (data !== block || !isImportRuntime(runtime)) return false;
  if (doc.getElementsByTagNameNS(SVG, '*').length || doc.getElementsByTagNameNS(MATHML, '*').length)
    return false;
  let maps = 0;
  for (const s of Array.from(doc.getElementsByTagName('script'))) {
    if (s === block || s === runtime || s === assets) continue;
    if (s.parentElement !== doc.head) return false;
    if ((s.getAttribute('type') ?? '').trim().toLowerCase() !== 'importmap') return false;
    maps += 1;
  }
  return maps <= 1 ? assets : false;
}

/** The data block, read now (call it once, at start). */
export function readDataBlock(doc: Document): DataRead {
  const block = doc.getElementById(DATA_ID);
  if (!block) return { text: null, canonical: false, assets: null };
  const place = inCanonicalPlace(doc, block);
  return {
    text: block.textContent,
    canonical: place !== false,
    assets: place ? place.textContent : null,
  };
}

/** `pid` data with no mark the runtime can vouch for: every mark
 *  unchecked with its evidence gone, no provenance, no trust word in a
 *  label, the counts its own (what a save stores for a drawing with no
 *  sealed provenance). Data past a size the template holds a drawing to
 *  (pidLimitsProblem) is not normalized at all: its marks and provenance
 *  are dropped whole (the template's check then refuses it). */
export function unvouched(data: unknown): unknown {
  if (pidLimitsProblem(data) !== null) return withoutMarks(data);
  return withImageCheckSummary(honestImageChecks(data, () => false));
}

/** `pid` data with no mark, provenance or count left on it: each drawing's
 *  connectors', lines' and inline items' marks taken off, in one pass. */
function withoutMarks(data: unknown): unknown {
  const bare = (o: unknown, ...keys: string[]): unknown => {
    if (typeof o !== 'object' || o === null || Array.isArray(o)) return o;
    const out = { ...(o as Record<string, unknown>) };
    for (const k of keys) delete out[k];
    return out;
  };
  const list = (v: unknown, f: (x: unknown) => unknown) => (Array.isArray(v) ? v.map(f) : v);
  const top = bare(data, 'provenance', 'checks');
  return mapDrawings(top, (d) => {
    const out = bare(d, 'provenance', 'checks') as Record<string, unknown>;
    if (Array.isArray(d.offpage)) out.offpage = list(d.offpage, (o) => bare(o, 'check'));
    if (Array.isArray(d.lines))
      out.lines = list(d.lines, (l) => {
        const line = bare(l, 'checks');
        if (typeof line !== 'object' || line === null || Array.isArray(line)) return line;
        const r = line as Record<string, unknown>;
        return Array.isArray(r.inline)
          ? { ...r, inline: list(r.inline, (it) => bare(it, 'check')) }
          : r;
      });
    return out;
  });
}
