'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Loader2, Sparkles, SquareDashedMousePointer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { apiEventStream, apiUrl, withAuth } from '@/lib/api-fetch';
import type { TurnEvent } from '@mantle/client-types';

/**
 * App-wide assistant provider. The turn fetch runs here (in the persistent
 * shell), so a long turn — research, a big tool loop — keeps going when you
 * navigate away. No beforeunload guard needed: the turn route persists + caches
 * by idempotency-key, so even a reload doesn't lose it.
 *
 * This provider ALSO owns the global panel UI state: the full assistant opens as
 * a content-area overlay (<AssistantPanel/>) on any screen and minimises to a
 * bubble (<AssistantBubble/>), summoned by the bubble or ⌘I.
 */
export type TurnResponse = {
  inbound: { id: string; text: string; createdAt: string; artifacts?: unknown[] };
  outbound: { id: string; text: string; model: string | null; createdAt: string };
  artifacts?: unknown[];
  warnings?: string[];
};

/** What the turn POST resolves to. The legacy blocking route returns the full
 *  {@link TurnResponse}; the non-blocking (streaming) route returns just the
 *  turn id (202) — the reply then arrives over the live stream, and the caller
 *  reconciles to the durable row. The dock drives its own mini-chat off the
 *  stream in that case; the /assistant page reconciles its transcript. */
export type TurnAck = { turnId: string; warnings?: string[] };
export type TurnPostResult = TurnResponse | TurnAck;

export type RunTurnInput = {
  agentSlug?: string;
  agentName: string;
  idempotencyKey: string;
  /** What to show as the user's message in the dock transcript. */
  displayText: string;
  /** Request body — FormData (uploads) or a JSON string (text-only). */
  body: FormData | string;
  isJson: boolean;
};

type DockMsg = { id: string; role: 'user' | 'assistant'; text: string; pending?: boolean; error?: boolean };

/** Panel visibility: `open` = full overlay shown; `min`/`closed` = bubble only
 *  (screen behind is visible + interactive). `min` is "minimised from open",
 *  `closed` is the initial/dismissed state — both render the bubble. */
export type AssistantPanelState = 'closed' | 'open' | 'min';

/** The content surfaces a marker pick can attach as assistant context. Every
 *  one is a graph node addressed by `id`; `kind` only drives the chip icon +
 *  the wording of the reference preamble the agent reads. */
export type ContextKind =
  | 'file'
  | 'folder'
  | 'page'
  | 'note'
  | 'table'
  | 'journal'
  | 'task'
  | 'event'
  | 'app';

/** A turn has settled (succeeded or failed). Surface hooks subscribe to refresh
 *  the open editor when a specialist edited the node they're showing. `nodeId`
 *  is the on-screen node the turn rode with as pinned context (null for a plain
 *  turn), captured at send time so a late completion still resolves correctly. */
export type TurnSettled = { agentSlug?: string; nodeId: string | null; status: 'done' | 'error' };
type TurnSettledListener = (detail: TurnSettled) => void;

/** A node the user marked to send to the assistant as context. */
export type ContextRef = { id: string; kind: ContextKind; label: string };

const MAX_CONTEXT = 10;

