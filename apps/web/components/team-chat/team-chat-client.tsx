'use client';

/**
 * The Team Chat member experience: token gate → forever-thread → composer,
 * with live turn streaming (full status labels — plan §15.5) when the deploy
 * has it on.
 *
 * LOOK & FEEL mirrors the main assistant chat (assistant-client.tsx): each
 * exchange is a TURN laid out as a two-column grid — the reply as a rich
 * document on the main (left) canvas, the member's question as a compact
 * sticky card in the right margin, anchored beside the reply it produced —
 * with a thin accent divider between turns, a bouncing-dots thinking bubble
 * carrying the live status labels, hover meta (time + copy) on replies, and a
 * jump-to-latest pill when scrolled up. Functionality intentionally differs:
 * members get standard-Markdown replies (no TipTap rich dialect), no thought
 * trail, no tool ledger — those are owner-surface features.
 *
 * Public surface: raw fetch/EventSource on purpose (apiFetch is the app
 * shell's authenticated wrapper), inline feedback (no toast provider), and the
 * signed team-chat cookie carries auth on every call. A 401 anywhere flips
 * back to the token prompt — that's what mid-session revocation looks like.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowDown, Paperclip, SendHorizontal, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { CopyButton } from '@/components/assistant/copy-button';
import { TokenGate } from '@/components/team-chat/token-gate';

type TeamMessage = {
  id: string;
  direction: 'inbound' | 'outbound';
  text: string;
  status: 'pending' | 'complete' | 'failed';
  error: string | null;
  attachments: { kind: string; nodeId?: string; mime?: string }[];
  createdAt: string;
};

type LiveTurn = {
  turnId: string;
  status: string | null;
  text: string;
};

/** One exchange: the member's message and the reply it produced. The API
 *  returns a flat inbound/outbound list; pairing it into turns is what lets
 *  the thread render prompt-beside-reply like the main assistant chat. */
type Turn = {
  key: string;
  prompt: TeamMessage | null;
  response: TeamMessage | null;
};

function buildTurns(messages: TeamMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of messages) {
    if (m.direction === 'inbound') {
      turns.push({ key: m.id, prompt: m, response: null });
    } else {
      const last = turns[turns.length - 1];
      if (last && last.response === null) last.response = m;
      else turns.push({ key: m.id, prompt: null, response: m });
    }
  }
  return turns;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Full date-time for tooltips — a forever-thread spans days, so a bare
 *  clock time on last week's message would read as today's. */
function formatFull(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString();
}

// ── Presentational pieces (mirroring the assistant chat's treatment) ─────────

/** The member's message as a compact card in the right margin — sticky so it
 *  stays beside a long reply while it scrolls. */
function PromptCard({ message }: { message: TeamMessage }) {
  const optimistic = message.id.startsWith('optimistic-');
  return (
    <div
      className={
        // Tinted toward "mine" (primary/5 + primary/20 border) — the one
        // deliberate departure from the assistant's muted card: members come
        // from bubble chats where "my message" is colour-coded, and the tint
        // plus the entrance motion on a just-sent card leads the eye to the
        // margin instead of leaving it searching.
        'rounded-lg border border-primary/20 bg-primary/5 px-3 py-2.5 text-sm lg:sticky lg:top-2' +
        (optimistic ? ' animate-in fade-in slide-in-from-bottom-2 duration-300' : '')
      }
    >
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          You
        </span>
        <span className="text-[10px] text-muted-foreground" title={formatFull(message.createdAt)}>
          {formatTime(message.createdAt)}
        </span>
      </div>
      {message.text && (
        <p className="whitespace-pre-wrap break-words text-foreground">{message.text}</p>
      )}
      {message.attachments.length > 0 && (
        <div className="mt-2 flex flex-col gap-1">
          {message.attachments.map((a, i) => (
            <span
              key={`${message.id}-att-${i}`}
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
            >
              <Paperclip className="size-3" aria-hidden />
              {a.kind === 'file' ? 'attachment' : a.kind}
            </span>
          ))}
        </div>
      )}
      {optimistic && <div className="mt-1 text-[10px] italic text-muted-foreground">sending…</div>}
    </div>
  );
}

