'use client';

/**
 * Runs a Present canvas live in a sandboxed iframe (docs/proposals/
 * canvas-files.md section 5.2). Like AppSandbox (./app-sandbox.tsx), the
 * iframe NAVIGATES to a brain-rendered frame document, after this parent
 * mints a seconds-lived ticket for it (the sandboxed navigation can carry no
 * credential). Unlike an app there is no tool or database bridge: the frame
 * may post `ready`, `error` and `data`, and this parent posts `theme` and
 * `data-reply`. Nothing else crosses.
 *
 * Data (DWG phase 7a): a canvas's `mantle.data` calls arrive as `data`
 * messages. This parent takes them only from its own frame (`e.source`)
 * and only once the frame proved itself (`ready` with the nonce), checks
 * every field (./canvas-data-bridge.ts), and forwards each to THIS canvas's
 * API (`apiBase` + `/data`) with its own fetcher: the canvas names no
 * canvas and no login, and never holds a credential. At most
 * CANVAS_DATA_IN_FLIGHT_MAX wait at once. A canvas that never calls it
 * costs no request.
 *
 * The iframe is `sandbox="allow-scripts"` only: an opaque origin, no
 * cookies, no storage, no forms, no popups, no top navigation. The frame's
 * own CSP header closes its network. A sandboxed frame may still navigate
 * ITSELF, so the frame is shown only after it proves it is the document the
 * brain served: its `ready` carries the nonce the ticket came with, which
 * only the frame's prelude holds. A load with no proof, any load after the
 * proof, or no proof within 20 seconds takes the frame down. The iframe also
 * requires its CSP of whatever loads in it (`csp`, Chromium). The request
 * of such a navigation still leaves a browser (no CSP directive stops it,
 * and the Navigation API does not fire for an opaque frame's navigations);
 * the desktop app refuses it before it leaves (will-frame-navigate).
 *
 * Replay: bump `reloadKey`; a new ticket is minted and the frame reloads, so
 * an animation starts again from its first frame. Full screen: the host
 * calls `requestFullscreen()` on the element `frameRef` hands back.
 */