type AssistantDockApi = {
  /** Run a turn through the persistent fetch. Resolves with the server result —
   *  the full reply (blocking route) or a turn-id ack (streaming route, where the
   *  reply lands over the live stream) — or throws. Also drives the bubble state. */
  runTurn: (input: RunTurnInput) => Promise<TurnPostResult>;
  // ── transcript mirror (last-N turns; drives the bubble's unread/busy state) ──
  messages: DockMsg[];
  busy: boolean;
  agentSlug?: string;
  agentName: string;
  clear: () => void;
  // ── global panel UI state (consumed by <AssistantPanel/> + <AssistantBubble/>) ──
  panel: AssistantPanelState;
  /** Show the full panel. Optionally switch to a specific agent first. */
  openAssistant: (slug?: string) => void;
  /** Hide the panel to the bubble, keeping the transcript mounted. */
  minimize: () => void;
  /** Dismiss the panel (also to the bubble; distinct state for future use). */
  close: () => void;
  /** open ⇄ min — what the bubble + ⌘I toggle. */
  toggle: () => void;
  /** The agent selected for the panel — source of truth while open (mirrors the
   *  `mantle_assistant_agent` cookie). */
  activeAgentSlug?: string;
  setActiveAgentSlug: (slug?: string) => void;
  /** The effective agent the panel talks to: a screen's route override
   *  (e.g. the Pages/Ledger/Appsmith specialist) wins while you're on that
   *  screen; otherwise your sticky pick. Drives the panel's thread + the agentSlug
   *  sent with each turn. */
  effectiveAgentSlug?: string;
  /** Arm a specialist for the current screen WITHOUT touching the sticky cookie
   *  (pass undefined on leave to revert to the sticky pick). */
  setRouteAgent: (slug?: string) => void;
  // ── surface-pinned context (the open page/table/app rides every turn) ──
  /** A node pinned by the current screen — sent with EVERY turn (survives a send,
   *  unlike pick-mode chips) so the specialist always knows what you're editing. */
  pinnedContext: ContextRef[];
  /** Replace the pinned set (the surface hook owns this; cleared on leave). */
  setPinnedContext: (refs: ContextRef[]) => void;
  /** An extra directive (e.g. Pages focus marks, the Apps inspect region) folded
   *  into the sent text after the context preamble. Null when nothing's focused. */
  extraDirective: string | null;
  setExtraDirective: (directive: string | null) => void;
  /** The on-screen node id the in-flight turn is editing (null when idle or when
   *  no surface node is pinned) — lets a screen lock its editor only while ITS
   *  node is being worked on. */
  activeContextNodeId: string | null;
  /** Subscribe to turn-settled events; returns an unsubscribe. A surface hook
   *  uses this to refresh its editor when a turn that edited its node completes. */
  registerTurnListener: (fn: TurnSettledListener) => () => void;
  // ── marker context-pick (consumed by <PickMode/>, the composer, the bubbles) ──
  /** Nodes marked to ride along with the next turn as context. */
  pendingContext: ContextRef[];
  /** Add a marked node (deduped by id, capped). */
  attachContext: (ref: ContextRef) => void;
  /** Drop one marked node. */
  removeContext: (id: string) => void;
  /** Clear all marked nodes (called after a successful send). */
  clearContext: () => void;
  /** True while in pick mode — the screen behind highlights markable rows. */
  picking: boolean;
  /** Enter pick mode (also minimises an open panel so the screen is navigable). */
  startPicking: () => void;
  /** Leave pick mode. */
  stopPicking: () => void;
  /** picking ⇄ not — what the marker bubble toggles. */
  togglePicking: () => void;
};

