'use client';

/**
 * The Team Chat member experience: token gate → forever-thread → composer,
 * with live turn streaming (full status labels — plan §15.5) when the deploy
 * has it on.
 *
 * Public surface: raw fetch/EventSource on purpose (apiFetch is the app
 * shell's authenticated wrapper), inline feedback (no toast provider), and the
 * signed team-chat cookie carries auth on every call. A 401 anywhere flips
 * back to the token prompt — that's what mid-session revocation looks like.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { KeyRound, Paperclip, SendHorizontal, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

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

// ── Token gate ────────────────────────────────────────────────────────────────

function TokenGate({ onAuthed }: { onAuthed: () => void }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async () => {
    const value = token.trim();
    if (!value || pending) return;
    setError(null);
    setPending(true);
    try {
      const r = await fetch('/api/team/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: value }),
      });
      if (r.ok) {
        onAuthed();
        return;
      }
      setError(
        r.status === 429
          ? 'Too many attempts — wait a minute and try again.'
          : 'That token wasn’t recognised. Check it with the brain’s admin.',
      );
    } catch {
      setError('Could not reach the server — try again.');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6 text-card-foreground shadow-sm">
        <div className="mb-4 flex items-center gap-2">
          <KeyRound className="size-4 text-muted-foreground" />
          <h1 className="text-base font-semibold">Team Chat</h1>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          Enter your team token to chat with this brain. Your conversations are visible to the
          brain’s admin.
        </p>
        <Label htmlFor="team-token" className="mb-1.5 block text-sm">
          Team token
        </Label>
        <Input
          id="team-token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="e.g. Xk3mP2vQ"
          autoComplete="off"
          autoFocus
        />
        {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
        <Button className="mt-4 w-full" onClick={submit} disabled={pending || !token.trim()}>
          {pending ? 'Checking…' : 'Enter chat'}
        </Button>
      </div>
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
  const threadRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  // Pin the thread to the bottom on new content.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, live]);

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

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-border/60 px-4 py-3">
        <h1 className="text-sm font-semibold">
          Team Chat <span className="font-logo lowercase text-muted-foreground">mantle</span>
        </h1>
        <p className="text-xs text-muted-foreground">Conversations are visible to the brain admin</p>
      </header>

      <div ref={threadRef} className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-4 py-4">
        {messages.length === 0 && !live ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            Ask anything this brain knows. Requests to change content are routed to a specialist
            for review.
          </p>
        ) : null}
        <div className="flex flex-col gap-3">
          {messages.map((m) =>
            m.direction === 'inbound' ? (
              <div key={m.id} className="ml-auto max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
                <p className="whitespace-pre-wrap">{m.text}</p>
              </div>
            ) : m.status === 'pending' && live ? null : (
              <div key={m.id} className="mr-auto w-full max-w-[85%] rounded-lg bg-card px-3 py-2 text-card-foreground">
                {m.status === 'failed' ? (
                  <p className="text-sm text-destructive">
                    That message couldn’t be answered. Try again, or let the brain admin know.
                  </p>
                ) : m.status === 'pending' ? (
                  <p className="text-sm text-muted-foreground">Thinking…</p>
                ) : (
                  <div className="prose prose-accent prose-sm max-w-none dark:prose-invert">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
                  </div>
                )}
              </div>
            ),
          )}
          {live ? (
            <div className="mr-auto w-full max-w-[85%] rounded-lg bg-card px-3 py-2 text-card-foreground">
              {live.text ? (
                <div className="prose prose-accent prose-sm max-w-none dark:prose-invert">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{live.text}</ReactMarkdown>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">{live.status ?? 'Thinking…'}</p>
              )}
              {live.text && live.status ? (
                <p className="mt-1 text-xs text-muted-foreground">{live.status}</p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className="border-t border-border/60 p-3">
        {sendError ? <p className="mb-2 text-sm text-destructive">{sendError}</p> : null}
        {file ? (
          <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
            <Paperclip className="size-4" />
            <span className="truncate">{file.name}</span>
            <Button variant="ghost" size="sm" onClick={() => setFile(null)} aria-label="Remove attachment">
              <X />
            </Button>
          </div>
        ) : null}
        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <Button
            variant="ghost"
            size="sm"
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
            placeholder="Ask the brain…"
            rows={2}
            className="min-h-0 flex-1 resize-none"
            disabled={sending}
          />
          <Button onClick={() => void send()} disabled={sending || (!draft.trim() && !file)} aria-label="Send">
            <SendHorizontal />
          </Button>
        </div>
      </div>
    </div>
  );
}
