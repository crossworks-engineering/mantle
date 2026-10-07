/**
 * Foldable headings on a STATIC render: the share reader (/s pages), and the
 * client's read views (StaticDoc / PageView), which all draw a page as plain
 * HTML with no editor behind it. The live editor does the same job with a
 * ProseMirror plugin over the same rules (content-core heading-fold.ts).
 *
 * A foldable heading arrives as `<hN data-fold="open|closed">`. This adds the
 * arrow button in front of its text and hides its section by setting
 * `data-fold-hidden` on the blocks under it (app.css hides those on screen
 * only, so print always shows the whole page). A click anywhere on the
 * heading row folds or unfolds it, except a click on a link inside it. The
 * reader's choice is remembered in localStorage by the heading's block id
 * (`data-block-id` on the client render, `id` on the server render).
 *
 * Without script (the print surface, a reader with JS off) nothing here runs:
 * the page shows every section open and no arrow, which reads fine.
 *
 * The arrows are added once per heading, so a second call on the same root
 * adds none. Returns a cleanup that removes the click listener.
 */
import {
  foldSections,
  isFolded,
  readFoldChoices,
  writeFoldChoice,
} from '@mantle/content-core/heading-fold';

const HEADING_SEL = 'h1[data-fold], h2[data-fold], h3[data-fold]';
const WIRED_ATTR = 'data-folds-wired';
export const FOLD_TOGGLE_CLASS = 'fold-toggle';

/** The chevron (lucide chevron-right). app.css turns it down when open. */
export const FOLD_CHEVRON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';

function headingLevel(el: Element): number | null {
  const m = /^H([1-6])$/.exec(el.tagName);
  return m ? Number(m[1]) : null;
}

function headingId(el: HTMLElement): string {
  return el.getAttribute('data-block-id') || el.id || '';
}

/** Hide or show every section under the foldable headings in `root`. */
function apply(root: HTMLElement): void {
  const choices = readFoldChoices();
  const parents = new Set<Element>();
  for (const h of root.querySelectorAll<HTMLElement>(HEADING_SEL)) {
    if (h.parentElement) parents.add(h.parentElement);
    const folded = isFolded(headingId(h), h.getAttribute('data-fold'), choices);
    h.toggleAttribute('data-folded', folded);
    const btn = h.querySelector(`:scope > .${FOLD_TOGGLE_CLASS}`);
    btn?.setAttribute('aria-expanded', String(!folded));
    btn?.setAttribute('aria-label', folded ? 'Unfold section' : 'Fold section');
  }
  for (const parent of parents) {
    const kids = Array.from(parent.children) as HTMLElement[];
    const hidden = new Array<boolean>(kids.length).fill(false);
    const sections = foldSections(
      kids.length,
      (i) => headingLevel(kids[i]!),
      (i) => kids[i]!.hasAttribute('data-fold'),
    );
    for (const [i, end] of sections) {
      if (!kids[i]!.hasAttribute('data-folded')) continue;
      for (let j = i + 1; j < end; j++) hidden[j] = true;
    }
    kids.forEach((k, i) => k.toggleAttribute('data-fold-hidden', hidden[i]!));
  }
}

/**
 * Open every fold that hides `el` (an outline jump to a heading inside a
 * folded section). The opening is remembered like a click. No-op when `el`
 * is not in a wired render or is not hidden.
 */
export function revealInFolds(el: Element | null | undefined): void {
  const root = el?.closest<HTMLElement>(`[${WIRED_ATTR}]`);
  if (!el || !root) return;
  for (let guard = 0; guard < 32; guard++) {
    const hid = el.closest('[data-fold-hidden]');
    if (!hid || !root.contains(hid)) return;
    // The nearest folded heading above it whose section still covers it.
    let opened = false;
    let minLevel = Infinity; // the highest heading met between it and `hid`
    for (let p = hid.previousElementSibling; p; p = p.previousElementSibling) {
      const lv = headingLevel(p);
      if (lv == null) continue;
      if (p.hasAttribute('data-folded') && lv < minLevel) {
        writeFoldChoice(headingId(p as HTMLElement), false);
        if (!headingId(p as HTMLElement)) p.setAttribute('data-fold', 'open');
        apply(root);
        opened = true;
        break;
      }
      minLevel = Math.min(minLevel, lv);
    }
    if (!opened) return;
  }
}

export function wireHeadingFolds(root: HTMLElement | null | undefined): () => void {
  if (!root) return () => {};
  const doc = root.ownerDocument;
  for (const h of root.querySelectorAll<HTMLElement>(HEADING_SEL)) {
    if (h.querySelector(`:scope > .${FOLD_TOGGLE_CLASS}`)) continue;
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = FOLD_TOGGLE_CLASS;
    btn.innerHTML = FOLD_CHEVRON_SVG;
    h.prepend(btn);
  }
  root.setAttribute(WIRED_ATTR, '');
  apply(root);

  const onClick = (e: MouseEvent) => {
    const target = e.target as Element | null;
    const h = target?.closest<HTMLElement>(HEADING_SEL);
    if (!h || !root.contains(h)) return;
    // A link in the heading still goes where it points.
    if (target?.closest('a') && !target.closest(`.${FOLD_TOGGLE_CLASS}`)) return;
    // A drag to select the heading's words is not a click on it.
    const sel = doc.getSelection();
    if (sel && !sel.isCollapsed && h.contains(sel.anchorNode)) return;
    e.preventDefault();
    writeFoldChoice(headingId(h), !h.hasAttribute('data-folded'));
    // A heading without an id cannot be remembered: flip it for this view.
    if (!headingId(h))
      h.setAttribute('data-fold', h.hasAttribute('data-folded') ? 'open' : 'closed');
    apply(root);
  };
  root.addEventListener('click', onClick);
  return () => root.removeEventListener('click', onClick);
}
