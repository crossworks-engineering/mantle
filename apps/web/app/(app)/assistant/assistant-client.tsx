'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAssistantDock, type ContextRef, type ContextKind } from '@/components/assistant/assistant-dock';
import { useTurnStage } from '@/components/assistant/use-turn-stage';
import { useTurnStream, type ThoughtEvent } from '@/components/assistant/use-turn-stream';
import { ThoughtTrail } from '@/components/assistant/thought-trail';
import {
  ArrowDown,
  CornerDownLeft,
  FileText,
  Image as ImageIcon,
  Loader2,
  MapPin,
  Mic,
  MicOff,
  Paperclip,
  Send,
  Square,
  SquareDashedMousePointer,
  X,
} from 'lucide-react';
import { formatDateTime } from '@/lib/format-datetime';
import { agentAccent, agentInitials } from '@/lib/agent-color';
import { BoringAvatar } from '@/components/boring-avatar';
import { RichText } from '@/components/assistant/rich-text';
import { CopyButton } from '@/components/assistant/copy-button';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { apiFetch } from '@/lib/api-fetch';
import { assetUrl } from '@/lib/asset-url';

/** A sidecar artifact attached to a message. Mirrors @mantle/tools
 *  ToolArtifact, with the discriminated `kind` driving the rendering
 *  (audio = play button, image = inline preview). Outbound artifacts
 *  come from tool calls; inbound artifacts come from user uploads.
 *
 *  `localPreviewUrl` is purely client-side: when the user picks an
 *  image we render the local file URL immediately for instant
 *  feedback. Once the server round-trips we replace it with the
 *  base64 payload the API returned. */
type Artifact = {
  kind: 'audio' | 'image';
  mimeType: string;
  base64: string;
  caption?: string;
  nodeId?: string;
  producedBy: string;
  localPreviewUrl?: string;
};

/** A persisted media reference on a turn (DB-backed, no bytes), mirroring
 *  @mantle/db ConversationAttachment. Defined locally so this client component
 *  doesn't import @mantle/db (keeps postgres out of the browser bundle). Images
 *  with a nodeId render via the file-bytes route; everything else is a labeled
 *  chip (its content — e.g. a voice transcript — already lives in the text). */
type StoredAttachment = {
  kind: 'image' | 'audio' | 'voice' | 'document' | 'video';
  mime?: string;
  caption?: string;
  nodeId?: string;
  fileId?: string;
  url?: string;
};

/** Page size for the initial load and each scroll-up fetch. */
const PAGE_SIZE = 100;

/** Within this many px of the bottom counts as "stuck" for autoscroll-follow. */
const NEAR_BOTTOM_PX = 24;

type Message = {
  id: string;
  direction: 'inbound' | 'outbound';
  text: string;
  model?: string | null;
  createdAt: string;
  /** Transport this turn came in on. 'web' (or undefined) renders no badge;
   *  'telegram' etc. show a small channel chip so the unified stream makes its
   *  cross-channel origin obvious. */
  channel?: string;
  /** Persisted media on the turn (rendered on load). Distinct from `artifacts`,
   *  which carries live bytes from the just-completed turn (tool output / the
   *  image the user just uploaded). */
  attachments?: StoredAttachment[];
  /** Sidecar artifacts produced by worker tools during this turn.
   *  Only ever populated on outbound messages. */
  artifacts?: Artifact[];
  /** Optimistic flag while we wait for the server reply. */
  pending?: boolean;
  /** Durable execution state (migration 0105). Outbound rows are 'pending' while
   *  the runner works, 'complete' when the reply lands, 'failed' on error — so a
   *  reload mid-turn renders the right state. Undefined on optimistic rows. */
  status?: 'pending' | 'complete' | 'failed';
  /** Failure reason for a 'failed' turn; null/undefined otherwise. */
  error?: string | null;
  /** The grounded status steps streamed during this turn, frozen onto the reply
   *  as a persistent "thought" record. Outbound only; session-scoped (the
   *  durable record is the trace). */
  thoughts?: ThoughtEvent[];
  /** Real output-token total for the turn, from the `done` event — shown on the
   *  frozen thought-trail summary. Session-scoped (not persisted). */
  tokens?: number;
  /** Wall-clock duration of the turn (ms), measured client-side from the live
   *  stream — shown on the frozen thought-trail summary. Session-scoped. */
  durationMs?: number;
};

/** A conversational turn: the user's prompt and Saskia's response. The
 *  document layout pairs them — the response is the reading canvas, the
 *  prompt floats in the right margin, anchored to the response it produced. */
type Turn = { id: string; prompt?: Message; response?: Message };

/** Fold the flat message stream into prompt→response turns. A new turn
 *  starts on each inbound; the next outbound attaches to it. Leading or
 *  orphan outbounds get their own promptless turn (rare). */
function groupTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of messages) {
    if (m.direction === 'inbound') {
      turns.push({ id: m.id, prompt: m });
    } else {
      const last = turns[turns.length - 1];
      if (last && last.prompt && !last.response) last.response = m;
      else turns.push({ id: m.id, response: m });
    }
  }
  return turns;
}

/** Human-readable noun per context kind — used in chips and the preamble. */
const CONTEXT_KIND_LABEL: Record<ContextKind, string> = {
  file: 'file',
  folder: 'folder',
  page: 'page',
  note: 'note',
  table: 'table',
  journal: 'journal entry',
  task: 'task',
  event: 'event',
  app: 'app',
};

/** Render marked nodes as a reference block appended to the sent message. The
 *  agent reads them via its tools (file_read / note_get / page_get / …) — node
 *  ids are enough; we never inline content here. */
function buildContextPreamble(refs: ContextRef[]): string {
  const lines = refs.map(
    (r) => `- ${CONTEXT_KIND_LABEL[r.kind]} "${r.label}" (node ${r.id})`,
  );
  return `\n\n---\nAttached context (read these with your tools as needed):\n${lines.join('\n')}`;
}