/** Bouncing-dots thinking bubble with the live status label — the same
 *  treatment as the assistant chat, on the theme's primary soft tint. */
function ThinkingBubble({ label }: { label: string | null }) {
  return (
    // Soft primary tint with INHERITED foreground for the dots/label — never
    // text-primary over a primary tint (unpaired fill: light-primary themes
    // would wash the dots out; see apps/web/CLAUDE.md §2 and the assistant's
    // accent-soft bubble, which also renders content in currentColor).
    <div className="inline-flex items-center gap-2 rounded-2xl bg-primary/10 px-3.5 py-3 text-foreground">
      <span className="sr-only">The assistant is working</span>
      <span className="flex items-center gap-1" aria-hidden>
        <span className="size-1.5 animate-bounce rounded-full bg-current opacity-60 [animation-delay:-0.3s]" />
        <span className="size-1.5 animate-bounce rounded-full bg-current opacity-60 [animation-delay:-0.15s]" />
        <span className="size-1.5 animate-bounce rounded-full bg-current opacity-60" />
      </span>
      {label && (
        <span className="text-xs text-current opacity-70" aria-hidden>
          {label}
        </span>
      )}
    </div>
  );
}

/** Markdown reply body. A lightweight ReactMarkdown render on purpose —
 *  team replies are standard Markdown (chat_writing), never the TipTap rich
 *  dialect, and the same renderer serves the live stream buffer. */
function ReplyBody({ markdown }: { markdown: string }) {
  return (
    <div className="prose prose-accent max-w-none break-words dark:prose-invert [&>:first-child]:mt-0 [&>:last-child]:mb-0">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
    </div>
  );
}

// ── Chat ──────────────────────────────────────────────────────────────────────

