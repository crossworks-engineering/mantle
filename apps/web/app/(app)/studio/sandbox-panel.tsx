'use client';

/**
 * Agent Studio Phase 4 — the no-persist sandbox (docs/agent-studio.md).
 *
 * A multi-turn chat against the agent's CURRENT composed prompt that writes
 * NOTHING — no conversation store, no nodes, no tools, no memory. The transcript
 * lives in client state; each send POSTs the whole history to /api/studio/sandbox
 * which prepends the freshly-composed system prompt and calls the model. Safe to
 * spam while you fine-tune a prompt; nothing lands in the brain.
 */

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, RotateCcw, Send } from 'lucide-react';
import { apiSend } from '@/lib/api-fetch';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

type Msg = { role: 'user' | 'assistant'; content: string };
type Meta = { model: string; tokensIn: number | null; tokensOut: number | null };

export function SandboxPanel({ agentId, agentName }: { agentId: string; agentName: string }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, busy]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    const next: Msg[] = [...messages, { role: 'user', content: text }];
    setMessages(next);
    setInput('');
    setBusy(true);
    setError(null);
    try {
      const json = await apiSend<{
        reply?: string;
        model: string;
        tokensIn: number | null;
        tokensOut: number | null;
      }>('/api/studio/sandbox', 'POST', { agentId, messages: next });
      setMessages([...next, { role: 'assistant', content: json.reply ?? '' }]);
      setMeta({ model: json.model, tokensIn: json.tokensIn, tokensOut: json.tokensOut });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setMessages([]);
    setMeta(null);
    setError(null);
    setInput('');
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1 text-[13px] font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className="size-3.5" aria-hidden /> Sandbox — chat with this prompt (nothing saved)
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="flex items-center gap-1 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
        >
          <ChevronDown className="size-3.5" aria-hidden /> Sandbox
        </button>
        {messages.length > 0 && (
          <Button size="sm" variant="ghost" className="h-6 px-2 text-[13px]" onClick={reset} disabled={busy}>
            <RotateCcw className="size-3" /> Reset
          </Button>
        )}
      </div>

      <p className="text-[12px] text-muted-foreground/70">
        Ephemeral test of {agentName}’s current composed prompt — no tools, no memory, nothing is saved.
      </p>

      {messages.length > 0 && (
        <div className="flex max-h-72 flex-col gap-2 overflow-y-auto scrollbar-thin rounded-md border border-border bg-muted/20 p-2">
          {messages.map((m, i) => (
            <div
              key={i}
              className={
                'max-w-[85%] whitespace-pre-wrap break-words rounded-md px-2.5 py-1.5 text-[13px] leading-relaxed ' +
                (m.role === 'user'
                  ? 'self-end bg-accent text-accent-foreground'
                  : 'self-start bg-card text-card-foreground')
              }
            >
              {m.content}
            </div>
          ))}
          {busy && (
            <div className="self-start flex items-center gap-1.5 rounded-md bg-card px-2.5 py-1.5 text-[13px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" aria-hidden /> thinking…
            </div>
          )}
          <div ref={endRef} />
        </div>
      )}

      {error && <p className="text-[13px] text-destructive">{error}</p>}

      <div className="flex items-end gap-2">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={`Message ${agentName}…  (Enter to send, Shift+Enter for newline)`}
          rows={2}
          disabled={busy}
          className="text-sm"
        />
        <Button size="sm" onClick={() => void send()} disabled={busy || !input.trim()}>
          {busy ? <Loader2 className="animate-spin" /> : <Send />}
        </Button>
      </div>

      {meta && (
        <p className="text-[12px] text-muted-foreground/70">
          {meta.model}
          {meta.tokensIn != null && ` · ${meta.tokensIn}→${meta.tokensOut ?? '?'} tok`}
        </p>
      )}
    </div>
  );
}
