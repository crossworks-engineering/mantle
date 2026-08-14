'use client';

/**
 * Runs a built mini app inside a sandboxed iframe. The iframe NAVIGATES to a
 * server-rendered frame document (`${apiBase}/frame`) instead of receiving an
 * inlined srcdoc — a real `src` navigation cannot be dropped the way a late
 * `.srcdoc` assignment could, the sandbox CSP rides a response header, and the
 * document is curl-able (see app-frame-html.ts, which builds it).
 *
 * The navigation itself can carry no credential (the sandboxed iframe has an
 * opaque origin ⇒ no cookies; an iframe src can't attach a bearer), so this
 * parent — which CAN authenticate — first mints a seconds-lived signed ticket
 * from `${apiBase}/frame-ticket` and passes it in the frame URL (`?t=`).
 *
 * The iframe stays sandbox="allow-scripts" (NO allow-same-origin) — it can't
 * read host cookies/DOM/storage. Its only channel is postMessage to this
 * parent, which brokers tool + sqlite calls server-side.
 *
 * Theme parity: the active theme attrs (class + data-color-theme) ride the
 * frame URL and are baked into the document's <html>; later host theme
 * changes are pushed into the running app via the postMessage theme sync.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  isFromApp,
  isHubNavTarget,
  type BridgeReq,
  type HubData,
  type HubNavTarget,
} from './app-bridge-protocol';

type Status = 'loading' | 'ready' | 'nobuild' | 'error';

export function AppSandbox({
  appId,
  shareToken,
  frame = 'card',
  reloadKey = 0,
  onError,
  inspect = false,
  selectedRegionId = null,
  onSelect,
  onInspectChange,
  hub,
  apiBase: apiBaseOverride,
  fetcher,
  onLoadFailure,
}: {
  appId: string;
  /** When set, render in share mode: the bundle + tool/db brokers are
   *  fetched from /s/<token>/* (share-authed, published build only) instead of
   *  the session-authed /api/apps/<id>/* routes. */
  shareToken?: string;
  /** How the app is framed.
   *  'card'     — legacy inline embed: the iframe auto-sizes to the app's
   *               content inside a bordered card (list previews).
   *  'viewport' — the iframe fills its parent (give the parent a real height,
   *               e.g. h-dvh or flex-1 min-h-0); the app owns its internal
   *               layout + scrolling, and viewport-height utilities are real. */
  frame?: 'card' | 'viewport';
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
  /** Team-hub host API — passed ONLY by the /team shell. `getData` answers the
   *  app's `hub.get` locally from the payload the shell already fetched (no new
   *  server surface); `onNav` handles the app's validated `hub.nav` intents
   *  (open chat / open a briefing — the SHELL owns those views). When absent,
   *  `hub.get` is rejected and `hub.nav` ignored, so a hub app rendered on any
   *  other surface degrades to its local preview. */
  hub?: {
    getData: () => HubData;
    onNav: (target: HubNavTarget) => void;
  };
  /** Absolute API base override — the split client's hub passes the SERVER
   *  origin's /s/<token> here so the parent-page broker fetches cross origins.
   *  Absent ⇒ the same-origin derivation below (unchanged). */
  apiBase?: string;
  /** Fetch used for the bundle/tool-broker/db-broker calls ONLY — the split
   *  client injects a bearer-attaching wrapper (a cross-origin broker call
   *  can't ride a cookie). Defaults to plain fetch. */
  fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
  /** The bundle could not be fetched/rendered (missing build or load error).
   *  The /team shell uses this to fall back to the built-in hub instead of
   *  showing members a broken slot. */
  onLoadFailure?: () => void;
}) {
  // Public share mode swaps the session-authed API base for the token-authed
  // public one; the route suffixes (bundle / tool-broker / db-broker) match.
  // An explicit apiBase (the split client's cross-origin hub) wins outright.
  const apiBase = apiBaseOverride ?? (shareToken ? `/s/${shareToken}` : `/api/apps/${appId}`);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [height, setHeight] = useState(320);
  // The frame URL (ticket included), held in state so the iframe is RENDERED
  // with its src (keyed per attempt) — the element is created carrying the
  // navigation, which cannot be dropped the way a late srcdoc write could.
  const [frameSrc, setFrameSrc] = useState<{ url: string; gen: number } | null>(null);
  const genRef = useRef(0);
  // Watchdog retry counter: bumping it re-runs the ticket effect (a fresh
  // ticket AND a fresh iframe — the old ticket may have expired by then).
  const [attempt, setAttempt] = useState(0);
  // One automatic retry before giving up (see the ready watchdog below).
  const retriedRef = useRef(false);
  // Whether THIS bundle load ever reached ready — distinguishes a boot crash
  // (error before ready ⇒ load failure) from a runtime error after boot.
  const everReadyRef = useRef(false);

  const postToFrame = useCallback((msg: unknown) => {
    iframeRef.current?.contentWindow?.postMessage(msg, '*');
  }, []);

  // Hold the callbacks in refs so effects can call the latest without listing
  // them as deps. Parents pass inline closures (e.g. onError={(m)=>toast(m)})
  // that change identity every render — without this, typing in the Assist box
  // re-ran the bundle-fetch effect below and reloaded the iframe (white flash).
  // `fetcher` rides along for the same reason (the split hub passes an inline
  // bearer-attaching wrapper); the default stays a plain window-bound fetch.
  const cbRef = useRef({ onError, onSelect, onInspectChange, hub, onLoadFailure });
  cbRef.current = { onError, onSelect, onInspectChange, hub, onLoadFailure };
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const doFetch = useCallback(
    (input: string, init?: RequestInit) =>
      fetcherRef.current ? fetcherRef.current(input, init) : fetch(input, init),
    [],
  );

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
  // a reload — the frame document only baked in the theme as of mint. Sync once
  // on ready (covers a change between mint and mount), then on every host change.
  useEffect(() => {
    if (status !== 'ready') return;
    const send = () => {
      const h = document.documentElement;
      postToFrame({
        v: 1,
        kind: 'theme',
        cls: h.className || '',
        colorTheme: h.dataset.colorTheme ?? null,
      });
    };
    send();
    const obs = new MutationObserver(send);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-color-theme'],
    });
    return () => obs.disconnect();
  }, [status, postToFrame]);

  // Broker a request from the app and post the correlated response back.
  const handleRequest = useCallback(
    async (req: BridgeReq) => {
      const reply = (res: { ok: boolean; output?: unknown; error?: string }) => {
        iframeRef.current?.contentWindow?.postMessage({ v: 1, id: req.id, ...res }, '*');
      };
      try {
        if (req.kind === 'hub.get') {
          // Answered locally — the /team shell already holds the hub payload.
          // No hub prop ⇒ not the /team surface ⇒ reject so the app can render
          // its off-hub preview instead of waiting forever.
          const hubApi = cbRef.current.hub;
          if (hubApi) reply({ ok: true, output: hubApi.getData() });
          else reply({ ok: false, error: 'hub API is only available on the /team surface' });
          return;
        }
        if (req.kind === 'tool.call') {
          const r = await doFetch(`${apiBase}/tool-broker`, {
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
        const r = await doFetch(`${apiBase}/db-broker`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op, sql: req.sql, params: req.params ?? [] }),
        });
        reply(await r.json());
      } catch (err) {
        reply({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
    [apiBase, doFetch],
  );

  // Listen for messages from THIS iframe only.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const m = e.data;
      if (!isFromApp(m)) return;
      if (m.kind === 'ready') {
        setStatus('ready');
        everReadyRef.current = true;
        return;
      }
      if (m.kind === 'resize') {
        // Viewport frames ignore content-height reports — the iframe is sized
        // by its container and the app scrolls itself.
        if (frame !== 'viewport') setHeight(Math.max(80, Math.min(4000, Math.ceil(m.height))));
        return;
      }
      if (m.kind === 'error') {
        cbRef.current.onError?.(m.message);
        // An error BEFORE the app ever became ready is a mount/boot crash (the
        // kit's ErrorBoundary posts it synchronously during the first render,
        // ahead of the ready signal) — a load failure, not a runtime hiccup.
        if (!everReadyRef.current) cbRef.current.onLoadFailure?.();
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
      if (m.kind === 'hub.nav') {
        // Validate before navigating — never act on a malformed message from a
        // (possibly buggy) app bundle. Ignored off the /team surface.
        if (isHubNavTarget(m.target)) cbRef.current.hub?.onNav(m.target);
        return;
      }
      // A request needing a response.
      void handleRequest(m);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [handleRequest, frame]);

  // Ready watchdog: a frame that NAVIGATES fine but never boots (module-level
  // throw, an import-map chunk failing inside the opaque iframe) leaves status
  // on 'loading' forever — the fetch error paths below never see it. Give the
  // app a generous window to post `ready`, then retry once with a fresh
  // ticket + iframe, and if that also times out surface the error state + report
  // a load failure so a hub-surface parent can fall back instead of pinning
  // members on a spinner.
  useEffect(() => {
    if (status !== 'loading' || frameSrc === null) return;
    const t = setTimeout(() => {
      if (!retriedRef.current) {
        retriedRef.current = true;
        setAttempt((a) => a + 1);
        return;
      }
      setStatus('error');
      cbRef.current.onError?.('the app never signalled ready');
      cbRef.current.onLoadFailure?.();
    }, 10_000);
    return () => clearTimeout(t);
  }, [status, frameSrc]);

  // A NEW load target (not a watchdog retry) gets its retry budget back.
  useEffect(() => {
    retriedRef.current = false;
  }, [apiBase, reloadKey, frame]);

  // Mint a frame ticket and point the iframe at the frame route. The ticket
  // request is what authenticates (cookie or the split client's bearer via
  // `fetcher`); the frame navigation itself carries only the signed ticket.
  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setFrameSrc(null);
    everReadyRef.current = false;
    doFetch(`${apiBase}/frame-ticket`, { method: 'POST' })
      .then(async (r) => {
        if (cancelled) return;
        if (r.status === 404) {
          setStatus('nobuild');
          cbRef.current.onLoadFailure?.();
          return;
        }
        if (!r.ok) {
          setStatus('error');
          cbRef.current.onError?.(`app frame ticket failed (${r.status})`);
          cbRef.current.onLoadFailure?.();
          return;
        }
        const { ticket } = (await r.json()) as { ticket: string };
        if (cancelled) return;
        // Theme parity at mint time; live changes ride the postMessage sync.
        const h = document.documentElement;
        const q = new URLSearchParams({ t: ticket });
        if (h.className) q.set('cls', h.className);
        if (h.dataset.colorTheme) q.set('ct', h.dataset.colorTheme);
        if (frame === 'viewport') q.set('vp', '1');
        setFrameSrc({ url: `${apiBase}/frame?${q.toString()}`, gen: ++genRef.current });
      })
      .catch((err) => {
        if (cancelled) return;
        setStatus('error');
        cbRef.current.onError?.(err instanceof Error ? err.message : String(err));
        cbRef.current.onLoadFailure?.();
      });
    return () => {
      cancelled = true;
    };
  }, [apiBase, reloadKey, frame, doFetch, attempt]);

  const isViewport = frame === 'viewport';
  return (
    <div
      className={
        isViewport
          ? 'relative h-full w-full overflow-hidden bg-background'
          : 'relative w-full overflow-hidden rounded-lg border border-border bg-background'
      }
    >
      {status === 'nobuild' && (
        <div
          className={`flex items-center justify-center p-6 text-center text-sm text-muted-foreground ${isViewport ? 'h-full' : 'h-40'}`}
        >
          {isViewport
            ? 'This app isn’t available right now.'
            : 'This app hasn’t been built yet. Ask Appsmith to build it, or run a build from the editor.'}
        </div>
      )}
      {status === 'error' && (
        <div
          className={`flex items-center justify-center p-6 text-center text-sm text-destructive-ink ${isViewport ? 'h-full' : 'h-40'}`}
        >
          {isViewport ? 'Couldn’t load the app.' : 'Couldn’t load the app preview.'}
        </div>
      )}
      {frameSrc !== null && (
        <iframe
          key={frameSrc.gen}
          ref={iframeRef}
          title={isViewport ? 'App' : 'App preview'}
          sandbox="allow-scripts"
          src={frameSrc.url}
          className={
            status === 'ready' ? (isViewport ? 'block h-full w-full' : 'block w-full') : 'hidden'
          }
          style={isViewport ? { border: '0' } : { height, border: '0', width: '100%' }}
        />
      )}
      {status === 'loading' && (
        <div
          className={`flex items-center justify-center p-6 text-sm text-muted-foreground ${isViewport ? 'h-full' : 'h-40'}`}
        >
          {isViewport ? 'Loading…' : 'Loading preview…'}
        </div>
      )}
    </div>
  );
}