export function AssistantClient({
  initialMessages,
  agentReady,
  agentSlug,
  agentName,
  agentAvatar,
}: {
  initialMessages: Message[];
  agentReady: boolean;
  /** Which agent the selector targets; sent with each turn. */
  agentSlug?: string;
  /** Display name of the active agent — drives the bubble avatar + greeting. */
  agentName?: string;
  /** Avatar {style, seed} for the active agent; falls back to initials. */
  agentAvatar?: { style: string; seed: string } | null;
}) {
  // Per-agent visual identity: a stable colour + monogram so it's obvious
  // which agent you're talking to when you switch.
  const accent = agentAccent(agentSlug ?? 'assistant');
  const initials = agentInitials(agentName ?? 'Assistant');
  // Turns run through the app-wide dock provider, so a long turn keeps going
  // (and stays visible in the floating dock) when you navigate away mid-answer.
  const {
    runTurn,
    busy: dockBusy,
    agentSlug: dockAgentSlug,
    panel,
    pendingContext,
    pinnedContext,
    extraDirective,
    removeContext,
    clearContext,
    startPicking,
  } = useAssistantDock();
  // Everything that rides this turn as context: the screen-pinned node (the open
  // page/table/app) PLUS any pick-mode chips, deduped. Pinned nodes survive a
  // send (they stay attached while you're on the screen); pick-mode chips clear.
  const allContext = useMemo(() => {
    const seen = new Set(pinnedContext.map((r) => r.id));
    return [...pinnedContext, ...pendingContext.filter((r) => !seen.has(r.id))];
  }, [pinnedContext, pendingContext]);
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  // True from the moment the user hits Stop until the turn settles — so the Stop
  // button reflects "stopping…" and can't be double-fired.
  const [stopping, setStopping] = useState(false);
  // Live "what's the agent doing" label. The stream (keyed on the in-flight
  // turn's id) pushes status the instant each step starts; the poll is the
  // fallback while streaming is off or before the socket connects. Stream wins.
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const {
    label: streamLabel,
    trail: streamTrail,
    reply: streamReply,
    reasoning: streamReasoning,
    phase: streamPhase,
    outboundId: streamOutboundId,
    error: streamError,
    startedAt: streamStartedAt,
    tokens: streamTokens,
    tokensApprox: streamTokensApprox,
  } = useTurnStream(activeTurnId);
  const polledLabel = useTurnStage(sending);
  const stageLabel = streamLabel ?? polledLabel;
  // Live trail display mode (Settings → Profile). Fetched once on mount; the
  // trail renders 'list' (stacking, default) until it loads.
  const [trailMode, setTrailMode] = useState<'list' | 'replace'>('list');
  useEffect(() => {
    void apiFetch<{ preferences?: { thoughtTrailMode?: string } }>('/api/profile')
      .then((d) => {
        if (d.preferences?.thoughtTrailMode === 'replace') setTrailMode('replace');
      })
      .catch(() => {});
  }, []);
  // Mirror the live trail + the durable outbound id into refs so the completion
  // reconciler (which runs async, off the stream's `done`) reads fresh values
  // rather than stale closure captures.
  const trailRef = useRef<ThoughtEvent[]>([]);
  useEffect(() => {
    trailRef.current = streamTrail;
  }, [streamTrail]);
  const outboundIdRef = useRef<string | null>(null);
  useEffect(() => {
    outboundIdRef.current = streamOutboundId;
  }, [streamOutboundId]);
  // Mirror the final token count + the turn's start time so reconcileDone (async,
  // stable callback) can stamp the real "duration · tokens" onto the frozen trail.
  const streamTokensRef = useRef<number | null>(null);
  useEffect(() => {
    streamTokensRef.current = streamTokens;
  }, [streamTokens]);
  const streamStartedAtRef = useRef<number | null>(null);
  useEffect(() => {
    streamStartedAtRef.current = streamStartedAt;
  }, [streamStartedAt]);
  // The in-flight non-blocking turn awaiting reconciliation (set by `submit`
  // when the route returns 202; consumed by the phase effect on done/error).
  // `startedAt` lets the safety poll find the turn's outbound row even if the
  // `turn-start` event (which carries the id) was missed.
  const pendingTurnRef = useRef<{ optimisticId: string; turnId: string; startedAt: string } | null>(null);
  const [error, setError] = useState<string>();
  // ── Voice-in state ──
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordChunksRef = useRef<Blob[]>([]);
  // ── Attachment state ──
  // The user picks one file at a time (image or document). Images get an
  // object-URL preview (revoked on clear/send so we don't leak); documents
  // render as a name/size chip with no preview URL.
  const [attachedFile, setAttachedFile] = useState<File | null>(null);
  const [attachedPreviewUrl, setAttachedPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // The text of the in-flight turn's prompt, so a Stop can drop it back into the
  // composer for correction.
  const lastPromptRef = useRef('');
  // Set when a Stop restores the prompt — focus the composer once it re-enables
  // (the textarea is disabled while `sending`, so we can't focus immediately).
  const focusAfterStopRef = useRef(false);

  // ── Share-location toggle ──
  // Sticky opt-in (persisted): when on, each send attaches a fresh browser
  // geolocation fix to the turn — the same `location` wire contract the companion
  // uses, so the agent gets an origin for "where am I" / routing. Off by default;
  // the browser owns the actual permission prompt. Geolocation needs a secure
  // context (HTTPS/localhost), which prod + dev both satisfy.
  const SHARE_LOCATION_KEY = 'mantle_assistant_share_location';
  const [shareLocation, setShareLocation] = useState(false);
  useEffect(() => {
    try {
      setShareLocation(localStorage.getItem(SHARE_LOCATION_KEY) === '1');
    } catch {
      /* private mode / no storage — default off */
    }
  }, []);

  const scrollerRef = useRef<HTMLDivElement>(null);
  // Wraps the scroller's content; watched by a ResizeObserver so we can re-pin to
  // the bottom as the transcript's height settles after a scroll (see below).
  const contentRef = useRef<HTMLDivElement>(null);

  // ── Stick-to-bottom autoscroll ──
  // Follow new content (a landing reply, streamed tokens, a growing trail) ONLY
  // while the user is parked at the bottom. The moment they scroll up to read, we
  // stop yanking them down and offer a jump-to-bottom button instead. `atBottom`
  // is a ref (the truth read by the scroll effects, no stale closures); `showJump`
  // is state (drives the button). A small threshold so a deliberate scroll-up
  // un-sticks but sub-pixel rounding doesn't.
  const atBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const scrollToBottom = useCallback((smooth: boolean) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);
  const jumpToBottom = useCallback(() => {
    atBottomRef.current = true;
    setShowJump(false);
    scrollToBottom(true);
  }, [scrollToBottom]);

  // ── Scroll-up lazy loading of older messages ──
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(initialMessages.length >= PAGE_SIZE);
  const loadingRef = useRef(false);
  // Captured before a prepend so the layout effect can hold scroll position.
  const pendingPrepend = useRef<{ prevHeight: number; prevTop: number } | null>(null);

  const turns = useMemo(() => groupTurns(messages), [messages]);

  // Scroll management: after a prepend, restore position (no jump); otherwise pin
  // to the bottom ONLY when the user is parked there (initial load + a send force
  // `atBottom` true). A reply that lands while they've scrolled up doesn't yank
  // them — the jump button appears instead.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (pendingPrepend.current) {
      el.scrollTop = el.scrollHeight - pendingPrepend.current.prevHeight + pendingPrepend.current.prevTop;
      pendingPrepend.current = null;
    } else if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    } else {
      setShowJump(true);
    }
  }, [messages, sending]);

  // Follow live streaming content (the reply typing out, the trail growing) while
  // stuck to the bottom. Fires per token/step; a no-op once the user scrolls up.
  useLayoutEffect(() => {
    if (atBottomRef.current) scrollToBottom(false);
    else setShowJump(true);
  }, [streamReply, streamTrail, scrollToBottom]);

  // Re-pin to the bottom when the panel opens. The transcript warms in the
  // background while the overlay is display:none (so it's instant on open) — but
  // a hidden element has no scrollHeight, so the initial-load scroll-to-bottom
  // above ran as a no-op and left the scroller at the top of the lazy-loaded
  // history. Now that the subtree is visible (scrollHeight is real), land on the
  // latest message. Respects a deliberate scroll-up — a minimise→restore keeps
  // your spot — by only jumping when you were parked at the bottom.
  useLayoutEffect(() => {
    if (panel !== 'open') return;
    const el = scrollerRef.current;
    if (!el) return;
    if (atBottomRef.current) el.scrollTop = el.scrollHeight;
    else setShowJump(true);
  }, [panel]);

  // Keep the latest message in view as the transcript's height *settles*. The
  // one-shot scroll-to-bottoms above all fire at a single instant — but the
  // height isn't stable then: reply bodies render through TipTap (which mounts
  // and applies its content asynchronously) and attachment / artifact images
  // carry no fixed dimensions, so each finishes laying out *after* the scroll
  // has already run. That late growth pushes the bottom down and strands the
  // scroller partway up the history — the "half scrolled" symptom, worst on
  // panel-open where everything that warmed under display:none unfolds at once.
  // A ResizeObserver re-pins on every height change, so we ride the content down
  // until it's done growing — but only while the user is parked at the bottom
  // (atBottomRef), so a deliberate scroll-up to read history is never yanked.
  // Setting scrollTop never resizes the observed node, so there's no feedback
  // loop. Lives for the component's life (re-created on the agent-switch remount).
  useEffect(() => {
    const el = scrollerRef.current;
    const content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (atBottomRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  const loadOlder = useCallback(async () => {
    if (loadingRef.current || !hasMore) return;
    const el = scrollerRef.current;
    const oldest = messages[0];
    if (!el || !oldest) return;
    loadingRef.current = true;
    setLoadingOlder(true);
    try {
      const qs = new URLSearchParams({ before: oldest.createdAt, limit: String(PAGE_SIZE) });
      if (agentSlug) qs.set('agent', agentSlug);
      const data = await apiFetch<{ messages: Message[] }>(
        `/api/assistant/messages?${qs.toString()}`,
        { cache: 'no-store' },
      );
      const older = data.messages ?? [];
      if (older.length < PAGE_SIZE) setHasMore(false);
      const have = new Set(messages.map((m) => m.id));
      const fresh = older.filter((m) => !have.has(m.id));
      if (fresh.length > 0) {
        pendingPrepend.current = { prevHeight: el.scrollHeight, prevTop: el.scrollTop };
        setMessages((prev) => [...fresh, ...prev]);
      }
    } catch {
      // network blip — user can scroll up again to retry
    } finally {
      loadingRef.current = false;
      setLoadingOlder(false);
    }
  }, [hasMore, messages, agentSlug]);

  // Pull any newly-persisted messages into the transcript — used when a turn
  // that this page didn't start finishes (e.g. you returned to /assistant while
  // a dock turn was still running). Dedupes by id, so it's a safe no-op when
  // there's nothing new.
  const syncLatest = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (agentSlug) qs.set('agent', agentSlug);
      const data = await apiFetch<{ messages: Message[] }>(
        `/api/assistant/messages?${qs.toString()}`,
        { cache: 'no-store' },
      );
      const latest = data.messages ?? [];
      setMessages((prev) => {
        // Merge by id: ADD rows we don't have, and UPDATE ones whose durable
        // fields changed (a 'pending' row finalizing to 'complete'/'failed' —
        // its text/status/error flip server-side). Client-only fields (live
        // `artifacts`, frozen `thoughts`, the optimistic local preview) are
        // preserved. Returns `prev` unchanged when nothing moved (safe no-op).
        const byId = new Map(prev.map((m) => [m.id, m]));
        let changed = false;
        for (const row of latest) {
          const existing = byId.get(row.id);
          if (!existing) {
            byId.set(row.id, row);
            changed = true;
          } else if (
            existing.text !== row.text ||
            existing.status !== row.status ||
            existing.error !== row.error ||
            existing.model !== row.model
          ) {
            byId.set(row.id, {
              ...existing,
              text: row.text,
              status: row.status,
              error: row.error,
              model: row.model,
              channel: row.channel ?? existing.channel,
              attachments: row.attachments ?? existing.attachments,
            });
            changed = true;
          }
        }
        if (!changed) return prev;
        return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      });
    } catch {
      /* network blip — the next turn or a reload will reconcile */
    }
  }, [agentSlug]);

  // ── Non-blocking turn completion ──
  // The streaming route returns 202 immediately; the live stream then drives the
  // reply, and these reconcile the transcript to the DURABLE row when the turn
  // ends (the streamed buffer was advisory). `done` → pull the canonical rows
  // and freeze the thought trail onto the reply; `error` → surface it. A short
  // safety poll backs them up in case the terminal event is missed (NOTIFY has
  // no backlog, so a reconnect mid-turn could drop it).
  const endActiveTurn = useCallback(() => {
    setSending(false);
    setStopping(false);
    setActiveTurnId(null);
    pendingTurnRef.current = null;
  }, []);

  // Stop the in-flight turn: ask the runner to abort generation. The turn then
  // finalizes with whatever partial reply streamed and fires `done`, so the
  // normal completion path (phase effect / safety poll) reconciles it — no
  // special teardown here. Fire-and-forget; a dropped cancel just means the turn
  // runs a little longer.
  const stopTurn = useCallback(() => {
    const turnId = activeTurnId;
    if (!turnId || stopping) return;
    setStopping(true);
    void apiFetch(`/api/assistant/turn/${turnId}/cancel`, { method: 'POST' }).catch(() => {
      /* the done/poll path still reconciles; nothing to surface */
    });
    // Drop the stopped turn's prompt back into the composer so the user can
    // correct it and resend. Only when the box is empty — if they'd started
    // typing the next message while this one streamed, don't clobber it.
    const prompt = lastPromptRef.current;
    if (prompt) {
      setDraft((cur) => (cur.trim() ? cur : prompt));
      focusAfterStopRef.current = true; // focus once the turn settles + box re-enables
    }
  }, [activeTurnId, stopping]);

  // After a Stop restores the prompt, focus the composer + cursor-to-end the
  // moment the turn settles (the box is disabled while `sending`).
  useEffect(() => {
    if (sending || !focusAfterStopRef.current) return;
    focusAfterStopRef.current = false;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, [sending]);

  const reconcileDone = useCallback(
    async (optimisticId: string) => {
      const trail = trailRef.current;
      const outboundId = outboundIdRef.current;
      const tokens = streamTokensRef.current;
      const startedAt = streamStartedAtRef.current;
      const durationMs = startedAt != null ? Date.now() - startedAt : undefined;
      await syncLatest(); // pulls the canonical inbound + (now 'complete') outbound
      setMessages((prev) => {
        // Drop the optimistic user bubble (the canonical inbound is now present),
        // and freeze the live thought trail (+ its duration / token total) onto
        // the durable outbound row.
        let next = prev.filter((m) => m.id !== optimisticId);
        if (outboundId && trail.length) {
          next = next.map((m) =>
            m.id === outboundId && !m.thoughts
              ? {
                  ...m,
                  thoughts: [...trail],
                  ...(tokens != null && tokens > 0 ? { tokens } : {}),
                  ...(durationMs != null ? { durationMs } : {}),
                }
              : m,
          );
        }
        return next;
      });
      endActiveTurn();
    },
    [syncLatest, endActiveTurn],
  );

  const failActiveTurn = useCallback(
    (optimisticId: string, message: string) => {
      setError(message);
      setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
      endActiveTurn();
    },
    [endActiveTurn],
  );

  // React to the live terminal events for the in-flight non-blocking turn.
  useEffect(() => {
    const pending = pendingTurnRef.current;
    if (!pending) return;
    if (streamPhase === 'done') {
      void reconcileDone(pending.optimisticId);
    } else if (streamPhase === 'error') {
      failActiveTurn(pending.optimisticId, streamError ?? 'The turn failed.');
    }
  }, [streamPhase, streamError, reconcileDone, failActiveTurn]);

  // Safety net: if no terminal event arrives (a dropped reconnect), poll the
  // durable rows. Once the in-flight turn's outbound row reports a terminal
  // status, reconcile the same way the stream would have. Only runs while a
  // non-blocking turn is in flight; stops the moment it settles.
  useEffect(() => {
    if (!sending || !pendingTurnRef.current) return;
    let stopped = false;
    const tick = async () => {
      const pending = pendingTurnRef.current;
      if (stopped || !pending) return;
      try {
        const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
        if (agentSlug) qs.set('agent', agentSlug);
        const data = await apiFetch<{ messages: Message[] }>(
          `/api/assistant/messages?${qs.toString()}`,
          { cache: 'no-store' },
        );
        const outboundId = outboundIdRef.current;
        const rows = data.messages ?? [];
        // Prefer the exact row id (from turn-start); fall back to the newest
        // outbound row created at/after this turn started, so a missed
        // turn-start can't leave the turn hung.
        const row = outboundId
          ? rows.find((m) => m.id === outboundId && m.direction === 'outbound')
          : rows
              .filter((m) => m.direction === 'outbound' && m.createdAt >= pending.startedAt)
              .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
              .pop();
        if (stopped || !pendingTurnRef.current) return;
        if (row?.status === 'complete') void reconcileDone(pending.optimisticId);
        else if (row?.status === 'failed') failActiveTurn(pending.optimisticId, row.error ?? 'The turn failed.');
      } catch {
        /* transient — try again next tick */
      }
    };
    // First poll after a grace period (the stream usually wins), then every 3s.
    const t = setInterval(tick, 3000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [sending, agentSlug, reconcileDone, failActiveTurn]);

  // A turn for THIS agent is running that this page didn't start (you navigated
  // back mid-flight, or it's a dock reply). Drives a "working" indicator, and
  // when it finishes we pull the reply in so the transcript updates without a
  // manual reload.
  const foreignBusy = dockBusy && !sending && dockAgentSlug === agentSlug;
  const prevForeignRef = useRef(false);
  useEffect(() => {
    if (prevForeignRef.current && !foreignBusy) void syncLatest();
    prevForeignRef.current = foreignBusy;
  }, [foreignBusy, syncLatest]);

  // On (re)mount — including an agent switch, which re-keys this component —
  // pull the latest persisted messages, so a reply that landed while you were
  // away shows up even if the router served this view from cache.
  useEffect(() => {
    void syncLatest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
    atBottomRef.current = nearBottom;
    setShowJump(!nearBottom);
    if (el.scrollTop < 120) void loadOlder();
  }, [loadOlder]);

  const clearAttachment = () => {
    if (attachedPreviewUrl) URL.revokeObjectURL(attachedPreviewUrl);
    setAttachedFile(null);
    setAttachedPreviewUrl(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const onFilePicked = (file: File | null) => {
    if (attachedPreviewUrl) URL.revokeObjectURL(attachedPreviewUrl);
    setAttachedFile(file);
    // Only images get an inline object-URL preview; documents show a chip.
    setAttachedPreviewUrl(
      file && file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
    );
  };

  // Read one browser geolocation fix and map it onto the `location` wire shape
  // (LocationPing) the turn route already sanitises. Resolves undefined on any
  // failure (denied / unavailable / timeout) so a turn never blocks on it.
  const getBrowserLocation = useCallback((): Promise<Record<string, unknown> | undefined> => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const c = pos.coords;
          resolve({
            latitude: c.latitude,
            longitude: c.longitude,
            accuracy: c.accuracy,
            altitude: c.altitude,
            altitudeAccuracy: c.altitudeAccuracy,
            heading: c.heading,
            speed: c.speed,
            source: 'network', // browser geolocation — never GPS-grade; skill caveats accuracy
            timestamp: new Date(pos.timestamp).toISOString(),
          });
        },
        () => resolve(undefined),
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 60_000 },
      );
    });
  }, []);

  // Toggle the sticky opt-in. Turning it ON triggers the browser permission
  // prompt up-front so denial surfaces now rather than silently at send time.
  const toggleShareLocation = useCallback(async () => {
    if (shareLocation) {
      setShareLocation(false);
      try { localStorage.setItem(SHARE_LOCATION_KEY, '0'); } catch { /* no storage */ }
      return;
    }
    const fix = await getBrowserLocation();
    if (!fix) {
      setError('Could not get your location — allow location access for this site, then try again.');
      return;
    }
    setShareLocation(true);
    try { localStorage.setItem(SHARE_LOCATION_KEY, '1'); } catch { /* no storage */ }
  }, [shareLocation, getBrowserLocation]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    // Allow attachment-only submits — the API route fills in a default
    // prompt server-side when text is empty.
    if ((!text && !attachedFile) || sending) return;
    setError(undefined);
    // Remember this turn's prompt so a Stop can drop it back into the composer.
    lastPromptRef.current = text;

    // Context — the screen-pinned node + any picked nodes ride along as a
    // reference preamble appended to the SENT text (the bubble still shows what
    // was typed). The agent reads them with its tools (file_read / page_get / …).
    // A surface focus directive (Pages marks, the Apps inspect region) follows,
    // so the specialist narrows the same way the old in-screen panels did.
    const sentText =
      text +
      (allContext.length ? buildContextPreamble(allContext) : '') +
      (extraDirective ? `\n\n${extraDirective}` : '');

    const hasFile = attachedFile != null;
    const isImage = hasFile && attachedFile.type.startsWith('image/');
    // Idempotency key for this submit — lets the server replay (not re-run)
    // the turn if the request is retried, so we never get duplicate file
    // nodes / turns.
    const idempotencyKey = crypto.randomUUID();
    const optimisticId = `pending-${Date.now()}`;
    const optimistic: Message = {
      id: optimisticId,
      direction: 'inbound',
      text: text || (hasFile ? `📎 ${attachedFile.name}` : ''),
      createdAt: new Date().toISOString(),
      // Show the local image preview immediately so the user sees what
      // they sent without waiting for the round-trip. Documents have no
      // inline preview — their name rides in the text above.
      ...(isImage && attachedPreviewUrl
        ? {
            artifacts: [
              {
                kind: 'image' as const,
                mimeType: attachedFile.type,
                base64: '', // optimistic — use the local object URL
                caption: attachedFile.name,
                producedBy: 'assistant-upload',
                localPreviewUrl: attachedPreviewUrl,
              },
            ],
          }
        : {}),
      pending: true,
    };
    // A send always re-sticks to the bottom — the user wants to watch their own
    // message + the reply, even if they'd scrolled up to read history.
    atBottomRef.current = true;
    setShowJump(false);
    setMessages((prev) => [...prev, optimistic]);
    setDraft('');
    // Open the live status stream for this turn (same uuid the server keys it
    // on) the instant we start — before the POST — so we catch the early steps.
    setActiveTurnId(idempotencyKey);
    setSending(true);

    try {
      // Build the body, then run the turn through the app-wide dock provider so
      // the fetch lives in the persistent shell (survives navigation) and drives
      // the floating mini-chat. Multipart for uploads (streams raw, no base64
      // bloat); JSON for text-only.
      // Best-effort fresh location fix when sharing is on — rides on the turn as
      // the `location` field (JSON) or form field (multipart), same as mobile.
      const location = shareLocation ? await getBrowserLocation() : undefined;
      let body: FormData | string;
      let isJson: boolean;
      if (hasFile) {
        const formData = new FormData();
        if (sentText) formData.set('text', sentText);
        if (agentSlug) formData.set('agentSlug', agentSlug);
        formData.set(isImage ? 'image' : 'file', attachedFile);
        if (location) formData.set('location', JSON.stringify(location));
        body = formData;
        isJson = false;
      } else {
        body = JSON.stringify({ text: sentText, agentSlug, ...(location ? { location } : {}) });
        isJson = true;
      }
      type BlockingTurn = {
        inbound: { id: string; text: string; createdAt: string; artifacts?: Artifact[] };
        outbound: { id: string; text: string; model: string | null; createdAt: string };
        artifacts?: Artifact[];
        warnings?: string[];
      };
      type NonBlockingTurn = { turnId: string; warnings?: string[] };
      const data = (await runTurn({
        agentSlug,
        agentName: agentName ?? 'Assistant',
        idempotencyKey,
        displayText: optimistic.text,
        body,
        isJson,
      })) as BlockingTurn | NonBlockingTurn;

      // The send was accepted — clear the composer attachment either way. Reset
      // WITHOUT revoking the object URL: it now backs the sent bubble's preview
      // (revoking would blank it); it's released on the next page load.
      setAttachedFile(null);
      setAttachedPreviewUrl(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      // The marked context went out with this turn — clear the chips.
      clearContext();

      if ('outbound' in data) {
        // BLOCKING result (streaming off): the full reply is already here — swap
        // the optimistic rows for the durable ones now and end the turn.
        setMessages((prev) => [
          ...prev.filter((m) => m.id !== optimisticId),
          {
            id: data.inbound.id,
            direction: 'inbound',
            text: data.inbound.text,
            createdAt: data.inbound.createdAt,
            // Keep the optimistic artifacts (local object-URL preview) — the
            // server no longer echoes the image base64 back, so the browser
            // renders from the bytes it already has.
            artifacts: optimistic.artifacts ?? data.inbound.artifacts ?? [],
          },
          {
            id: data.outbound.id,
            direction: 'outbound',
            text: data.outbound.text,
            model: data.outbound.model,
            createdAt: data.outbound.createdAt,
            status: 'complete',
            artifacts: data.artifacts ?? [],
            // Freeze the live status trail onto the reply as a persistent record.
            ...(trailRef.current.length ? { thoughts: [...trailRef.current] } : {}),
          },
        ]);
        if (data.warnings?.length) setError(data.warnings.join(' · '));
        setSending(false);
        setActiveTurnId(null);
      } else {
        // NON-BLOCKING (202): the live stream now types the reply out; the phase
        // effect (and the safety poll) reconcile to the durable row on
        // done/error. Hand them the turn — keep the optimistic bubble + spinner.
        pendingTurnRef.current = {
          optimisticId,
          turnId: idempotencyKey,
          startedAt: optimistic.createdAt,
        };
        if (data.warnings?.length) setError(data.warnings.join(' · '));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      // Drop the optimistic row on error so the user can retry without dupes.
      setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
      setSending(false);
      setStopping(false);
      setActiveTurnId(null);
      pendingTurnRef.current = null;
    }
  };

  // ── Mic recording ──
  const startRecording = async () => {
    setError(undefined);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Browsers vary in what they accept. webm/opus is the most
      // portable target; Safari may fall back to mp4/aac which the
      // STT adapters also accept.
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : '';
      const mr = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recordChunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) recordChunksRef.current.push(e.data);
      };
      mr.onstop = () => {
        // Close the mic immediately so the browser tab indicator
        // clears the moment recording stops.
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(recordChunksRef.current, { type: mr.mimeType });
        void transcribeBlob(blob);
      };
      mediaRecorderRef.current = mr;
      mr.start();
      setRecording(true);
    } catch (err) {
      setError(
        err instanceof Error
          ? `Couldn't access microphone: ${err.message}`
          : 'Microphone access denied',
      );
    }
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    setRecording(false);
  };

  const transcribeBlob = async (blob: Blob) => {
    setTranscribing(true);
    try {
      const formData = new FormData();
      // The filename hint is consumed by some STT adapters
      // (Whisper sniffs the extension); .webm matches what
      // MediaRecorder emits in most browsers.
      formData.set('audio', blob, 'recording.webm');
      // FormData body: apiFetch (NOT apiSend) so the multipart boundary survives;
      // it still carries the base-URL + bearer and bounces on an auth failure.
      const data = await apiFetch<{ text: string }>('/api/assistant/transcribe', {
        method: 'POST',
        body: formData,
      });
      // Drop the transcript into the input. The user reviews +
      // sends — auto-sending would punish mishearings (and
      // MediaRecorder webm is finicky enough that we want a
      // human-in-the-loop verification step before paying for an
      // LLM round-trip).
      setDraft((prev) => (prev ? `${prev} ${data.text}` : data.text));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTranscribing(false);
    }
  };

  const lastTurnId = turns[turns.length - 1]?.id;

  return (
    <>
      <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scrollerRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-6 py-6">
        {/* Height-tracking wrapper: the ResizeObserver above watches this node so
            late content growth (TipTap reply bodies, images loading in) re-pins
            the scroll to the bottom instead of stranding it mid-thread. */}
        <div ref={contentRef}>
        {turns.length === 0 ? (
          <div className="mx-auto flex max-w-3xl flex-col items-center gap-3 rounded-md border border-dashed border-border bg-muted/30 px-4 py-10 text-center">
            {agentAvatar ? (
              <BoringAvatar
                variant={agentAvatar.style}
                seed={agentAvatar.seed}
                size={48}
                className="ring-2"
                style={{ '--tw-ring-color': accent.border } as React.CSSProperties}
              />
            ) : (
              <span
                className="flex h-12 w-12 items-center justify-center rounded-full text-base font-semibold text-white ring-2"
                style={{ backgroundColor: accent.solid, '--tw-ring-color': accent.border } as React.CSSProperties}
                aria-hidden
              >
                {initials}
              </span>
            )}
            <p className="text-sm text-muted-foreground">
              No messages yet. Say hi to{' '}
              <span className="font-medium text-foreground">{agentName ?? 'your assistant'}</span>.
            </p>
          </div>
        ) : (
          <>
            {loadingOlder && (
              <div className="flex justify-center py-2">
                <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
              </div>
            )}
            {!hasMore && (
              <p className="py-2 text-center text-xs text-muted-foreground">
                Beginning of the conversation
              </p>
            )}
            <ul className="mx-auto flex max-w-5xl flex-col">
              {turns.map((turn, idx) => {
                const isLast = turn.id === lastTurnId;
                const showTyping = isLast && sending && !turn.response;
                return (
                  <li
                    key={turn.id}
                    className={
                      'group/turn grid gap-x-10 gap-y-3 pb-10 lg:grid-cols-[minmax(0,1fr)_300px]' +
                      // A thin divider between turns, in the agent's accent
                      // colour (the accent moved here from the old left border).
                      (idx > 0 ? ' border-t pt-10' : '')
                    }
                    style={
                      idx > 0
                        ? { borderTopColor: `color-mix(in oklab, ${accent.border} 20%, transparent)` }
                        : undefined
                    }
                  >
                    {/* RIGHT MARGIN (DOM-first so it stacks above the
                        response on mobile): the user's prompt, anchored
                        beside the response it produced. */}
                    <div className="lg:col-start-2 lg:row-start-1">
                      {turn.prompt && (
                        <PromptCard message={turn.prompt} />
                      )}
                    </div>

                    {/* MAIN CANVAS: Saskia's reply as a rich document. */}
                    <div className="min-w-0 lg:col-start-1 lg:row-start-1">
                      {turn.response ? (
                        turn.response.status === 'failed' ? (
                          // Durable failed turn (reloaded after an error).
                          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                            <span>{turn.response.error || 'This turn failed.'}</span>
                          </div>
                        ) : turn.response.status === 'pending' ? (
                          // Durable pending turn (reloaded mid-flight) — the runner
                          // is still working; show a thinking bubble.
                          <div
                            className="inline-flex items-center gap-2 rounded-2xl px-3.5 py-3"
                            style={{ backgroundColor: accent.soft }}
                          >
                            <span className="flex items-center gap-1" aria-hidden>
                              <span className="size-1.5 animate-bounce rounded-full bg-current opacity-60 [animation-delay:-0.3s]" />
                              <span className="size-1.5 animate-bounce rounded-full bg-current opacity-60 [animation-delay:-0.15s]" />
                              <span className="size-1.5 animate-bounce rounded-full bg-current opacity-60" />
                            </span>
                            <span className="text-xs text-current opacity-70">
                              {agentName ?? 'Assistant'} is working…
                            </span>
                          </div>
                        ) : (
                        <article>
                          <div className="mb-2 flex items-center gap-2">
                            <span className="text-sm font-medium text-muted-foreground">
                              {agentName ?? 'Assistant'}
                            </span>
                            <ChannelBadge channel={turn.response.channel} />
                          </div>
                          {turn.response.thoughts && turn.response.thoughts.length > 0 && (
                            <ThoughtTrail
                              steps={turn.response.thoughts}
                              tokens={turn.response.tokens ?? null}
                              durationMs={turn.response.durationMs ?? null}
                              timestamp={turn.response.createdAt}
                              className="mb-3 max-w-xl"
                            />
                          )}
                          <div>
                            <RichText markdown={turn.response.text} />
                            {turn.response.attachments && turn.response.attachments.length > 0 && (
                              <div className="mt-3 flex flex-col gap-2">
                                {turn.response.attachments.map((a, i) => (
                                  <StoredAttachmentView key={`${turn.id}-att-${i}`} attachment={a} />
                                ))}
                              </div>
                            )}
                            {turn.response.artifacts && turn.response.artifacts.length > 0 && (
                              <div className="mt-3 flex flex-col gap-2">
                                {turn.response.artifacts.map((a, i) => (
                                  <ArtifactView key={`${turn.id}-art-${i}`} artifact={a} />
                                ))}
                              </div>
                            )}
                            <div className="mt-1.5 flex items-center justify-between gap-2 pointer-events-none opacity-0 transition-opacity group-hover/turn:pointer-events-auto group-hover/turn:opacity-100">
                              <div className="flex items-baseline gap-2 text-[10px] text-muted-foreground">
                                <span title={formatDateTime(turn.response.createdAt)}>
                                  {new Date(turn.response.createdAt).toLocaleTimeString()}
                                </span>
                                {turn.response.model && (
                                  <code className="font-mono">{turn.response.model}</code>
                                )}
                              </div>
                              <CopyButton text={turn.response.text} />
                            </div>
                          </div>
                        </article>
                        )
                      ) : showTyping ? (
                        // Once status events arrive, the typing dots give way to
                        // the live thought trail building in place, and — when
                        // token streaming is on — the reply itself typing out
                        // below it. Before any of that (or on the poll fallback)
                        // keep the classic dots. The streamed reply is advisory:
                        // when the durable turn.response lands above, this whole
                        // branch is replaced by the authoritative <article>.
                        streamTrail.length > 0 || streamReply ? (
                          <div className="max-w-xl">
                            <span className="sr-only">
                              {agentName ?? 'Assistant'} is {stageLabel ?? 'typing'}
                            </span>
                            {streamTrail.length > 0 && (
              <ThoughtTrail
                steps={streamTrail}
                live
                mode={trailMode}
                startedAt={streamStartedAt}
                tokens={streamTokens}
                tokensApprox={streamTokensApprox}
                reasoning={streamReasoning}
              />
            )}
                            {streamReply && (
                              // Live buffer: a lightweight ReactMarkdown render, NOT the
                              // TipTap RichText editor — the editor's setContent() runs
                              // flushSync and collides with React mid-render when the buffer
                              // changes every token. The durable reply below swaps in RichText.
                              <div
                                className={`prose dark:prose-invert max-w-none [&>:first-child]:mt-0 [&>:last-child]:mb-0 ${
                                  streamTrail.length > 0 ? 'mt-3' : ''
                                }`}
                              >
                                <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamReply}</ReactMarkdown>
                              </div>
                            )}
                          </div>
                        ) : (
                          <div
                            className="inline-flex items-center gap-2 rounded-2xl px-3.5 py-3"
                            style={{ backgroundColor: accent.soft }}
                          >
                            <span className="sr-only">
                              {agentName ?? 'Assistant'} is {stageLabel ?? 'typing'}
                            </span>
                            <span className="flex items-center gap-1" aria-hidden>
                              <span className="size-1.5 animate-bounce rounded-full bg-current opacity-60 [animation-delay:-0.3s]" />
                              <span className="size-1.5 animate-bounce rounded-full bg-current opacity-60 [animation-delay:-0.15s]" />
                              <span className="size-1.5 animate-bounce rounded-full bg-current opacity-60" />
                            </span>
                            {stageLabel && (
                              <span className="text-xs text-current opacity-70" aria-hidden>
                                {stageLabel}
                              </span>
                            )}
                          </div>
                        )
                      ) : null}
                    </div>
                  </li>
                );
              })}
              {foreignBusy && (
                <li className="flex items-center gap-2 px-1 py-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  {agentName ?? 'Assistant'} is working… (started elsewhere)
                </li>
              )}
            </ul>
          </>
        )}
        </div>
      </div>
        {showJump && (
          <button
            type="button"
            onClick={jumpToBottom}
            aria-label="Jump to latest"
            className="absolute bottom-4 left-1/2 z-10 flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-md transition hover:bg-accent hover:text-accent-foreground"
          >
            <ArrowDown className="size-4" aria-hidden />
          </button>
        )}
      </div>

      <form
        onSubmit={submit}
        className="border-t border-border bg-background px-6 py-3"
      >
        {/* The composer spans the full conversation width (max-w-5xl) — the same
            box the turns occupy above (response column + prompt margin) — rather
            than only the response column. */}
        <div className="mx-auto max-w-5xl">
          <div className="space-y-2">
            {/* Attachment preview — shown above the input row so the
                user sees what they're about to send. Persists across
                keystrokes and clears on send/dismiss. */}
            {attachedFile && (
              <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-2 py-1.5">
                {attachedPreviewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={attachedPreviewUrl}
                    alt={attachedFile.name}
                    className="h-12 w-12 rounded object-cover"
                  />
                ) : (
                  <div className="flex h-12 w-12 items-center justify-center rounded bg-background/60 text-muted-foreground">
                    <FileText className="h-6 w-6" />
                  </div>
                )}
                <div className="flex-1 text-xs">
                  <div className="font-medium">{attachedFile.name}</div>
                  <div className="text-muted-foreground">
                    {attachedFile.type || 'file'} · {(attachedFile.size / 1024).toFixed(0)} KB
                  </div>
                </div>
                <button
                  type="button"
                  onClick={clearAttachment}
                  className="rounded p-1 text-muted-foreground hover:bg-background/60"
                  title="Remove attachment"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
            {/* Context chips. The screen-pinned node (the open page/table/app)
                shows first with a pin glyph and no remove — it's managed by the
                screen and rides every turn. Pick-mode chips follow and clear
                after a send. */}
            {allContext.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {allContext.map((c) => {
                  const pinned = pinnedContext.some((r) => r.id === c.id);
                  return (
                    <span
                      key={c.id}
                      className={
                        'inline-flex max-w-[16rem] items-center gap-1.5 rounded-md border py-1 pl-2 text-xs ' +
                        (pinned
                          ? 'border-primary/40 bg-primary/10 pr-2 text-foreground'
                          : 'border-border bg-muted/40 pr-1')
                      }
                      title={pinned ? 'On this screen — sent with every message' : undefined}
                    >
                      {pinned ? (
                        <MapPin className="size-3.5 shrink-0 text-primary" aria-hidden />
                      ) : (
                        <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      )}
                      <span className="truncate font-medium">{c.label}</span>
                      {!pinned && (
                        <button
                          type="button"
                          onClick={() => removeContext(c.id)}
                          className="rounded p-0.5 text-muted-foreground hover:bg-background/60 hover:text-foreground"
                          title="Remove"
                          aria-label={`Remove ${c.label}`}
                        >
                          <X className="size-3" aria-hidden />
                        </button>
                      )}
                    </span>
                  );
                })}
              </div>
            )}
            <div className="flex gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,.pdf,.docx,.xlsx,.xls,.csv,.txt,.md,.json,.yaml,.yml"
                className="hidden"
                onChange={(e) => onFilePicked(e.target.files?.[0] ?? null)}
              />
              <div className="flex flex-col gap-1">
                {/* Attach picker — images + documents. Triggers the hidden
                    file input. Disabled when something's already attached
                    (clear it first via the preview's X). */}
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!agentReady || sending || !!attachedFile}
                  className="rounded-md border border-input bg-background p-2 text-muted-foreground hover:bg-muted disabled:opacity-40"
                  title="Attach image or document"
                >
                  <Paperclip className="h-4 w-4" />
                </button>
                {/* Marker — enter pick mode (minimises the chat) to attach
                    files, pages, notes… as context for the next turn. */}
                <button
                  type="button"
                  onClick={startPicking}
                  disabled={!agentReady || sending}
                  className="rounded-md border border-input bg-background p-2 text-muted-foreground hover:bg-muted disabled:opacity-40"
                  title="Pick content to attach (files, pages, notes…)"
                >
                  <SquareDashedMousePointer className="h-4 w-4" />
                </button>
                {/* Share-location toggle — sticky opt-in. When on, each send
                    attaches a fresh browser geolocation fix so the assistant
                    knows where you are (directions, "what's nearby"). */}
                <button
                  type="button"
                  onClick={() => void toggleShareLocation()}
                  disabled={!agentReady || sending}
                  aria-pressed={shareLocation}
                  className={
                    shareLocation
                      ? 'rounded-md bg-primary p-2 text-primary-foreground hover:bg-primary/90 disabled:opacity-40'
                      : 'rounded-md border border-input bg-background p-2 text-muted-foreground hover:bg-muted disabled:opacity-40'
                  }
                  title={shareLocation ? 'Sharing your location with the assistant — click to stop' : 'Share your location with the assistant'}
                >
                  <MapPin className="h-4 w-4" />
                </button>
                {/* Mic toggle — push-to-talk style. Recording state
                    shows a red destructive button; transcribing shows
                    a spinner. */}
                {recording ? (
                  <button
                    type="button"
                    onClick={stopRecording}
                    className="rounded-md bg-destructive p-2 text-destructive-foreground hover:opacity-90"
                    title="Stop recording"
                  >
                    <MicOff className="h-4 w-4" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={startRecording}
                    disabled={!agentReady || sending || transcribing}
                    className="rounded-md border border-input bg-background p-2 text-muted-foreground hover:bg-muted disabled:opacity-40"
                    title={transcribing ? 'Transcribing…' : 'Record voice note'}
                  >
                    {transcribing ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Mic className="h-4 w-4" />
                    )}
                  </button>
                )}
              </div>
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={
                  !agentReady
                    ? 'Configure an assistant or responder agent first at /settings/agents.'
                    : attachedFile
                    ? 'Add a question about the attachment (optional) — Enter to send.'
                    : recording
                    ? 'Recording… press the stop button to transcribe.'
                    : transcribing
                    ? 'Transcribing your recording…'
                    : 'Message your assistant — Enter to send, Shift+Enter for newline.'
                }
                disabled={!agentReady || sending}
                rows={2}
                className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void submit(e);
                  }
                }}
              />
              {sending ? (
                // Mid-turn the send button becomes a Stop button — one click aborts
                // generation and keeps whatever partial reply has streamed.
                <button
                  type="button"
                  onClick={stopTurn}
                  aria-label="Stop"
                  title="Stop generating"
                  disabled={!activeTurnId || stopping}
                  className="flex w-12 shrink-0 items-center justify-center self-stretch rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-40"
                >
                  {stopping ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  ) : (
                    <Square className="size-3.5 fill-current" aria-hidden />
                  )}
                </button>
              ) : (
                <button
                  type="submit"
                  aria-label="Send"
                  title="Send (Enter)"
                  disabled={!agentReady || (!draft.trim() && !attachedFile)}
                  className="flex w-12 shrink-0 items-center justify-center self-stretch rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
                >
                  <CornerDownLeft className="size-4" aria-hidden />
                </button>
              )}
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        </div>
      </form>
    </>
  );
}

