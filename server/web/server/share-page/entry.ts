/**
 * Client runtime for the /s share reader's page chrome — deliberately NOT an
 * island: islands.js carries React and the interactive presenters, and none
 * of that should ride along on a fully static shared page just to draw a
 * toggle button. This bundle is vanilla DOM + (lazily) the Neat WebGL lib.
 *
 * Two jobs:
 *  - The visitor's light/dark toggle. The owner's default arrives stamped on
 *    `<html>` (class + data-share-mode-default, applied before paint by the
 *    inline script in template.ts); the toggle overlays the visitor's own
 *    choice via localStorage, and 'system' defaults follow the OS live until
 *    the visitor chooses.
 *  - The saved Neat gradient. The host div carries the spec
 *    (`[data-neat-spec]`, only rendered when a background is saved); the
 *    WebGL specifics live in the shared mountNeat (which dynamically imports
 *    @firecms/neat, so the chunk is only fetched on brains that actually
 *    saved one). Rebuilt on every mode flip — the theme tokens it derives
 *    colours from change with the `.dark` class.
 *
 * Bundled by scripts/build-share-runtime.ts (esbuild, `splitting: true`) into
 * public/share-runtime/share-page.js + a lazy chunk for the Neat lib.
 */
import { SHARE_MODE_STORAGE_KEY } from '@mantle/share-ui/share-mode';
import { decodeNeatSpec } from '@mantle/share-ui/neat-background';
import { mountNeat, type NeatMountHandle } from '@mantle/share-ui/neat-mount';

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

// ── The Neat backdrop ────────────────────────────────────────────────────────

const neatHost = document.querySelector<HTMLElement>('[data-neat-spec]');
const neatSpec = neatHost ? decodeNeatSpec(neatHost.dataset.neatSpec) : null;
let gradient: NeatMountHandle | null = null;
let raf = 0;
// Repaint generation — the vanilla stand-in for the React renderer's
// `disposed` flag. A fast double-toggle leaves an EARLIER mount still in
// flight past its await; without this check it would land a second gradient
// on a detached canvas that animates (and holds a WebGL context) forever.
let epoch = 0;

function repaintNeat(): void {
  if (!neatHost || !neatSpec) return;
  const host = neatHost;
  const spec = neatSpec;
  const mine = ++epoch;
  cancelAnimationFrame(raf);
  gradient?.destroy();
  gradient = null;
  // A frame later, the mountNeat timing contract: class toggles and style
  // resolution settle first, so the tokens read are the INCOMING mode's.
  raf = requestAnimationFrame(() => {
    const canvas = document.createElement('canvas');
    canvas.className = 'absolute inset-0 size-full';
    host.replaceChildren(canvas);
    void mountNeat(canvas, spec, currentMode(), {
      resolution: 0.75,
      licenseKey: host.dataset.neatLicense,
    }).then((handle) => {
      // Superseded while awaiting — a newer repaint owns the host now.
      if (mine !== epoch) {
        handle?.destroy();
        return;
      }
      // Nothing mounted (no WebGL, unresolvable theme) — drop the dead canvas;
      // body's bg-background is the designed ground.
      if (!handle) {
        host.replaceChildren();
        return;
      }
      gradient = handle;
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
    'border border-border/60 bg-background/70 text-muted-foreground backdrop-blur ' +
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
  repaintNeat();
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
repaintNeat();