const Ctx = createContext<AssistantDockApi | null>(null);
const MAX_DOCK_MSGS = 12;
const AGENT_COOKIE = 'mantle_assistant_agent';
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export function AssistantDockProvider({ children }: { children: React.ReactNode }) {
  const [messages, setMessages] = useState<DockMsg[]>([]);
  const [agentSlug, setAgentSlug] = useState<string | undefined>(undefined);
  const [agentName, setAgentName] = useState('Assistant');
  const agentRef = useRef<string | undefined>(undefined);

  // ── Global panel UI state ──
  const [panel, setPanel] = useState<AssistantPanelState>('closed');
  const [activeAgentSlug, setActiveAgentSlugState] = useState<string | undefined>(undefined);
  // Route-armed specialist (set by the current screen's surface hook; never
  // written to the cookie). When set it overrides the sticky pick for the panel.
  const [routeAgentSlug, setRouteAgentSlug] = useState<string | undefined>(undefined);
  const effectiveAgentSlug = routeAgentSlug ?? activeAgentSlug;

  // ── Marker context-pick state ──
  const [pendingContext, setPendingContext] = useState<ContextRef[]>([]);
  const [picking, setPicking] = useState(false);
  // ── Surface-pinned context + focus directive (owned by the surface hook) ──
  const [pinnedContext, setPinnedContextState] = useState<ContextRef[]>([]);
  const [extraDirective, setExtraDirectiveState] = useState<string | null>(null);
  // The node the in-flight turn rode with as pinned context — set when a turn
  // starts, cleared when it settles. Drives a screen's editor lock.
  const [activeContextNodeId, setActiveContextNodeId] = useState<string | null>(null);
  // Latest pinned set, read synchronously by runTurn to stamp the turn's target
  // node (state would be a stale closure inside the long-lived callback).
  const pinnedContextRef = useRef<ContextRef[]>([]);
  pinnedContextRef.current = pinnedContext;
  // Turn-settled subscribers (surface hooks). A Set so register/unsubscribe is O(1).
  const turnListenersRef = useRef<Set<TurnSettledListener>>(new Set());
  const registerTurnListener = useCallback((fn: TurnSettledListener) => {
    turnListenersRef.current.add(fn);
    return () => {
      turnListenersRef.current.delete(fn);
    };
  }, []);
  const fireTurnSettled = useCallback((detail: TurnSettled) => {
    setActiveContextNodeId(null);
    for (const fn of turnListenersRef.current) {
      try {
        fn(detail);
      } catch {
        /* a listener throwing must not break the others or the turn */
      }
    }
  }, []);

  const setPinnedContext = useCallback((refs: ContextRef[]) => setPinnedContextState(refs), []);
  const setExtraDirective = useCallback((d: string | null) => setExtraDirectiveState(d), []);
  const setRouteAgent = useCallback((slug?: string) => setRouteAgentSlug(slug), []);

  const attachContext = useCallback((ref: ContextRef) => {
    setPendingContext((prev) => {
      if (prev.some((r) => r.id === ref.id)) return prev; // already marked
      if (prev.length >= MAX_CONTEXT) return prev; // cap — silently ignore extras
      return [...prev, ref];
    });
  }, []);
  const removeContext = useCallback(
    (id: string) => setPendingContext((prev) => prev.filter((r) => r.id !== id)),
    [],
  );
  const clearContext = useCallback(() => setPendingContext([]), []);

  const startPicking = useCallback(() => {
    setPicking(true);
    setPanel((p) => (p === 'open' ? 'min' : p)); // free the screen to navigate + click rows
  }, []);
  const stopPicking = useCallback(() => setPicking(false), []);
  const togglePicking = useCallback(() => {
    setPicking((on) => {
      if (!on) setPanel((p) => (p === 'open' ? 'min' : p));
      return !on;
    });
  }, []);

  // Seed the selected agent from the cookie the picker writes, so the panel
  // opens on your last-used agent without a URL param.
  useEffect(() => {
    const m = document.cookie.match(/(?:^|;\s*)mantle_assistant_agent=([^;]+)/);
    if (m?.[1]) setActiveAgentSlugState(decodeURIComponent(m[1]));
  }, []);

  const setActiveAgentSlug = useCallback((slug?: string) => {
    setActiveAgentSlugState(slug);
    // A deliberate pick overrides any screen-armed specialist for the rest of
    // this visit — re-entering the screen re-arms it via the surface hook.
    setRouteAgentSlug(undefined);
    if (slug) {
      document.cookie = `${AGENT_COOKIE}=${encodeURIComponent(slug)}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`;
    }
  }, []);

  const openAssistant = useCallback(
    (slug?: string) => {
      if (slug) setActiveAgentSlug(slug);
      setPicking(false); // opening the full chat ends any in-progress pick
      setPanel('open');
    },
    [setActiveAgentSlug],
  );
  const minimize = useCallback(() => setPanel((p) => (p === 'open' ? 'min' : p)), []);
  const close = useCallback(() => setPanel('closed'), []);
  const toggle = useCallback(() => {
    setPanel((p) => (p === 'open' ? 'min' : 'open'));
    setPicking(false); // showing the chat (or minimising it) ends pick mode
  }, []);

  // Any route change steps an open panel aside so the screen you navigated to is
  // actually visible behind the bubble. This is the single, declarative
  // guarantee — it covers the left nav, the right activity column (journey
  // links), header links, and any future navigation, so no individual call site
  // has to remember to minimise. (In-screen selections that only swap a `?…`
  // query param don't change the pathname — but those can only happen while the
  // panel is already minimised, since an open panel covers the content area, so
  // there's nothing to step aside for.)
  const pathname = usePathname();
  const prevPathRef = useRef(pathname);
  useEffect(() => {
    if (prevPathRef.current === pathname) return; // initial mount, or no real change
    prevPathRef.current = pathname;
    setPanel((p) => (p === 'open' ? 'min' : p));
  }, [pathname]);

  // Drive the floating mini-chat's bot bubble off the live stream (non-blocking
  // route). Types the reply out as text-deltas arrive, then settles on
  // done/error. Fire-and-forget — the provider is mounted app-wide, so the
  // subscription survives navigation and self-terminates when the turn ends.
  const subscribeDockTurn = useCallback((
    turnId: string,
    botId: string,
    target: { agentSlug?: string; nodeId: string | null },
  ) => {
    let replyBuf = '';
    let round = -1;
    let settled = false;
    const stop = apiEventStream(
      `/api/assistant/turn/${turnId}/stream`,
      (raw) => {
        if (settled) return;
        let ev: TurnEvent;
        try {
          ev = JSON.parse(raw) as TurnEvent;
        } catch {
          return;
        }
        if (ev.type === 'text-delta' && typeof ev.data?.text === 'string') {
          const r = typeof ev.round === 'number' ? ev.round : 0;
          if (r > round) {
            round = r;
            replyBuf = ev.data.text;
          } else {
            replyBuf += ev.data.text;
          }
          setMessages((prev) => prev.map((m) => (m.id === botId ? { ...m, text: replyBuf } : m)));
          return;
        }
        if (ev.type === 'done') {
          settled = true;
          stop();
          setMessages((prev) => prev.map((m) => (m.id === botId ? { ...m, pending: false } : m)));
          fireTurnSettled({ agentSlug: target.agentSlug, nodeId: target.nodeId, status: 'done' });
          return;
        }
        if (ev.type === 'error') {
          settled = true;
          stop();
          const message =
            ev.data && typeof ev.data.message === 'string' ? ev.data.message : 'The turn failed.';
          setMessages((prev) =>
            prev.map((m) => (m.id === botId ? { ...m, text: message, pending: false, error: true } : m)),
          );
          fireTurnSettled({ agentSlug: target.agentSlug, nodeId: target.nodeId, status: 'error' });
          return;
        }
      },
      { onError: () => {} },
    );
  }, [fireTurnSettled]);

  const runTurn = useCallback(async (input: RunTurnInput): Promise<TurnPostResult> => {
    const switched = agentRef.current !== input.agentSlug;
    agentRef.current = input.agentSlug;
    setAgentSlug(input.agentSlug);
    setAgentName(input.agentName);

    // The on-screen node this turn rides with (the surface's pinned context, if
    // any). Captured here so a screen can lock its editor while ITS node is being
    // worked on, and so the turn-settled event refreshes the right editor.
    const targetNodeId = pinnedContextRef.current[0]?.id ?? null;
    const target = { agentSlug: input.agentSlug, nodeId: targetNodeId };
    setActiveContextNodeId(targetNodeId);

    const userId = `u-${input.idempotencyKey}`;
    const botId = `a-${input.idempotencyKey}`;
    setMessages((prev) => {
      const base = (switched ? [] : prev).slice(-(MAX_DOCK_MSGS - 2));
      return [
        ...base,
        { id: userId, role: 'user', text: input.displayText },
        { id: botId, role: 'assistant', text: '', pending: true },
      ];
    });

    // A research/deep turn can run for minutes; an intermediary (reverse proxy,
    // gateway, browser) often drops the long-held connection before the server
    // finishes. But the turn route is idempotent and runAssistantTurn NEVER
    // rejects — it always resolves to {200|400|500} and caches by
    // idempotency-key. So a dropped connection means the turn is STILL running,
    // not failed. We re-POST the SAME key, which re-attaches to the in-flight
    // turn (or its cached result) WITHOUT re-running the LLM, and keep the
    // spinner alive. Only a real {400|500} from our route — or exhausting the
    // deadline — ends the turn. (Proxy 502/503/504/52x means the gateway gave
    // up but upstream is alive → re-attach, don't surface it.)
    const headers: Record<string, string> = { 'idempotency-key': input.idempotencyKey };
    if (input.isJson) headers['content-type'] = 'application/json';
    const RETRY_DEADLINE_MS = 6 * 60_000;
    const startedAt = Date.now();
    let attempt = 0;

    try {
      for (;;) {
        attempt += 1;
        let res: Response | null = null;
        try {
          res = await fetch(apiUrl('/api/assistant/turn'), withAuth({ method: 'POST', headers, body: input.body }));
        } catch {
          // Network drop / connection reset mid-turn — the turn is still
          // running server-side; fall through to re-attach by key.
          res = null;
        }

        if (res) {
          if (res.ok) {
            const data = (await res.json()) as TurnPostResult;
            if ('outbound' in data) {
              // Blocking reply (streaming off) — fill it now.
              setMessages((prev) =>
                prev.map((m) => (m.id === botId ? { ...m, text: data.outbound.text, pending: false } : m)),
              );
              fireTurnSettled({ agentSlug: target.agentSlug, nodeId: target.nodeId, status: 'done' });
              return data;
            }
            // Non-blocking (202): the reply lands over the live stream. Keep the
            // bot bubble pending and let the stream type it out + settle it.
            subscribeDockTurn(data.turnId, botId, target);
            return data;
          }
          // Our route only emits 400/500 as real outcomes — surface those. A
          // 5xx from a PROXY (gateway timeout) is not our route; re-attach.
          const proxyTimeout =
            res.status === 502 || res.status === 503 || res.status === 504 ||
            res.status === 522 || res.status === 524;
          if (!proxyTimeout) {
            const b = (await res.json().catch(() => ({}))) as { error?: string };
            throw new Error(b.error ?? `request failed (${res.status})`);
          }
        }

        if (Date.now() - startedAt > RETRY_DEADLINE_MS) {
          throw new Error(
            'Still working — this is taking unusually long. It may finish in the background; reload to check.',
          );
        }
        // Brief backoff, then re-attach to the in-flight turn (no LLM re-run).
        await new Promise((r) => setTimeout(r, Math.min(3000, 1000 * attempt)));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Something went wrong';
      setMessages((prev) =>
        prev.map((m) => (m.id === botId ? { ...m, text: message, pending: false, error: true } : m)),
      );
      fireTurnSettled({ agentSlug: target.agentSlug, nodeId: target.nodeId, status: 'error' });
      throw err;
    }
  }, [subscribeDockTurn, fireTurnSettled]);

  const clear = useCallback(() => setMessages([]), []);

  const busy = useMemo(() => messages.some((m) => m.role === 'assistant' && m.pending), [messages]);

  const api = useMemo<AssistantDockApi>(
    () => ({
      runTurn,
      messages,
      busy,
      agentSlug,
      agentName,
      clear,
      panel,
      openAssistant,
      minimize,
      close,
      toggle,
      activeAgentSlug,
      setActiveAgentSlug,
      effectiveAgentSlug,
      setRouteAgent,
      pendingContext,
      attachContext,
      removeContext,
      clearContext,
      pinnedContext,
      setPinnedContext,
      extraDirective,
      setExtraDirective,
      activeContextNodeId,
      registerTurnListener,
      picking,
      startPicking,
      stopPicking,
      togglePicking,
    }),
    [
      runTurn,
      messages,
      busy,
      agentSlug,
      agentName,
      clear,
      panel,
      openAssistant,
      minimize,
      close,
      toggle,
      activeAgentSlug,
      setActiveAgentSlug,
      effectiveAgentSlug,
      setRouteAgent,
      pendingContext,
      attachContext,
      removeContext,
      clearContext,
      pinnedContext,
      setPinnedContext,
      extraDirective,
      setExtraDirective,
      activeContextNodeId,
      registerTurnListener,
      picking,
      startPicking,
      stopPicking,
      togglePicking,
    ],
  );

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useAssistantDock(): AssistantDockApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAssistantDock must be used inside <AssistantDockProvider>');
  return ctx;
}

/**
 * Persistent assistant bubble. Always present (except while the full panel is
 * open), it summons the panel on click and reflects the engine state: a spinner
 * while a turn runs, an unread dot when a reply lands while the panel is away.
 * Owns the global ⌘I / Ctrl+I shortcut (it stays mounted even when the panel is
 * open, since it only renders null then).
 */
export function AssistantBubble() {
  const { panel, busy, toggle, messages } = useAssistantDock();
  const [seenId, setSeenId] = useState<string | null>(null);

  // Latest settled assistant reply — what an "unread" badge keys off.
  const latestReplyId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m && m.role === 'assistant' && !m.pending) return m.id;
    }
    return null;
  }, [messages]);

  // Opening the panel marks the latest reply seen.
  useEffect(() => {
    if (panel === 'open' && latestReplyId) setSeenId(latestReplyId);
  }, [panel, latestReplyId]);

  // ⌘I / Ctrl+I toggles the panel. Skipped while typing so it never steals a
  // keystroke from an input or the page editor (where ⌘I is italic).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== 'i') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);

  // The open panel owns the screen — no bubble then. Minimise brings it back.
  if (panel === 'open') return null;

  const unread = !busy && latestReplyId != null && latestReplyId !== seenId;

  return (
    <div className="pointer-events-auto self-end">
      <Button
        onClick={toggle}
        size="icon"
        className="relative size-12 rounded-full shadow-lg"
        aria-label="Open assistant (⌘I)"
        title="Assistant (⌘I)"
      >
        {busy ? (
          <Loader2 className="size-5 animate-spin" aria-hidden />
        ) : (
          <Sparkles className="size-5" aria-hidden />
        )}
        {unread && (
          <span
            className="absolute right-1 top-1 size-2.5 rounded-full bg-destructive ring-2 ring-background"
            aria-hidden
          />
        )}
      </Button>
    </div>
  );
}