/**
 * The user's prompt, rendered as a margin note beside the response it
 * produced. Quiet by design — muted card, small type — so Saskia's
 * document is the visual centre of gravity.
 */
function PromptCard({ message }: { message: Message }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-sm lg:sticky lg:top-2">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="flex items-center gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            You
          </span>
          <ChannelBadge channel={message.channel} />
        </span>
        <span
          className="text-[10px] text-muted-foreground"
          title={formatDateTime(message.createdAt)}
        >
          {new Date(message.createdAt).toLocaleTimeString()}
        </span>
      </div>
      {message.text && (
        <p className="whitespace-pre-wrap break-words text-foreground">{message.text}</p>
      )}
      {message.attachments && message.attachments.length > 0 && (
        <div className="mt-2 flex flex-col gap-2">
          {message.attachments.map((a, i) => (
            <StoredAttachmentView key={`${message.id}-att-${i}`} attachment={a} />
          ))}
        </div>
      )}
      {message.artifacts && message.artifacts.length > 0 && (
        <div className="mt-2 flex flex-col gap-2">
          {message.artifacts.map((a, i) => (
            <ArtifactView key={`${message.id}-art-${i}`} artifact={a} />
          ))}
        </div>
      )}
      {message.pending && (
        <div className="mt-1 text-[10px] italic text-muted-foreground">sending…</div>
      )}
    </div>
  );
}