export function TeamChatClient() {
  const [authed, setAuthed] = useState<boolean | null>(null); // null = resolving
  const [messages, setMessages] = useState<TeamMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [showJump, setShowJump] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Whether the view is pinned to the bottom. Starts pinned; scrolling up
  // unpins (reading history must not be yanked away by a streaming reply),
  // returning near the bottom re-pins.
  const pinnedRef = useRef(true);

  const refetch = useCallback(async (): Promise<boolean> => {
    try {
      const r = await fetch('/api/team/messages', { cache: 'no-store' });
      if (r.status === 401) {
        setAuthed(false);
        return false;
      }
      if (!r.ok) return false;
      const body = (await r.json()) as { messages: TeamMessage[] };
      setMessages(body.messages);
      setAuthed(true);
      return true;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    void refetch();
    return () => esRef.current?.close();
  }, [refetch]);

  const jumpToBottom = useCallback(() => {
    const el = threadRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    pinnedRef.current = true;
    setShowJump(false);
  }, []);

  const onScroll = useCallback(() => {
    const el = threadRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
    pinnedRef.current = nearBottom;
    setShowJump(!nearBottom);
  }, []);

  // Keep the thread pinned to the bottom on new content — but only while the
  // member is actually at the bottom. Layout effect so the first paint of a
  // loaded thread starts at the bottom (no top-of-thread flash).
  useLayoutEffect(() => {
    const el = threadRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, live]);

  // Late content growth (markdown images loading in, long replies settling)
  // happens AFTER the effect above — re-pin via a ResizeObserver on the
  // content wrapper, or a member landing on the thread ends up stranded
  // mid-scroll with no jump pill (content growth fires no scroll event).
  // Same machinery as the assistant chat.
  useEffect(() => {
    const content = contentRef.current;
    const el = threadRef.current;
    if (!content || !el) return;
    const obs = new ResizeObserver(() => {
      if (pinnedRef.current) el.scrollTop = el.scrollHeight;
    });
    obs.observe(content);
    return () => obs.disconnect();
  }, []);

  const finishTurn = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
    setLive(null);
    setSending(false);
    void refetch();
  }, [refetch]);

  // Open the live stream for a server-minted turn id. The id embeds the caller's
  // contact, so the stream route only ever serves this member their own turn.
  const openStream = useCallback(
    (turnId: string) => {
      let es: EventSource;
      try {
        es = new EventSource(`/api/team/turn/${turnId}/stream`);
      } catch {
        // EventSource unsupported — reconcile against the durable row instead.
        finishTurn();
        return;
      }
      esRef.current = es;
      es.onmessage = (ev) => {
        try {
          const event = JSON.parse(ev.data) as {
            type: string;
            data: { label?: string; text?: string; message?: string };
          };
          if (event.type === 'status' && event.data.label) {
            setLive((l) => (l ? { ...l, status: event.data.label ?? l.status } : l));
          } else if (event.type === 'text-delta' && event.data.text) {
            setLive((l) => (l ? { ...l, status: null, text: l.text + (event.data.text ?? '') } : l));
          } else if (event.type === 'done' || event.type === 'error') {
            if (event.type === 'error') setSendError(event.data.message ?? 'The turn failed.');
            finishTurn();
          }
        } catch {
          /* ignore malformed frames */
        }
      };
      es.onerror = () => {
        // The connection dropped (proxy idle-timeout, network blip). The reply
        // is durable server-side, so reconcile by refetching rather than leaving
        // the turn stuck 'sending' forever. Guard against a close WE initiated.
        if (esRef.current === es) finishTurn();
      };
    },
    [finishTurn],
  );

  const send = async () => {
    const text = draft.trim();
    if ((!text && !file) || sending) return;
    const outgoingFile = file;
    setSendError(null);
    setSending(true);
    // A send means the member is at the composer — pin so the reply streams
    // into view.
    pinnedRef.current = true;
    setShowJump(false);
    // Show the thinking state immediately; the real turn id arrives from the
    // POST (minted server-side, contact-scoped) and the stream opens after.
    setLive({ turnId: '', status: 'Thinking…', text: '' });

    // Optimistic user bubble.
    setMessages((m) => [
      ...m,
      {
        id: `optimistic-${crypto.randomUUID()}`,
        direction: 'inbound',
        text: text || `📎 ${outgoingFile?.name ?? 'attachment'}`,
        status: 'complete',
        error: null,
        attachments: [],
        createdAt: new Date().toISOString(),
      },
    ]);
    setDraft('');
    setFile(null);

    // A client nonce only for retry dedup — the server uses it as the NONCE half
    // of a contact-scoped turn id, never as the whole id, so a client can't
    // address another member's turn.
    const nonce = crypto.randomUUID();

    try {
      let r: Response;
      if (outgoingFile) {
        const form = new FormData();
        if (text) form.set('text', text);
        form.set('file', outgoingFile);
        r = await fetch('/api/team/turn', {
          method: 'POST',
          headers: { 'idempotency-key': nonce },
          body: form,
        });
      } else {
        r = await fetch('/api/team/turn', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': nonce },
          body: JSON.stringify({ text }),
        });
      }
      if (r.status === 401) {
        setLive(null);
        setSending(false);
        setAuthed(false);
        return;
      }
      if (r.status === 202) {
        // Streaming path: subscribe to the server-minted id; the buffer replays
        // any events emitted between enqueue and subscribe (no pre-subscribe
        // race). finishTurn fires on done/error/drop.
        const body = (await r.json().catch(() => ({}))) as { turnId?: string };
        if (body.turnId) openStream(body.turnId);
        else finishTurn(); // no id back — fall back to a refetch
        return;
      }
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        setSendError(body.error ?? 'Sending failed — try again.');
        finishTurn();
        return;
      }
      finishTurn(); // blocking path: reply is durable, refetch renders it
    } catch {
      setSendError('Could not reach the server — try again.');
      finishTurn();
    }
  };

  if (authed === null) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }
  if (!authed) return <TokenGate onAuthed={() => void refetch()} />;

  const turns = buildTurns(messages);
  // Where the live stream renders. ONLY a last turn that is still awaiting its
  // answer (no response, or a durable pending row) may host it — a completed
  // reply must never be visually replaced by a stream, and a stream must never
  // sit beside the wrong question (possible when a stale refetch resolves
  // after a rapid follow-up send and momentarily drops the optimistic prompt).
  // No eligible host ⇒ the stream renders as its own trailing turn below.
  const lastTurn = turns[turns.length - 1];
  const liveHostIdx =
    live && lastTurn && (lastTurn.response === null || lastTurn.response.status === 'pending')
      ? turns.length - 1
      : -1;

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <header className="border-b border-border/60 px-6 py-3">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between">
          <h1 className="text-sm font-semibold">
            Team Chat <span className="font-logo lowercase text-muted-foreground">mantle</span>
          </h1>
          <p className="text-xs text-muted-foreground">
            Conversations are visible to the brain admin
          </p>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={threadRef}
          onScroll={onScroll}
          className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-6 py-6"
        >
          {/* Height-tracking wrapper for the ResizeObserver re-pin above. */}
          <div ref={contentRef}>
          {turns.length === 0 && !live ? (
            <div className="mx-auto flex max-w-3xl flex-col items-center gap-3 rounded-md border border-dashed border-border bg-muted/30 px-4 py-10 text-center">
              <span className="font-logo lowercase text-lg text-muted-foreground" aria-hidden>
                mantle
              </span>
              <p className="text-sm text-muted-foreground">
                Ask anything this brain knows. Requests to change content are routed to a
                specialist for review.
              </p>
            </div>
          ) : (
            <ul className="mx-auto flex w-full max-w-5xl flex-col">
              {turns.length > 0 && (
                <li className="pb-6">
                  <p className="text-center text-xs text-muted-foreground">
                    Beginning of the conversation
                  </p>
                </li>
              )}
              {turns.map((turn, idx) => {
                // The live stream supersedes the host turn's durable 'pending'
                // placeholder until the completed reply lands via refetch.
                const liveHere = live !== null && idx === liveHostIdx;
                return (
                  <li
                    key={turn.key}
                    className={
                      'group/turn grid gap-x-10 gap-y-3 pb-10 lg:grid-cols-[minmax(0,1fr)_300px]' +
                      // A thin divider between turns — the assistant chat's
                      // accent hairline, on the theme's primary tint here.
                      (idx > 0 ? ' border-t border-primary/15 pt-10' : '')
                    }
                  >
                    {/* RIGHT MARGIN (DOM-first so it stacks above the reply on
                        mobile): the member's question, anchored beside the
                        reply it produced. Omitted entirely for prompt-less
                        turns — an empty grid child adds a stray gap-y row on
                        mobile. The reply cell pins its own column, so the grid
                        stays intact. */}
                    {turn.prompt ? (
                      <div className="lg:col-start-2 lg:row-start-1">
                        <PromptCard message={turn.prompt} />
                      </div>
                    ) : null}

                    {/* MAIN CANVAS: the reply as a document. */}
                    <div className="min-w-0 lg:col-start-1 lg:row-start-1">
                      {liveHere ? (
                        live.text ? (
                          <div>
                            <div className="mb-2 text-sm font-medium text-muted-foreground">
                              Assistant
                            </div>
                            <ReplyBody markdown={live.text} />
                            {live.status && (
                              <p className="mt-1.5 text-xs text-muted-foreground">{live.status}</p>
                            )}
                          </div>
                        ) : (
                          <ThinkingBubble label={live.status} />
                        )
                      ) : turn.response ? (
                        turn.response.status === 'failed' ? (
                          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                            <span>
                              That message couldn&rsquo;t be answered. Try again, or let the brain
                              admin know.
                            </span>
                          </div>
                        ) : turn.response.status === 'pending' ? (
                          // Durable pending turn (reloaded mid-flight) — the
                          // runner is still working.
                          <ThinkingBubble label={null} />
                        ) : (
                          <article>
                            <div className="mb-2 text-sm font-medium text-muted-foreground">
                              Assistant
                            </div>
                            <ReplyBody markdown={turn.response.text} />
                            {/* Hover-revealed on pointer devices; always visible
                                where hover doesn't exist (tablets), and revealed
                                on keyboard focus — an invisible focusable copy
                                button reads as broken. */}
                            <div className="mt-1.5 flex items-center justify-between gap-2 pointer-events-none opacity-0 transition-opacity group-hover/turn:pointer-events-auto group-hover/turn:opacity-100 group-focus-within/turn:pointer-events-auto group-focus-within/turn:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
                              <span
                                className="text-[10px] text-muted-foreground"
                                title={formatFull(turn.response.createdAt)}
                              >
                                {formatTime(turn.response.createdAt)}
                              </span>
                              <CopyButton text={turn.response.text} />
                            </div>
                          </article>
                        )
                      ) : null}
                    </div>
                  </li>
                );
              })}
              {/* No eligible host turn (see liveHostIdx) — render the stream
                  as its own trailing turn so it is never invisible and never
                  displaces a completed reply. */}
              {live && liveHostIdx === -1 ? (
                <li className="grid gap-x-10 gap-y-3 pb-10 lg:grid-cols-[minmax(0,1fr)_300px] border-t border-primary/15 pt-10">
                  <div className="min-w-0 lg:col-start-1 lg:row-start-1">
                    {live.text ? (
                      <div>
                        <div className="mb-2 text-sm font-medium text-muted-foreground">
                          Assistant
                        </div>
                        <ReplyBody markdown={live.text} />
                        {live.status && (
                          <p className="mt-1.5 text-xs text-muted-foreground">{live.status}</p>
                        )}
                      </div>
                    ) : (
                      <ThinkingBubble label={live.status} />
                    )}
                  </div>
                </li>
              ) : null}
            </ul>
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

      {/* Composer band: a brand-tinted gradient rising from the edge makes the
          input read as the surface's anchor (tokens only — recolors per theme). */}
      <div className="border-t border-border/60 bg-gradient-to-t from-primary/15 via-primary/5 to-background px-6 py-4">
        <div className="mx-auto w-full max-w-5xl">
          {sendError ? <p className="mb-2 text-sm text-destructive">{sendError}</p> : null}
          {file ? (
            <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
              <Paperclip className="size-4" />
              <span className="truncate">{file.name}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setFile(null)}
                aria-label="Remove attachment"
              >
                <X />
              </Button>
            </div>
          ) : null}
          {/* No Stop button (the assistant chat has one): there is no abort
              route for team turns — the runner always completes and the reply
              is durable. Deliberate omission, not an oversight. */}
          {/* items-stretch: both buttons track the textarea's height, so the
              composer reads as one block however tall the draft grows. */}
          <div className="flex items-stretch gap-2">
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <Button
              variant="ghost"
              size="sm"
              className="h-auto"
              onClick={() => fileInputRef.current?.click()}
              disabled={sending}
              aria-label="Attach a file"
            >
              <Paperclip />
            </Button>
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder="Ask the brain… (Enter to send, Shift+Enter for a new line)"
              rows={2}
              className="min-h-24 flex-1 resize-none border-[3px] bg-background"
              disabled={sending}
            />
            <Button
              className="h-auto"
              onClick={() => void send()}
              disabled={sending || (!draft.trim() && !file)}
              aria-label="Send"
            >
              <SendHorizontal />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
