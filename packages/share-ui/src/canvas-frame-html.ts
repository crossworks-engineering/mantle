/**
 * The Present canvas FRAME document: what a sandboxed iframe navigates to
 * (GET /api/presents/[id]/frame, docs/proposals/canvas-files.md section 5.2).
 * Pure string building, served by the brain, as the mini-app frame
 * (./app-frame-html.ts) is, minus the bridge: a canvas gets no database, no
 * tools and no network. It is presentation only.
 *
 * The canvas is the agent's own whole HTML document. The frame puts a short
 * PRELUDE before it (after the doctype): the import map, the theme, fonts and
 * kit stylesheets, the compiled Tailwind utilities, the fit, and the error
 * and ready reporters. Everything in the prelude is head content, so the
 * parser stays in the head and the canvas's own `<html>` and `<head>` tags
 * merge into the same document. Being first is what makes the import map
 * apply to every module script the canvas writes.
 *
 * Nothing here is a security boundary on its own. The boundary is the
 * response's CSP header (buildCanvasFrameCsp) and the iframe's
 * `sandbox="allow-scripts"`: an opaque origin, no cookies or storage, no
 * fetch, no form posts, no popups, no top navigation.
 */
import type { CanvasSize } from '@mantle/content-core/canvas';

/**
 * The canvas frame CSP, sent as a HEADER (section 5.2). Every source names
 * the brain origin explicitly: the document's origin is opaque, so `'self'`
 * would not mean the brain.
 *
 *  - `sandbox allow-scripts`: the document is sandboxed however it is
 *    reached, even opened directly in a tab.
 *  - Scripts: inline (the canvas IS inline script) and `'unsafe-eval'` for
 *    Alpine.js's attribute expressions (section 6.1), plus the vendored
 *    runtime only. No other host.
 *  - `img-src` and `media-src` are inline only: unlike an app frame, the brain
 *    origin is NOT listed, so a canvas cannot even fire a GET at our own API.
 *  - `connect-src 'none'`, `frame-src 'none'`, `form-action 'none'`,
 *    `base-uri 'none'`: no fetch, XHR, WebSocket, beacon, nested frame or
 *    post.
 *  - `frame-ancestors`: only the brain and the owner UI origins may frame it.
 *  - Workers: blob workers in a live frame; none in a render (`workers:
 *    false`), where a worker's console would reach the renderer past the
 *    page's caps. No library of the runtime needs one (Plotly only for its
 *    map tiles, which need the network).
 */
export function buildCanvasFrameCsp(
  origin: string,
  frameAncestors: readonly string[],
  opts: { workers?: boolean } = {},
): string {
  const ancestors = [...new Set([origin, ...frameAncestors])].join(' ');
  return (
    'sandbox allow-scripts; ' +
    "default-src 'none'; " +
    `script-src 'unsafe-inline' 'unsafe-eval' ${origin}/canvas-runtime/; ` +
    `style-src 'unsafe-inline' ${origin}/canvas-runtime/ ${origin}/share-runtime/; ` +
    'img-src data: blob:; ' +
    `font-src data: ${origin}/canvas-runtime/ ${origin}/share-runtime/ ${origin}/fonts/ ${origin}/Inter/; ` +
    'media-src data: blob:; ' +
    "connect-src 'none'; " +
    "frame-src 'none'; " +
    (opts.workers === false ? "worker-src 'none'; " : 'worker-src blob:; ') +
    "base-uri 'none'; " +
    "form-action 'none'; " +
    `frame-ancestors ${ancestors}`
  );
}

/**
 * The CSP the PARENT requires of whatever loads in a canvas iframe (CSP
 * embedded enforcement: the iframe's `csp` attribute, canvas-sandbox.tsx).
 * The frame document's own header already says all of this and more; what
 * this adds is for a page the canvas navigated its frame to: unless that
 * page answers `Allow-CSP-From`, the browser does not load it, and if it
 * does, it runs under these rules (no network, no forms). The directives an
 * embedder may not require (sandbox, frame-ancestors) are left out.
 * Chromium enforces it (the desktop app is Chromium); elsewhere the other
 * layers stand (the ready proof, the navigation guard).
 */