/**
 * Render one tool-emitted artifact inline. Audio gets an <audio
 * controls> element; images get a bounded preview with a click-to-
 * enlarge affordance. Both use a `data:` URL — no separate fetch.
 */
function ArtifactView({ artifact }: { artifact: Artifact }) {
  // localPreviewUrl wins when set — it's an object URL pointing at
  // the in-memory blob and renders instantly. Falls through to the
  // base64 data URL once the server returns the real bytes.
  const dataUrl =
    artifact.localPreviewUrl ?? `data:${artifact.mimeType};base64,${artifact.base64}`;
  if (artifact.kind === 'audio') {
    return (
      <div className="rounded-lg border border-border bg-background/60 p-2">
        {/* controls renders the play button + scrubber + duration in
            the browser's native styling. Sufficient for our use case;
            a custom waveform UI would be nice-to-have but adds weight. */}
        <audio controls src={dataUrl} className="w-full" preload="metadata">
          Your browser doesn&apos;t support the audio element.
        </audio>
        {artifact.caption && (
          <p className="mt-1 text-[11px] italic text-muted-foreground">
            🔊 {artifact.caption}
          </p>
        )}
      </div>
    );
  }
  // image
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-background/60">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={dataUrl}
        alt={artifact.caption ?? 'Generated image'}
        className="max-h-96 w-full cursor-zoom-in object-contain"
        onClick={() => {
          // Open full-size in a new tab so the user can zoom + save.
          // window.open is cheap; a modal lightbox would be nicer
          // but doesn't justify the dep right now.
          const w = window.open();
          if (w) {
            w.document.write(
              `<title>${(artifact.caption ?? 'image').replace(/[<>]/g, '')}</title>` +
                `<img src="${dataUrl}" style="max-width:100%;display:block;margin:0 auto;" />`,
            );
          }
        }}
      />
      {artifact.caption && (
        <p className="px-2 py-1 text-[11px] italic text-muted-foreground">
          🎨 {artifact.caption}
        </p>
      )}
    </div>
  );
}

