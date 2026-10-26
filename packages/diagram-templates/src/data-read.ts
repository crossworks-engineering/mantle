/**
 * How the browser runtime reads a canvas's data block, and when it trusts
 * the image check marks in it (DWG bones phase 6).
 *
 * A save holds every canvas that claims the `pid` template to exactly what
 * buildCanvas writes (@mantle/content drawing-seal, canvas.ts
 * canonicalPidCanvas): the head, an empty drawing and error box, the data
 * block, the shipped runtime, nothing else. Its marks are then the ones
 * circuit_trace sealed. Anything else is the author's own HTML, which may
 * draw any picture (the threat model in templates/pid/check.ts): the
 * runtime then draws every mark unchecked (GUESS, no evidence, no count of
 * checked guesses), never a check it cannot vouch for.
 *
 * So the runtime reads the block once, when `mount()` is called (the
 * inline runtime: as its script runs, right after the block, before any
 * later script; the import: once the document is parsed), and only trusts
 * the marks when the block sits where buildCanvas puts it: a plain HTML
 * `<script type="application/json">`, the third child of `<body>`, after
 * the empty `#diagram` and `#diagram-errors` and before the runtime's own
 * script, with no other element in the body, no SVG or MathML anywhere
 * (where a script's text reads differently), and no script but those two
 * at all but one import map in the head (the Present frame's prelude
 * holds one, and its classic script removes itself as it runs: share-ui
 * canvas-frame-html.ts). Limit: a script that ran before the runtime and
 * removed itself leaves no trace in the document; a save never stores one
 * in a canvas that claims the template, and a canvas that does not is the
 * author's picture.
 */
import { DATA_ID } from './canvas.ts';
import { honestImageChecks, withImageCheckSummary } from './templates/pid/check.ts';

const XHTML = 'http://www.w3.org/1999/xhtml';
const SVG = 'http://www.w3.org/2000/svg';
const MATHML = 'http://www.w3.org/1998/Math/MathML';

/** The data block's text as read at start, and whether it sat where
 *  buildCanvas puts it. */
export type DataRead = { text: string | null; canonical: boolean };

const isHtml = (el: Element | undefined, name: string): el is Element =>
  !!el && el.namespaceURI === XHTML && el.localName === name;

/** Whether `block` sits in a document laid out as buildCanvas writes it. */
function inCanonicalPlace(doc: Document, block: Element): boolean {
  const body = doc.body;
  if (!body || block.parentElement !== body) return false;
  if (!isHtml(block, 'script') || block.getAttribute('type') !== 'application/json') return false;
  const kids = Array.from(body.children);
  if (kids.length !== 4) return false;
  const [main, errors, data, runtime] = kids;
  if (!isHtml(main, 'main') || main.id !== 'diagram' || main.childNodes.length) return false;
  if (!isHtml(errors, 'div') || errors.id !== 'diagram-errors' || errors.childNodes.length)
    return false;
  if (data !== block || !isHtml(runtime, 'script')) return false;
  if (doc.getElementsByTagNameNS(SVG, '*').length || doc.getElementsByTagNameNS(MATHML, '*').length)
    return false;
  let maps = 0;
  for (const s of Array.from(doc.getElementsByTagName('script'))) {
    if (s === block || s === runtime) continue;
    if (s.parentElement !== doc.head) return false;
    if ((s.getAttribute('type') ?? '').trim().toLowerCase() !== 'importmap') return false;
    maps += 1;
  }
  return maps <= 1;
}

/** The data block, read now (call it once, at start). */
export function readDataBlock(doc: Document): DataRead {
  const block = doc.getElementById(DATA_ID);
  if (!block) return { text: null, canonical: false };
  return { text: block.textContent, canonical: inCanonicalPlace(doc, block) };
}

/** `pid` data with no mark the runtime can vouch for: every mark
 *  unchecked with its evidence gone, no provenance, no trust word in a
 *  label, the counts its own (what a save stores for a drawing with no
 *  sealed provenance). */
export function unvouched(data: unknown): unknown {
  return withImageCheckSummary(honestImageChecks(data, () => false));
}
