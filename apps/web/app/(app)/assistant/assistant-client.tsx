'use client';

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  CornerDownLeft,
  FileText,
  Loader2,
  Mic,
  MicOff,
  Paperclip,
  X,
} from 'lucide-react';
import { formatDateTime } from '@/lib/format-datetime';
import { agentAccent, agentInitials } from '@/lib/agent-color';
import { BoringAvatar } from '@/components/boring-avatar';
import { RichText } from '@/components/assistant/rich-text';

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

/** Page size for the initial load and each scroll-up fetch. */
const PAGE_SIZE = 100;

type Message = {
  id: string;
  direction: 'inbound' | 'outbound';
  text: string;
  model?: string | null;
  createdAt: string;
  /** Sidecar artifacts produced by worker tools during this turn.
   *  Only ever populated on outbound messages. */
  artifacts?: Artifact[];
  /** Optimistic flag while we wait for the server reply. */
  pending?: boolean;
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
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
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

  const scrollerRef = useRef<HTMLDivElement>(null);

  // ── Scroll-up lazy loading of older messages ──
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(initialMessages.length >= PAGE_SIZE);
  const loadingRef = useRef(false);
  // Captured before a prepend so the layout effect can hold scroll position.
  const pendingPrepend = useRef<{ prevHeight: number; prevTop: number } | null>(null);

  const turns = useMemo(() => groupTurns(messages), [messages]);

  // Scroll management: after a prepend, restore position (no jump);
  // otherwise pin to the bottom (initial load + new send/reply).
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (pendingPrepend.current) {
      el.scrollTop = el.scrollHeight - pendingPrepend.current.prevHeight + pendingPrepend.current.prevTop;
      pendingPrepend.current = null;
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, sending]);

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
      const res = await fetch(`/api/assistant/messages?${qs.toString()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as { messages: Message[] };
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

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (el && el.scrollTop < 120) void loadOlder();
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

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    // Allow attachment-only submits — the API route fills in a default
    // prompt server-side when text is empty.
    if ((!text && !attachedFile) || sending) return;
    setError(undefined);

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
    setMessages((prev) => [...prev, optimistic]);
    setDraft('');
    setSending(true);

    try {
      let res: Response;
      if (hasFile) {
        // Multipart for uploads — base64-ing a 2MB file into JSON wastes
        // 33% of the bytes plus the parse cost. FormData streams it raw.
        // Images go under 'image' (vision); documents under 'file'.
        const formData = new FormData();
        if (text) formData.set('text', text);
        if (agentSlug) formData.set('agentSlug', agentSlug);
        formData.set(isImage ? 'image' : 'file', attachedFile);
        res = await fetch('/api/assistant/turn', {
          method: 'POST',
          headers: { 'idempotency-key': idempotencyKey },
          body: formData,
        });
      } else {
        res = await fetch('/api/assistant/turn', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
          body: JSON.stringify({ text, agentSlug }),
        });
      }
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? `request failed (${res.status})`);
      }
      const data = (await res.json()) as {
        inbound: { id: string; text: string; createdAt: string; artifacts?: Artifact[] };
        outbound: { id: string; text: string; model: string | null; createdAt: string };
        artifacts?: Artifact[];
        warnings?: string[];
      };
      setMessages((prev) => [
        ...prev.filter((m) => m.id !== optimisticId),
        {
          id: data.inbound.id,
          direction: 'inbound',
          text: data.inbound.text,
          createdAt: data.inbound.createdAt,
          // Keep the optimistic artifacts (local object-URL preview) — the
          // server no longer echoes the image base64 back, so the browser
          // renders from the bytes it already has. Falls back to the server
          // metadata if there was no local preview.
          artifacts: optimistic.artifacts ?? data.inbound.artifacts ?? [],
        },
        {
          id: data.outbound.id,
          direction: 'outbound',
          text: data.outbound.text,
          model: data.outbound.model,
          createdAt: data.outbound.createdAt,
          artifacts: data.artifacts ?? [],
        },
      ]);
      if (data.warnings?.length) {
        // Soft-fail warnings (e.g. vision worker missing) get
        // surfaced as a non-blocking notice rather than a red error.
        setError(data.warnings.join(' · '));
      }
      // Reset the input WITHOUT revoking the object URL — it now backs the
      // sent message's preview (revoking would blank it). It's released when
      // the page reloads; image sends are infrequent enough that the
      // retained URL is negligible.
      setAttachedFile(null);
      setAttachedPreviewUrl(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      // Drop the optimistic row on error so the user can retry without dupes.
      setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
    } finally {
      setSending(false);
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
      const res = await fetch('/api/assistant/transcribe', {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? `request failed (${res.status})`);
      }
      const data = (await res.json()) as { text: string };
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
      <div ref={scrollerRef} onScroll={onScroll} className="flex-1 overflow-y-auto scrollbar-thin px-6 py-6">
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
                    style={idx > 0 ? { borderTopColor: accent.border } : undefined}
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
                        <article>
                          <div className="mb-2 flex items-center gap-2">
                            {agentAvatar ? (
                              <BoringAvatar
                                variant={agentAvatar.style}
                                seed={agentAvatar.seed}
                                size={22}
                                className="size-[22px]"
                              />
                            ) : (
                              <span
                                className="flex size-[22px] shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
                                style={{ backgroundColor: accent.solid }}
                                aria-hidden
                              >
                                {initials}
                              </span>
                            )}
                            <span className="text-xs font-medium text-muted-foreground">
                              {agentName ?? 'Assistant'}
                            </span>
                          </div>
                          <div>
                            <RichText markdown={turn.response.text} />
                            {turn.response.artifacts && turn.response.artifacts.length > 0 && (
                              <div className="mt-3 flex flex-col gap-2">
                                {turn.response.artifacts.map((a, i) => (
                                  <ArtifactView key={`${turn.id}-art-${i}`} artifact={a} />
                                ))}
                              </div>
                            )}
                            <div className="mt-1.5 flex items-baseline gap-2 text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover/turn:opacity-100">
                              <span title={formatDateTime(turn.response.createdAt)}>
                                {new Date(turn.response.createdAt).toLocaleTimeString()}
                              </span>
                              {turn.response.model && (
                                <code className="font-mono">{turn.response.model}</code>
                              )}
                            </div>
                          </div>
                        </article>
                      ) : showTyping ? (
                        <div
                          className="inline-flex rounded-2xl px-3.5 py-3"
                          style={{ backgroundColor: accent.soft }}
                        >
                          <span className="sr-only">{agentName ?? 'Assistant'} is typing…</span>
                          <span className="flex items-center gap-1" aria-hidden>
                            <span className="size-1.5 animate-bounce rounded-full bg-current opacity-60 [animation-delay:-0.3s]" />
                            <span className="size-1.5 animate-bounce rounded-full bg-current opacity-60 [animation-delay:-0.15s]" />
                            <span className="size-1.5 animate-bounce rounded-full bg-current opacity-60" />
                          </span>
                        </div>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>

      <form
        onSubmit={submit}
        className="border-t border-border bg-background px-6 py-3"
      >
        {/* The composer docks to the right on wide screens — it's the
            user's side of the conversation, mirroring where their prompts
            land in the margin. Full-width on mobile. */}
        <div className="mx-auto max-w-5xl">
          <div className="space-y-2 lg:mx-auto lg:max-w-2xl">
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
                className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void submit(e);
                  }
                }}
              />
              <button
                type="submit"
                aria-label="Send"
                title="Send (Enter)"
                disabled={!agentReady || sending || (!draft.trim() && !attachedFile)}
                className="flex w-12 shrink-0 items-center justify-center self-stretch rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
              >
                {sending ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <CornerDownLeft className="size-4" aria-hidden />
                )}
              </button>
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
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          You
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