/** Small chip marking which channel a turn came in on. Nothing for native web
 *  turns; a labeled glyph for Telegram / WhatsApp / future surfaces, so the
 *  unified stream makes its cross-channel origin obvious at a glance. */
function ChannelBadge({ channel }: { channel?: string }) {
  if (!channel || channel === 'web') return null;
  const label =
    channel === 'telegram' ? 'Telegram' : channel === 'whatsapp' ? 'WhatsApp' : channel;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
      <Send className="size-2.5" aria-hidden />
      {label}
    </span>
  );
}

/** Render a persisted attachment (DB-backed, no inline bytes). Images with a
 *  file nodeId render inline via the file-bytes route; everything else (voice
 *  notes, docs, backfilled images without a node, video) is a labeled chip —
 *  its actual content (e.g. a voice transcript) already lives in the turn text. */
function StoredAttachmentView({ attachment }: { attachment: StoredAttachment }) {
  if (attachment.kind === 'image' && attachment.nodeId) {
    const src = assetUrl(`/api/files/files/${attachment.nodeId}?raw=1`);
    return (
      <div className="overflow-hidden rounded-lg border border-border bg-background/60">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={attachment.caption ?? 'image'}
          className="max-h-96 w-full cursor-zoom-in object-contain"
          onClick={() => window.open(src, '_blank')}
        />
        {attachment.caption && (
          <p className="px-2 py-1 text-[11px] italic text-muted-foreground">{attachment.caption}</p>
        )}
      </div>
    );
  }
  const Icon =
    attachment.kind === 'voice' || attachment.kind === 'audio'
      ? Mic
      : attachment.kind === 'image'
        ? ImageIcon
        : FileText;
  const label =
    attachment.caption ??
    (attachment.kind === 'voice'
      ? 'Voice note'
      : attachment.kind.charAt(0).toUpperCase() + attachment.kind.slice(1));
  return (
    <span className="inline-flex w-fit items-center gap-1.5 rounded-md border border-border bg-muted/30 px-2 py-1 text-xs text-muted-foreground">
      <Icon className="size-3.5" aria-hidden />
      {label}
    </span>
  );
}
