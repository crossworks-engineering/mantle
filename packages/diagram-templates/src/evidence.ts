/**
 * The image check's evidence in a live canvas: a click (or Enter) on a
 * checked guess opens what the model judged: the crop, the question, the
 * answer (and what the image says it is instead), the reason and the
 * model.
 *
 * The crop reaches the frame without the network: the canvas carries it in
 * its assets block (`<script type="application/json" id="diagram-assets">`,
 * canvas.ts), embedded when the canvas was saved, and it is shown from a
 * `data:` URL (the frame's CSP allows `img-src data:` and nothing else).
 * Every value read from the canvas is shown as text or checked before use:
 * a crop must be a base64 PNG, JPEG or WebP data URL under the size cap
 * (CROP_LIMITS), and the save that stored it checked the server's seal of
 * it (withSealedCanvasAssets).
 */
import type { CheckEvidence } from './types.ts';
import type { CheckState, PidCheck } from './templates/pid/check.ts';
import { parseCanvasAssets } from './canvas.ts';

const WORDS: Record<CheckState, string> = {
  unchecked: 'Guess, not checked by image',
  checked: 'Checked by image (never certain)',
  contradicted: 'Image says no (still a guess)',
  unsure: 'Image unsure (still a guess)',
  corrected: 'From image (corrected, never certain)',
};
const KIND: Record<PidCheck['kind'], string> = {
  join: 'Inferred join',
  end: 'End near equipment',
  link: 'Link to another sheet',
  valve: 'Valve type',
};
/** One line naming the states of an element's checks. */
const summary = (checks: readonly PidCheck[]) =>
  checks.length === 1
    ? (WORDS[checks[0]!.state] ?? checks[0]!.state)
    : `${checks.length} guesses: ${[...new Set(checks.map((c) => WORDS[c.state] ?? c.state))].join('; ')}`;

/** The crops a canvas carries, by file id, from its assets block's text
 *  as the runtime read it at start (data-read.ts readDataBlock: only from
 *  where buildCanvas puts it): the pictures only (the seals were checked
 *  by the save that stored them), each one `safeCropUrl` passed (canvas.ts
 *  parseCanvasAssets, the one reader). */
export function readCrops(assets: string | null): Map<string, string> {
  const { crops } = parseCanvasAssets(assets);
  return new Map(Object.entries(crops).map(([id, c]) => [id, c.src]));
}

const CSS = `
.diagram-evidence{position:fixed;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;background:rgba(45,49,66,.35);padding:16px;box-sizing:border-box}
.diagram-evidence[hidden]{display:none}
.diagram-evidence>div{background:#fff;color:#2d3142;border-radius:10px;box-shadow:0 6px 28px rgba(45,49,66,.3);max-width:640px;width:100%;max-height:100%;overflow:auto;scrollbar-width:thin;padding:16px 20px;box-sizing:border-box;font:13px/1.5 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
.diagram-evidence>div::-webkit-scrollbar{width:6px;height:6px}
.diagram-evidence>div::-webkit-scrollbar-thumb{background:#bfc0c0;border-radius:3px}
.diagram-evidence h2{font-size:15px;margin:0 0 2px}
.diagram-evidence h3{font-size:13px;margin:12px 0 6px}
.diagram-evidence .what{color:#4f5d75;margin:0 0 12px}
.diagram-evidence img{display:block;max-width:100%;height:auto;border:1px solid #bfc0c0;border-radius:4px;margin:0 0 12px;background:#f5f5f5}
.diagram-evidence .nocrop{color:#4f5d75;font-style:italic;margin:0 0 12px}
.diagram-evidence dl{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:0 0 12px}
.diagram-evidence dt{color:#4f5d75}
.diagram-evidence dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.diagram-evidence button{font:inherit;padding:4px 12px;border:1px solid #bfc0c0;border-radius:6px;background:#fff;color:#2d3142;cursor:pointer}
.diagram-evidence button:focus-visible{outline:2px solid #1d5fa8;outline-offset:1px}
#diagram [data-check]{cursor:pointer}
#diagram [data-check]:focus-visible{outline:2px solid #1d5fa8;outline-offset:2px}
@media print{.diagram-evidence{display:none!important}}
`.trim();

export type EvidenceView = {
  /** The evidence of the drawing shown now (a set's page changes it). */
  set(items: readonly CheckEvidence[]): void;
  open(key: string): boolean;
  close(): void;
  readonly isOpen: boolean;
};

/**
 * Wire the evidence into `target` (the element the drawing is drawn in).
 * Call `set` with the evidence of the drawing shown, after each draw.
 */
