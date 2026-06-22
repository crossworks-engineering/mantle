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

function buildSrcDoc(bundleCode: string): string {
  const html = document.documentElement;
  const cls = html.className || '';
  const colorTheme = html.dataset.colorTheme ? ` data-color-theme="${html.dataset.colorTheme}"` : '';
  const css = captureHostCss();
  // CSP: the app may only render — no network of its own (connect-src 'none');
  // its bridge is postMessage to the parent. Inline style + script are ours.
  const csp =
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
    "img-src * data: blob:; font-src * data:; connect-src 'none'; base-uri 'none'; form-action 'none'";
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
</body>
</html>`;
}

export function AppSandbox({
  appId,
  reloadKey = 0,
  onError,
}: {
  appId: string;
  /** Bump to force a re-fetch + re-render (e.g. after a build/publish). */
  reloadKey?: number;
  onError?: (message: string) => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [height, setHeight] = useState(320);

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
          reply(await r.json());
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
    [appId],
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
      // A request needing a response.
      void handleRequest(m);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [handleRequest, onError]);

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