import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { buildCanvasEmbedCsp } from './canvas-frame-html';
import {
  CANVAS_DATA_IN_FLIGHT_MAX,
  canvasDataReply,
  readCanvasDataMessage,
} from './canvas-data-bridge';

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
  onDown,
  onError,
}: {
  presentId: string;
  /** The canvas's API base. Absent: the page-relative `/api/presents/<id>`
   *  (the one-origin box); a split client passes the brain's absolute base. */
  apiBase?: string;
  /** Fetch for the frame-ticket call: the split client attaches its bearer. */
  fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Bump to reload the canvas from its start (Replay, or a new save). */
  reloadKey?: number | string;
  /** The iframe's accessible name. */
  title: string;
  /** The iframe element, for the host's Full screen. */
  frameRef?: Ref<HTMLIFrameElement>;
  /** What covers the frame until it says it is ready. */
  loader?: ReactNode;
  className?: string;
  onReady?: () => void;
  /** The frame is not up (anything onReady said no longer holds): a reload
   *  started, the ticket failed, or the frame was taken down. */
  onDown?: () => void;
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
  // The proof the current frame owes (its ticket's nonce), and whether it
  // gave it. A load before the proof waits a moment for it (the load and
  // the message race); a load after it means the canvas went elsewhere.
  const nonce = useRef<string | null>(null);
  const proven = useRef(false);
  const proofWait = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The latest callbacks, read by the effects without re-running them.
  const handlers = useRef({ onReady, onDown, onError, fetcher });
  handlers.current = { onReady, onDown, onError, fetcher };
  // The frame load each data call belongs to: a reply to an earlier load
  // (a reload, Replay, a take-down) is dropped, never sent to the new one.
  const frameLoad = useRef(0);
  const dataInFlight = useRef(0);
  const apiBaseRef = useRef(apiBase);
  apiBaseRef.current = apiBase;

  // Mint a ticket and point the frame at the document it opens.
  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setFailure(null);
    setSrc(null);
    frameLoad.current += 1;
    handlers.current.onDown?.();
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
        const { ticket, nonce: n } = (await res.json()) as { ticket: string; nonce?: string };
        if (cancelled) return;
        nonce.current = typeof n === 'string' && n ? n : null;
        proven.current = false;
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

  // Take the frame down: whatever it shows now is not the canvas.
  const takeDown = (why: string) => {
    if (proofWait.current) clearTimeout(proofWait.current);
    proofWait.current = null;
    proven.current = false;
    frameLoad.current += 1;
    setSrc(null);
    setStatus('left');
    handlers.current.onDown?.();
    handlers.current.onError?.(why);
  };

  // A frame that never proves itself (a page the canvas navigated to that
  // never finishes loading, or a canvas whose script blocks its load) is
  // taken down, never uncovered.
  useEffect(() => {
    if (!src) return;
    const t = setTimeout(() => {
      if (!proven.current) takeDown('the canvas did not start');
    }, 20_000);
    return () => clearTimeout(t);
  }, [src]);

  // The frame's two messages, from this frame only.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      const frame = iframeRef.current;
      if (!frame || e.source !== frame.contentWindow) return;
      const m = e.data as { v?: number; kind?: string; message?: unknown; n?: unknown } | null;
      if (!m || m.v !== 1) return;
      if (m.kind === 'ready') {
        // Only the document the brain served knows the nonce.
        if (!nonce.current || m.n !== nonce.current || proven.current) return;
        proven.current = true;
        if (proofWait.current) clearTimeout(proofWait.current);
        proofWait.current = null;
        setStatus('ready');
        handlers.current.onReady?.();
      } else if (m.kind === 'error') {
        const text = typeof m.message === 'string' ? m.message.slice(0, 500) : 'the canvas failed';
        setFailure(text);
        handlers.current.onError?.(text);
      } else if (m.kind === 'data') {
        // Only the proven document: before the proof, the frame may be a
        // page the canvas navigated to.
        if (!proven.current) return;
        void forwardData(frame, m);
      }
    }

    /** One `mantle.data` call, checked, forwarded and answered. */
    async function forwardData(frame: HTMLIFrameElement, raw: unknown) {
      const load = frameLoad.current;
      const answer = (id: number | null, reply: Record<string, unknown>) => {
        if (id === null || load !== frameLoad.current || !proven.current) return;
        frame.contentWindow?.postMessage({ v: 1, kind: 'data-reply', id, ...reply }, '*');
      };
      const read = readCanvasDataMessage(raw);
      if (!read.ok) {
        answer(read.rejection.id, { ok: false, error: read.rejection.error });
        return;
      }
      const { req } = read;
      if (dataInFlight.current >= CANVAS_DATA_IN_FLIGHT_MAX) {
        answer(req.id, { ok: false, error: 'too many calls at once: wait for the ones sent' });
        return;
      }
      dataInFlight.current += 1;
      try {
        const res = await handlers.current.fetcher(`${apiBaseRef.current}${req.path}`, {
          method: req.method,
          ...(req.body !== undefined
            ? { headers: { 'content-type': 'application/json' }, body: req.body }
            : {}),
        });
        const body: unknown = await res.json().catch(() => null);
        answer(req.id, canvasDataReply(req.op, res.status, body));
      } catch {
        answer(req.id, { ok: false, error: 'the canvas data store could not be reached' });
      } finally {
        dataInFlight.current -= 1;
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
    // After the proof, any load is another page.
    if (proven.current) {
      takeDown('the canvas tried to open another page');
      return;
    }
    // Before it, the proof may still be on its way: give it a moment.
    if (proofWait.current) return;
    proofWait.current = setTimeout(() => {
      proofWait.current = null;
      if (!proven.current) takeDown('the canvas tried to open another page');
    }, 1_500);
  };

  useEffect(
    () => () => {
      if (proofWait.current) clearTimeout(proofWait.current);
    },
    [],
  );

  // The origin of the canvas API, for the CSP the iframe requires.
  const apiOrigin =
    typeof window === 'undefined' ? '' : new URL(apiBase, window.location.href).origin;

  const setFrame = (el: HTMLIFrameElement | null) => {
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
          {...{ csp: buildCanvasEmbedCsp(apiOrigin) }}
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
