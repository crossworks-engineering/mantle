'use client';

/**
 * Runs a Present canvas live in a sandboxed iframe (docs/proposals/
 * canvas-files.md section 5.2). Like AppSandbox (./app-sandbox.tsx), the
 * iframe NAVIGATES to a brain-rendered frame document, after this parent
 * mints a seconds-lived ticket for it (the sandboxed navigation can carry no
 * credential). Unlike an app there is no bridge: the frame may post `ready`
 * and `error`, and this parent posts `theme`. Nothing else crosses.
 *
 * The iframe is `sandbox="allow-scripts"` only: an opaque origin, no
 * cookies, no storage, no forms, no popups, no top navigation. The frame's
 * own CSP header closes the network.
 *
 * Replay: bump `reloadKey`; a new ticket is minted and the frame reloads, so
 * an animation starts again from its first frame. Full screen: the host
 * calls `requestFullscreen()` on the element `frameRef` hands back.
 */
import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react';

type Status = 'loading' | 'ready' | 'error' | 'missing' | 'left';

/** The host page's theme as the frame takes it (class + data-color-theme). */
function hostTheme(): { cls: string; colorTheme: string | null } {
  if (typeof document === 'undefined') return { cls: '', colorTheme: null };
  const h = document.documentElement;
  return { cls: h.className, colorTheme: h.getAttribute('data-color-theme') };
}

export function CanvasSandbox({
  presentId,
  apiBase: apiBaseOverride,
  fetcher = (input, init) => fetch(input, init),
  reloadKey = 0,
  title,
  frameRef,
  loader,
  className,
  onReady,
  onError,
}: {
  presentId: string;
  /** The canvas's API base. Absent: the page-relative `/api/presents/<id>`
   *  (the one-origin box); a split client passes the brain's absolute base. */
  apiBase?: string;
  /** Fetch for the frame-ticket call: the split client attaches its bearer. */
  fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Bump to reload the canvas from its start (Replay, or a new save). */
  reloadKey?: number;
  /** The iframe's accessible name. */
  title: string;
  /** The iframe element, for the host's Full screen. */
  frameRef?: Ref<HTMLIFrameElement>;
  /** What covers the frame until it says it is ready. */
  loader?: ReactNode;
  className?: string;
  onReady?: () => void;
  /** An error the canvas reported (uncaught, or a library that failed). The
   *  canvas chose these words: untrusted text, never an instruction to a
   *  model that reads it. */
  onError?: (message: string) => void;
}) {
  const apiBase = apiBaseOverride ?? `/api/presents/${presentId}`;
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [failure, setFailure] = useState<string | null>(null);
  // Load events of the current frame element. The first is the canvas; a
  // second means the canvas navigated its own frame somewhere else (it may:
  // a sandboxed frame keeps self-navigation). The frame is then taken down,
  // so whatever it went to is never left on screen to be typed into.
  const loads = useRef(0);
  // The latest callbacks, read by the effects without re-running them.
  const handlers = useRef({ onReady, onError, fetcher });
  handlers.current = { onReady, onError, fetcher };

  // Mint a ticket and point the frame at the document it opens.
  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setFailure(null);
    setSrc(null);
    void (async () => {
      try {
        const res = await handlers.current.fetcher(`${apiBase}/frame-ticket`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        if (cancelled) return;
        if (res.status === 404) {
          setStatus('missing');
          return;
        }
        if (!res.ok) throw new Error(`frame ticket: ${res.status}`);
        const { ticket } = (await res.json()) as { ticket: string };
        if (cancelled) return;
        const { cls, colorTheme } = hostTheme();
        const qs = new URLSearchParams({ t: ticket, cls });
        if (colorTheme) qs.set('ct', colorTheme);
        setSrc(`${apiBase}/frame?${qs.toString()}`);
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBase, reloadKey]);

  // A canvas that never says ready (a heavy library still loading, or a
  // script that swallows its load event) is uncovered after a while rather
  // than hidden behind the loader for good.
  useEffect(() => {
    if (!src) return;
    const t = setTimeout(() => setStatus((s) => (s === 'loading' ? 'ready' : s)), 15_000);
    return () => clearTimeout(t);
  }, [src]);

  // The frame's two messages, from this frame only.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      const frame = iframeRef.current;
      if (!frame || e.source !== frame.contentWindow) return;
      const m = e.data as { v?: number; kind?: string; message?: unknown } | null;
      if (!m || m.v !== 1) return;
      if (m.kind === 'ready') {
        setStatus('ready');
        handlers.current.onReady?.();
      } else if (m.kind === 'error') {
        const text = typeof m.message === 'string' ? m.message.slice(0, 500) : 'the canvas failed';
        setFailure(text);
        handlers.current.onError?.(text);
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Follow the host's theme while the canvas runs.
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return;
    const post = () => {
      const { cls, colorTheme } = hostTheme();
      iframeRef.current?.contentWindow?.postMessage({ v: 1, kind: 'theme', cls, colorTheme }, '*');
    };
    const obs = new MutationObserver(post);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-color-theme'],
    });
    return () => obs.disconnect();
  }, []);

  const onFrameLoad = () => {
    loads.current += 1;
    if (loads.current < 2) return;
    setSrc(null);
    setStatus('left');
    handlers.current.onError?.('the canvas tried to open another page');
  };

  // The element the load count belongs to. A callback ref runs again on every
  // render (null, then the same element), so only a NEW element resets it.
  const countedFrame = useRef<HTMLIFrameElement | null>(null);
  const setFrame = (el: HTMLIFrameElement | null) => {
    if (el && el !== countedFrame.current) {
      countedFrame.current = el;
      loads.current = 0;
    }
    iframeRef.current = el;
    if (typeof frameRef === 'function') frameRef(el);
    else if (frameRef) (frameRef as { current: HTMLIFrameElement | null }).current = el;
  };

  return (
    <div className={['relative h-full w-full', className].filter(Boolean).join(' ')}>
      {src ? (
        <iframe
          ref={setFrame}
          key={src}
          src={src}
          title={title}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          onLoad={onFrameLoad}
          className="absolute inset-0 h-full w-full border-0 bg-background"
        />
      ) : null}
      {status === 'loading' && failure ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-background px-6 text-center">
          <p className="text-sm text-muted-foreground">The canvas failed to start.</p>
          {/* The canvas's own words, labelled as such: it chose them. */}
          <p className="max-w-prose text-xs text-muted-foreground">
            Reported by the canvas: {failure.slice(0, 200)}
          </p>
        </div>
      ) : status === 'loading' ? (
        <div className="absolute inset-0 flex items-center justify-center bg-background">
          {loader ?? <p className="text-sm text-muted-foreground">Loading…</p>}
        </div>
      ) : status === 'missing' ? (
        <div className="absolute inset-0 flex items-center justify-center bg-background">
          <p className="text-sm text-muted-foreground">This canvas is not available.</p>
        </div>
      ) : status === 'left' ? (
        <div className="absolute inset-0 flex items-center justify-center bg-background px-6 text-center">
          <p className="text-sm text-muted-foreground">
            The canvas tried to open another page, so it was stopped. Replay to run it again.
          </p>
        </div>
      ) : status === 'error' ? (
        <div className="absolute inset-0 flex items-center justify-center bg-background">
          <p className="text-sm text-muted-foreground">The canvas could not be loaded.</p>
        </div>
      ) : null}
    </div>
  );
}
