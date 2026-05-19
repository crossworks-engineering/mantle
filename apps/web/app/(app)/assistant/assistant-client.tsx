'use client';

import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { formatDateTime } from '@/lib/format-datetime';

/** A sidecar artifact attached to an outbound message. Mirrors
 *  @mantle/tools ToolArtifact, with the discriminated `kind` driving
 *  the rendering (audio = play button, image = inline preview). */
type Artifact = {
  kind: 'audio' | 'image';
  mimeType: string;
  base64: string;
  caption?: string;
  nodeId?: string;
  producedBy: string;
};

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
        artifacts?: Artifact[];
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
          artifacts: data.artifacts ?? [],
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
                  {/* Tool artifacts — audio + image bubbles inline
                      with the reply. Rendered after the text so the
                      assistant's verbal context comes first, then the
                      generated media. */}
                  {m.artifacts && m.artifacts.length > 0 && (
                    <div className="mt-2 flex flex-col gap-2">
                      {m.artifacts.map((a, i) => (
                        <ArtifactView key={`${m.id}-art-${i}`} artifact={a} />
                      ))}
                    </div>
                  )}
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

/**
 * Render one tool-emitted artifact inline. Audio gets an <audio
 * controls> element; images get a bounded preview with a click-to-
 * enlarge affordance. Both use a `data:` URL — no separate fetch.
 */
function ArtifactView({ artifact }: { artifact: Artifact }) {
  const dataUrl = `data:${artifact.mimeType};base64,${artifact.base64}`;
  if (artifact.kind === 'audio') {
    return (
      <div className="rounded-lg border border-border bg-background/60 p-2">
        {/* controls renders the play button + scrubber + duration in
            the browser's native styling. Sufficient for our use case;
            a custom waveform UI would be nice-to-have but adds weight. */}
        <audio controls src={dataUrl} className="w-full" preload="metadata">
          Your browser doesn't support the audio element.
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
