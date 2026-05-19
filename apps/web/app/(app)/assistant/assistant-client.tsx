'use client';

import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { formatDateTime } from '@/lib/format-datetime';

type Message = {
  id: string;
  direction: 'inbound' | 'outbound';
  text: string;
  model?: string | null;
  createdAt: string;
  /** Optimistic flag while we wait for the server reply. */
  pending?: boolean;
};

export function AssistantClient({
  initialMessages,
  agentReady,
}: {
  initialMessages: Message[];
  agentReady: boolean;
}) {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const scrollerRef = useRef<HTMLDivElement>(null);

  // Pin the scroller to the bottom whenever messages change.
  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setError(undefined);

    const optimisticId = `pending-${Date.now()}`;
    const optimistic: Message = {
      id: optimisticId,
      direction: 'inbound',
      text,
      createdAt: new Date().toISOString(),
      pending: true,
    };
    setMessages((prev) => [...prev, optimistic]);
    setDraft('');
    setSending(true);

    try {
      const res = await fetch('/api/assistant/turn', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? `request failed (${res.status})`);
      }
      const data = (await res.json()) as {
        inbound: { id: string; text: string; createdAt: string };
        outbound: { id: string; text: string; model: string | null; createdAt: string };
      };
      setMessages((prev) => [
        ...prev.filter((m) => m.id !== optimisticId),
        {
          id: data.inbound.id,
          direction: 'inbound',
          text: data.inbound.text,
          createdAt: data.inbound.createdAt,
        },
        {
          id: data.outbound.id,
          direction: 'outbound',
          text: data.outbound.text,
          model: data.outbound.model,
          createdAt: data.outbound.createdAt,
        },
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      // Drop the optimistic row on error so the user can retry without dupes.
      setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <div ref={scrollerRef} className="flex-1 overflow-y-auto px-6 py-4">
        {messages.length === 0 ? (
          <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-10 text-center text-sm text-muted-foreground">
            No messages yet. Say hi to your assistant.
          </p>
        ) : (
          <ul className="mx-auto flex max-w-3xl flex-col gap-3">
            {messages.map((m) => (
              <li
                key={m.id}
                className={
                  'group/msg ' +
                  (m.direction === 'inbound' ? 'flex justify-end' : 'flex justify-start')
                }
              >
                <div
                  className={
                    'max-w-[80%] rounded-2xl px-3.5 py-2 text-sm ' +
                    (m.direction === 'inbound'
                      ? 'rounded-tr-sm bg-primary/10 text-foreground'
                      : 'rounded-tl-sm bg-muted text-foreground')
                  }
                >
                  <div className="prose prose-sm dark:prose-invert max-w-none [&>:first-child]:mt-0 [&>:last-child]:mb-0 [&_pre]:bg-background/60 [&_pre]:text-xs [&_code]:text-xs">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {m.text}
                    </ReactMarkdown>
                  </div>
                  {/* Meta strip is hidden until hover/focus — keeps long
                      threads visually quiet. The pending "sending…"
                      indicator is the one exception, always shown. */}
                  <div className="mt-1 flex items-baseline gap-2 text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover/msg:opacity-100 group-focus-within/msg:opacity-100">
                    <span title={formatDateTime(m.createdAt)}>
                      {new Date(m.createdAt).toLocaleTimeString()}
                    </span>
                    {m.model && <code className="font-mono">{m.model}</code>}
                  </div>
                  {/* Always-visible affordance for the optimistic send
                      state. Sits outside the hover-meta strip so the
                      user sees feedback without needing to hover. */}
                  {m.pending && (
                    <div className="mt-1 text-[10px] italic text-muted-foreground">
                      sending…
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <form
        onSubmit={submit}
        className="border-t border-border bg-background px-6 py-3"
      >
        <div className="mx-auto flex max-w-3xl gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              agentReady
                ? 'Message your assistant — Enter to send, Shift+Enter for newline.'
                : 'Configure an assistant or responder agent first at /settings/agents.'
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
            disabled={!agentReady || sending || !draft.trim()}
            className="self-end rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-40"
          >
            {sending ? '…' : 'Send'}
          </button>
        </div>
        {error && (
          <p className="mx-auto mt-2 max-w-3xl text-xs text-destructive">{error}</p>
        )}
      </form>
    </>
  );
}