export function mountEvidence(
  doc: Document,
  target: HTMLElement,
  crops: ReadonlyMap<string, string>,
): EvidenceView {
  const style = doc.createElement('style');
  style.textContent = CSS;
  doc.head.appendChild(style);
  const overlay = doc.createElement('div');
  overlay.className = 'diagram-evidence';
  overlay.hidden = true;
  const panel = doc.createElement('div');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'diagram-evidence-title');
  panel.tabIndex = -1;
  overlay.appendChild(panel);
  doc.body.appendChild(overlay);

  let items = new Map<string, CheckEvidence>();
  let back: HTMLElement | null = null;

  const add = (parent: Element, tag: string, text?: string, cls?: string) => {
    const e = doc.createElement(tag);
    if (text !== undefined) e.textContent = text;
    if (cls) e.className = cls;
    parent.appendChild(e);
    return e;
  };

  const close = () => {
    if (overlay.hidden) return;
    overlay.hidden = true;
    panel.replaceChildren();
    back?.focus?.();
    back = null;
  };

  const open = (key: string): boolean => {
    const ev = items.get(key);
    if (!ev) return false;
    back = doc.activeElement as HTMLElement | null;
    panel.replaceChildren();
    const h = add(panel, 'h2', summary(ev.checks));
    h.id = 'diagram-evidence-title';
    add(panel, 'p', `About ${ev.what}`, 'what');
    ev.checks.forEach((c, i) => {
      if (ev.checks.length > 1) add(panel, 'h3', `${i + 1}. ${WORDS[c.state] ?? c.state}`);
      const shown = (c.crops ?? [])
        .map((id) => crops.get(id.toLowerCase()))
        .filter((u): u is string => !!u);
      for (const url of shown) {
        const img = doc.createElement('img');
        img.alt = `A close-up of the drawing the model judged, for ${ev.what}`;
        img.src = url;
        panel.appendChild(img);
      }
      if (!shown.length)
        add(
          panel,
          'p',
          c.crops?.length
            ? "The crops are kept with the drawing's Checks tab; they are not embedded in this canvas."
            : c.state === 'unchecked'
              ? 'No image has checked this guess yet.'
              : 'No crop is named for this check.',
          'nocrop',
        );
      const dl = add(panel, 'dl');
      const row = (k: string, v?: string) => {
        if (!v) return;
        add(dl, 'dt', k);
        add(dl, 'dd', v);
      };
      row('Guess', [KIND[c.kind], c.guess].filter(Boolean).join(': '));
      row('Question', c.question);
      row(
        'Answer',
        c.answer
          ? `${c.answer === 'yes' ? 'Yes' : c.answer === 'no' ? 'No' : 'Unsure'}${c.alt ? `. The image says it is: ${c.alt}` : ''}`
          : c.alt
            ? `The image says it is: ${c.alt}`
            : undefined,
      );
      row('Reason', c.reason);
      row('Model', c.model);
      row('Checked at', c.checkedAt);
    });
    const done = add(panel, 'button', 'Close') as HTMLButtonElement;
    done.type = 'button';
    done.addEventListener('click', close);
    overlay.hidden = false;
    // The dialog itself takes focus (not its button: the Space that opened
    // it would press the button on its key up); Tab reaches Close.
    panel.focus();
    return true;
  };

  /** Each checked item: one button that opens its evidence (one tab
   *  stop). Its badge when it has one (style 2), else the first of its
   *  elements (a line's path and its note are one item). A connector that
   *  is also a page link stays a link; its badge opens the evidence. The
   *  other parts still open it on a click. */
  const label = () => {
    const badged = new Set<string>();
    for (const el of target.querySelectorAll('[data-part="check-badge"][data-check]'))
      badged.add(el.getAttribute('data-check') ?? '');
    const stopped = new Set<string>();
    for (const el of target.querySelectorAll('[data-check]')) {
      if (el.hasAttribute('data-link')) continue;
      const key = el.getAttribute('data-check') ?? '';
      const ev = items.get(key);
      if (!ev) continue;
      if (badged.has(key) && el.getAttribute('data-part') !== 'check-badge') continue;
      if (stopped.has(key)) continue;
      stopped.add(key);
      el.setAttribute('tabindex', '0');
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', `Image check of ${ev.what}: ${summary(ev.checks)}`);
    }
  };

  const hit = (e: Event): string | null => {
    const el = (e.target as Element | null)?.closest?.('[data-check],[data-link]');
    if (!el || el.hasAttribute('data-link') || !target.contains(el)) return null;
    return el.getAttribute('data-check');
  };
  target.addEventListener('click', (e) => {
    const key = hit(e);
    if (key && open(key)) e.preventDefault();
  });
  // Capture, so an open dialog takes the keys before the zoom and the
  // page bar (they skip a key whose default is prevented).
  doc.addEventListener(
    'keydown',
    (e) => {
      if (!overlay.hidden) {
        if (e.key === 'Escape') close();
        else if (e.key === 'Tab') panel.querySelector('button')?.focus();
        // Enter and Space press the Close button; nothing else acts.
        if (e.key !== 'Enter' && e.key !== ' ') e.preventDefault();
        return;
      }
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const key = hit(e);
      if (key && open(key)) e.preventDefault();
    },
    true,
  );
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  return {
    set(list) {
      items = new Map(list.map((c) => [c.key, c]));
      label();
    },
    open,
    close,
    get isOpen() {
      return !overlay.hidden;
    },
  };
}
