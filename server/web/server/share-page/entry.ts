/**
 * Client runtime for the /s share reader's page chrome — deliberately NOT an
 * island: islands.js carries React and the interactive presenters, and none
 * of that should ride along on a fully static shared page just to draw a
 * toggle button. This bundle is vanilla DOM + (lazily) the Drift WebGL engine.
 *
 * Three jobs:
 *  - The visitor's light/dark toggle. The owner's default arrives stamped on
 *    `<html>` (class + data-share-mode-default, applied before paint by the
 *    inline script in template.ts); the toggle overlays the visitor's own
 *    choice via localStorage, and 'system' defaults follow the OS live until
 *    the visitor chooses.
 *  - The saved Drift background. The host div carries the spec
 *    (`[data-neat-spec]`, the stored key's name, only rendered when a
 *    background is saved) and the surface's look (`[data-drift-surface]`); the WebGL specifics live in the shared mountDrift
 *    (which dynamically imports the engine, so the chunk is only fetched on
 *    brains that actually saved one). Repainted on every mode flip: the theme
 *    tokens it derives colours from change with the `.dark` class.
 *  - Foldable headings on a shared page (share-ui heading-fold-dom.ts): the
 *    arrows, the folding, and the visitor's remembered choices.
 *
 * Bundled by scripts/build-share-runtime.ts (esbuild, `splitting: true`) into
 * public/share-runtime/share-page.js + a lazy chunk for the Drift engine.
 */
import { SHARE_MODE_STORAGE_KEY } from '@mantle/share-ui/share-mode';
import { decodeDriftSpec } from '@mantle/content-core/drift-spec';
import { mountDrift, readDriftSurface, type DriftMountHandle } from '@mantle/share-ui/drift-mount';
import { wireHeadingFolds } from '@mantle/share-ui/heading-fold-dom';

const root = document.documentElement;

function currentMode(): 'light' | 'dark' {
  return root.classList.contains('dark') ? 'dark' : 'light';
}

function storedMode(): 'light' | 'dark' | null {
  try {
    const v = localStorage.getItem(SHARE_MODE_STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null; // private mode — the toggle still works, it just won't stick
  }
}

function applyMode(mode: 'light' | 'dark'): void {
  // Just the class — the observer below owns the repaint, so EVERY way the
  // mode can change (this toggle, the OS scheme, an app frame's parent-posted
  // theme sync rewriting className) funnels through one repaint path.
  root.classList.toggle('dark', mode === 'dark');
}

// ── The Drift backdrop ───────────────────────────────────────────────────────

const driftHost = document.querySelector<HTMLElement>('[data-neat-spec]');
const driftSpec = driftHost ? decodeDriftSpec(driftHost.dataset.neatSpec) : null;
// The /s reader's host says 'public' (full colour, its text on an opaque
// sheet); an app frame's says nothing and paints the floored 'app' look,
// since an app's own text sits right on the gradient.
const driftSurface = readDriftSurface(driftHost?.dataset.driftSurface);
let backdrop: DriftMountHandle | null = null;
let mounting = false;
let raf = 0;

function repaintDrift(): void {
  if (!driftHost || !driftSpec) return;
  const host = driftHost;
  const spec = driftSpec;
  cancelAnimationFrame(raf);
  // A frame later, the mountDrift timing contract: class toggles and style
  // resolution settle first, so the tokens read are the INCOMING mode's.
  raf = requestAnimationFrame(() => {
    // A mode flip is new colours on the same context, never a teardown.
    if (backdrop) {
      backdrop.repaint(currentMode());
      return;
    }
    // A flip while the first mount is still awaiting its chunk: that mount
    // reads the tokens after the await, so it already lands in the new mode.
    if (mounting) return;
    mounting = true;
    const canvas = document.createElement('canvas');
    canvas.className = 'absolute inset-0 size-full';
    host.replaceChildren(canvas);
    void mountDrift(canvas, spec, currentMode(), driftSurface).then((handle) => {
      mounting = false;
      // Nothing mounted (no WebGL, unresolvable theme): drop the dead canvas;
      // body's bg-background is the designed ground.
      if (!handle) {
        host.replaceChildren();
        return;
      }
      backdrop = handle;
      // The mode may have flipped while the chunk loaded.
      handle.repaint(currentMode());
    });
  });
}

// ── The mode toggle ──────────────────────────────────────────────────────────

const SUN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-4"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>';
const MOON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-4"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';

function paintToggle(button: HTMLButtonElement): void {
  const dark = currentMode() === 'dark';
  // The icon shows the mode a press LANDS on, not the one you are in.
  button.innerHTML = dark ? SUN : MOON;
  button.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
  button.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
}

function mountToggle(): void {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.shareModeToggle = '1';
  button.className =
    'fixed right-4 top-4 z-20 inline-flex size-9 items-center justify-center rounded-full ' +
    'border border-border/60 bg-background text-muted-foreground ' +
    'transition-colors hover:text-foreground';
  paintToggle(button);
  button.addEventListener('click', () => {
    const next = currentMode() === 'dark' ? 'light' : 'dark';
    try {
      localStorage.setItem(SHARE_MODE_STORAGE_KEY, next);
    } catch {
      // private mode — the flip below still applies for this page view
    }
    applyMode(next);
    paintToggle(button);
  });
  document.body.appendChild(button);
}

// One repaint path for every mode change: the class attribute is the truth,
// whoever writes it. Covers the toggle, the OS-scheme listener, AND an app
// frame's theme sync (the frame boot script rewrites className when the
// parent posts {kind:'theme'} — this observer is what repaints the gradient
// there, since no toggle exists inside a frame).
let lastDark = currentMode() === 'dark';
new MutationObserver(() => {
  const dark = currentMode() === 'dark';
  if (dark === lastDark) return;
  lastDark = dark;
  repaintDrift();
  const button = document.querySelector<HTMLButtonElement>('[data-share-mode-toggle]');
  if (button) paintToggle(button);
}).observe(root, { attributes: true, attributeFilter: ['class'] });

// A 'system' default keeps following the OS until the visitor chooses.
if (root.dataset.shareModeDefault === 'system' && !storedMode()) {
  const scheme = window.matchMedia('(prefers-color-scheme: dark)');
  scheme.addEventListener('change', () => {
    if (storedMode()) return; // a choice has been made since — it wins
    applyMode(scheme.matches ? 'dark' : 'light');
  });
}

// The toggle belongs to the /s READER, whose template stamps the default-mode
// attribute. App frames load this bundle for the backdrop alone and lack the
// attribute, so no toggle ever floats over an app's own UI.
if (root.dataset.shareModeDefault !== undefined) mountToggle();
repaintDrift();

// A shared page's foldable headings (the page presenter's `.ProseMirror`).
for (const doc of document.querySelectorAll<HTMLElement>('.ProseMirror')) wireHeadingFolds(doc);