export function buildCanvasEmbedCsp(origin: string): string {
  return (
    "default-src 'none'; " +
    `script-src 'unsafe-inline' 'unsafe-eval' ${origin}/canvas-runtime/; ` +
    `style-src 'unsafe-inline' ${origin}/canvas-runtime/ ${origin}/share-runtime/; ` +
    'img-src data: blob:; ' +
    `font-src data: ${origin}/canvas-runtime/ ${origin}/share-runtime/ ${origin}/fonts/ ${origin}/Inter/; ` +
    'media-src data: blob:; ' +
    "connect-src 'none'; " +
    "frame-src 'none'; " +
    'worker-src blob:; ' +
    "base-uri 'none'; " +
    "form-action 'none'"
  );
}

/** JSON for an inline script: `<` and the two JS line separators escaped, so
 *  no value can close the tag. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Keep CSS text from closing its `<style>` tag (markup hygiene; the canvas
 *  runs its own script in this frame anyway). */
function styleText(css: string): string {
  return css.replace(/<\//g, '<\\/');
}

/**
 * Theme, fit, ready and error, in one classic inline script that runs while
 * the head parses, before the canvas's own scripts.
 *
 *  - WebRTC: removed before any canvas script runs. Its ICE traffic (a STUN
 *    host of the canvas's choice) is not under `connect-src` in Chromium, so
 *    it would be a way out; a canvas has no use for it, and the frame has no
 *    nested frame or other realm to take it back from.
 *  - Theme: the `<html>` class and data-color-theme are set at once (no flash),
 *    then follow the parent's `{v:1, kind:'theme'}` messages. A fixed-theme
 *    canvas ignores them.
 *  - Fit: a fixed design size scales to the frame with letterboxing (body
 *    transformed from its top left corner, recomputed on resize). `fill`
 *    leaves the layout to the canvas.
 *  - Ready and error: `{v:1, kind:'ready'}` on load, and every uncaught error
 *    or rejection as `{v:1, kind:'error', message}` (deduplicated), so the
 *    host can tell a broken canvas from a slow one. The parent checks
 *    `e.source` and accepts nothing else.
 */
function preludeScript(opts: {
  cls: string;
  colorTheme: string | null;
  followTheme: boolean;
  size: CanvasSize;
  nonce: string;
}): string {
  const cfg = scriptJson({
    cls: opts.cls,
    ct: opts.colorTheme,
    follow: opts.followTheme,
    size: opts.size === 'fill' ? null : opts.size,
    n: opts.nonce,
  });
  // The script takes itself out of the document as it runs: the nonce lives
  // on only in this closure, out of the canvas's reach (it runs later, in the
  // same document, and could otherwise read the script's text). The parent
  // is read once, first: `window.parent` is replaceable, and a canvas that
  // set it to an object of its own would be handed the nonce at load. The
  // real parent is another origin's window, whose postMessage a canvas
  // cannot change.
  return `(function(){
  var P=window.parent;
  var me=document.currentScript;if(me&&me.parentNode){me.parentNode.removeChild(me);}
  var cfg=${cfg};var h=document.documentElement;var nonce=cfg.n;cfg.n='';
  ['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel','RTCIceCandidate','RTCSessionDescription'].forEach(function(n){
    try{Object.defineProperty(window,n,{value:undefined,writable:false,configurable:false});}catch(_){}});
  function theme(cls,ct){h.className=cls||'';if(ct){h.setAttribute('data-color-theme',ct);}else{h.removeAttribute('data-color-theme');}}
  theme(cfg.cls,cfg.ct);
  window.addEventListener('message',function(e){
    if(e.source!==P)return;var m=e.data;if(!m||m.v!==1)return;
    if(m.kind==='theme'&&cfg.follow){theme(m.cls,m.colorTheme);}
  });
  if(cfg.size){
    var fit=function(){var W=cfg.size.w,H=cfg.size.h,iw=window.innerWidth||W,ih=window.innerHeight||H;
      var s=Math.min(iw/W,ih/H);if(!(s>0))s=1;
      h.style.setProperty('--canvas-scale',String(s));
      h.style.setProperty('--canvas-x',((iw-W*s)/2)+'px');
      h.style.setProperty('--canvas-y',((ih-H*s)/2)+'px');};
    fit();window.addEventListener('resize',fit);
  }
  var last='';
  function report(msg){var t=String(msg||'the canvas failed');if(t===last)return;last=t;
    try{P.postMessage({v:1,kind:'error',message:t.slice(0,500)},'*');}catch(_){}}
  window.addEventListener('error',function(e){
    if(e&&e.target&&e.target!==window&&e.target.tagName)return;
    report((e&&(e.message||(e.error&&e.error.message)))||'the canvas failed');},true);
  window.addEventListener('unhandledrejection',function(e){
    report((e&&e.reason&&(e.reason.message||e.reason))||'the canvas failed');});
  window.addEventListener('load',function(){
    try{P.postMessage({v:1,kind:'ready',n:nonce},'*');}catch(_){}});
})();`;
}

/** The ground and fit rules. A fixed canvas draws its body at the design
 *  size, scaled and centred; the html ground around it is the letterbox. */
function layoutCss(size: CanvasSize): string {
  if (size === 'fill') {
    return 'html,body{margin:0;height:100%}body{background:var(--background);color:var(--foreground)}';
  }
  return (
    'html{margin:0;height:100%;overflow:hidden;' +
    'background:color-mix(in oklab,var(--foreground) 8%,var(--background))}' +
    `body{position:absolute!important;left:0!important;top:0!important;margin:0!important;` +
    `width:${size.w}px!important;height:${size.h}px!important;overflow:hidden;` +
    'transform-origin:0 0!important;' +
    'transform:translate(var(--canvas-x,0px),var(--canvas-y,0px)) scale(var(--canvas-scale,1))!important;' +
    'background:var(--background);color:var(--foreground)}'
  );
}

/** The canvas source without a leading BOM or doctype (comments before it
 *  kept): the frame writes its own doctype first, so the document never
 *  parses in quirks mode. A linear scan, not a regex: a nested repeat over
 *  comments backtracks exponentially when no doctype follows, and this runs
 *  on every frame load (the canvas audit, 2026-10-24). */
export function stripLeadingDoctype(source: string): string {
  const start = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  let i = start;
  for (;;) {
    while (i < source.length && /\s/.test(source[i]!)) i++;
    if (!source.startsWith('<!--', i)) break;
    const end = source.indexOf('-->', i + 4);
    if (end < 0) return source.slice(start);
    i = end + 3;
  }
  const doctype = /^<!doctype[^>]*>/i.exec(source.slice(i, i + 1024));
  return doctype
    ? source.slice(start, i) + source.slice(i + doctype[0].length)
    : source.slice(start);
}

export function buildCanvasFrameHtml(opts: {
  /** The canvas: the agent's whole HTML document (the stored source). */
  source: string;
  /** Tailwind utilities compiled from the source on save ('' for none). */
  css: string;
  /** The canvas runtime import map JSON ({ imports }). */
  importMapJson: string;
  /** The host page's `<html>` class and data-color-theme at mint time; live
   *  changes arrive as theme messages. */
  cls: string;
  colorTheme: string | null;
  /** From the canvas head (parseCanvasHead). */
  size: CanvasSize;
  theme: 'follow' | 'fixed';
  /** `@font-face` rules for Inter and the Appearance library, plus the
   *  owner's font vars (`:root{--font-sans:...}`). */
  fontCss: string;
  /** The frame's proof for its parent (canvasFrameNonce); '' for a render
   *  with no parent. */
  nonce?: string;
}): string {
  const follow = opts.theme !== 'fixed';
  // A fixed canvas wears the light baseline: no dark class, no colour theme.
  const cls = follow ? opts.cls : '';
  const colorTheme = follow ? opts.colorTheme : null;
  const prelude = [
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<script type="importmap">${opts.importMapJson.replace(/<\//g, '<\\/')}</script>`,
    '<link rel="stylesheet" href="/share-runtime/styles.css" />',
    '<link rel="stylesheet" href="/share-runtime/katex/katex.min.css" />',
    `<style>${styleText(opts.fontCss)}</style>`,
    `<style>${styleText(opts.css)}</style>`,
    `<style>${layoutCss(opts.size)}</style>`,
    `<script>${preludeScript({ cls, colorTheme, followTheme: follow, size: opts.size, nonce: opts.nonce ?? '' })}</script>`,
  ].join('\n');
  return `<!doctype html>\n${prelude}\n${stripLeadingDoctype(opts.source)}`;
}