/**
 * Marker bubble — the "pick context first" entry point, sitting beside the chat
 * bubble. Toggles pick mode (<PickMode/> highlights markable rows on the screen
 * behind); a badge shows how many nodes are marked. Like the chat bubble, it's
 * hidden only while the full panel owns the screen.
 */
export function MarkerBubble() {
  const { panel, picking, togglePicking, pendingContext } = useAssistantDock();
  if (panel === 'open') return null;
  const count = pendingContext.length;

  return (
    <div className="pointer-events-auto self-end">
      <Button
        onClick={togglePicking}
        size="icon"
        variant={picking ? 'default' : 'secondary'}
        className={cn('relative size-12 rounded-full shadow-lg', picking && 'ring-2 ring-ring ring-offset-2 ring-offset-background')}
        aria-pressed={picking}
        aria-label={picking ? 'Stop picking context' : 'Pick content to send to the assistant'}
        title={picking ? 'Picking — click a row to attach (Esc when done)' : 'Mark content to send to the assistant'}
      >
        <SquareDashedMousePointer className="size-5" aria-hidden />
        {count > 0 && (
          <span
            className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full bg-primary text-[10px] font-semibold tabular-nums text-primary-foreground ring-2 ring-background"
            aria-hidden
          >
            {count}
          </span>
        )}
      </Button>
    </div>
  );
}
