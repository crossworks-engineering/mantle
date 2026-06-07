'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChevronDown, Loader2, MessageSquare, Send, Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useTurnStage } from './use-turn-stage';

/**
 * App-wide assistant dock. The /assistant turn fetch runs here (in the
 * persistent shell), so a long turn — research, a big tool loop — keeps going
 * when you navigate away, and a floating mini-chat shows the agent working and
 * her reply, with a box to keep talking. No beforeunload guard needed: the turn
 * route persists + caches by idempotency-key, so even a reload doesn't lose it.
 */
export type TurnResponse = {
  inbound: { id: string; text: string; createdAt: string; artifacts?: unknown[] };
  outbound: { id: string; text: string; model: string | null; createdAt: string };
  artifacts?: unknown[];
  warnings?: string[];
};

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

type AssistantDockApi = {
  /** Run a turn through the persistent fetch. Resolves with the server result
   *  (or throws), while also driving the floating dock. */
  runTurn: (input: RunTurnInput) => Promise<TurnResponse>;
  // ── dock view state (consumed by <AssistantDock/>) ──
  messages: DockMsg[];
  busy: boolean;
  agentSlug?: string;
  agentName: string;
  clear: () => void;
};

const Ctx = createContext<AssistantDockApi | null>(null);
const MAX_DOCK_MSGS = 12;

export function AssistantDockProvider({ children }: { children: React.ReactNode }) {
  const [messages, setMessages] = useState<DockMsg[]>([]);
  const [agentSlug, setAgentSlug] = useState<string | undefined>(undefined);
  const [agentName, setAgentName] = useState('Assistant');
  const agentRef = useRef<string | undefined>(undefined);

  const runTurn = useCallback(async (input: RunTurnInput): Promise<TurnResponse> => {
    const switched = agentRef.current !== input.agentSlug;
    agentRef.current = input.agentSlug;
    setAgentSlug(input.agentSlug);
    setAgentName(input.agentName);

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
          res = await fetch('/api/assistant/turn', { method: 'POST', headers, body: input.body });
        } catch {
          // Network drop / connection reset mid-turn — the turn is still
          // running server-side; fall through to re-attach by key.
          res = null;
        }

        if (res) {
          if (res.ok) {
            const data = (await res.json()) as TurnResponse;
            setMessages((prev) =>
              prev.map((m) => (m.id === botId ? { ...m, text: data.outbound.text, pending: false } : m)),
            );
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
      throw err;
    }
  }, []);

  const clear = useCallback(() => setMessages([]), []);

  const busy = useMemo(() => messages.some((m) => m.role === 'assistant' && m.pending), [messages]);

  const api = useMemo<AssistantDockApi>(
    () => ({ runTurn, messages, busy, agentSlug, agentName, clear }),
    [runTurn, messages, busy, agentSlug, agentName, clear],
  );

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useAssistantDock(): AssistantDockApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAssistantDock must be used inside <AssistantDockProvider>');
  return ctx;
}

/**
 * Floating mini-chat. Rendered inside the shell so it inherits `--activity-w`.
 * Hidden on /assistant (the full view owns the conversation there) and when
 * there's nothing to show.
 */
export function AssistantDock() {
  const { messages, busy, agentSlug, agentName, clear, runTurn } = useAssistantDock();
  // Live "what's the agent doing" label, polled from the running trace.
  const stageLabel = useTurnStage(busy);
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const onClear = clear;
  const onReply = (text: string) =>
    runTurn({
      agentSlug,
      agentName,
      idempotencyKey: crypto.randomUUID(),
      displayText: text,
      body: JSON.stringify({ text, agentSlug }),
      isJson: true,
    }).catch(() => {
      /* surfaced inline in the transcript */
    });

  // Pin to the newest message.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && !collapsed) el.scrollTop = el.scrollHeight;
  }, [messages, collapsed]);

  // The full /assistant view already shows the conversation — no dock there.
  if (pathname === '/assistant' || messages.length === 0) return null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    onReply(text);
  };

  return (
    <div className="pointer-events-auto flex max-h-[60vh] w-full flex-col overflow-hidden rounded-lg border border-border bg-card shadow-lg">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        {busy ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden />
        ) : (
          <MessageSquare className="size-4 shrink-0 text-primary" aria-hidden />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {agentName}
          {busy && <span className="ml-1 font-normal text-muted-foreground">is working…</span>}
        </span>
        <Button asChild variant="ghost" size="icon" className="size-7" title="Open full chat">
          <Link href={agentSlug ? `/assistant?agent=${agentSlug}` : '/assistant'} aria-label="Open full chat">
            <Sparkles aria-hidden />
          </Link>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => setCollapsed((v) => !v)}
          aria-label={collapsed ? 'Expand' : 'Collapse'}
        >
          <ChevronDown className={cn('transition-transform', collapsed && '-rotate-90')} aria-hidden />
        </Button>
        <Button variant="ghost" size="icon" className="size-7" onClick={onClear} aria-label="Dismiss" disabled={busy}>
          <X aria-hidden />
        </Button>
      </div>

      {!collapsed && (
        <>
          <div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto scrollbar-thin px-3 py-2.5">
            {messages.map((m) =>
              m.role === 'user' ? (
                <div key={m.id} className="flex justify-end">
                  <div className="max-w-[85%] rounded-lg rounded-br-sm bg-primary px-2.5 py-1.5 text-xs text-primary-foreground">
                    {m.text}
                  </div>
                </div>
              ) : (
                <div key={m.id} className="flex justify-start">
                  <div
                    className={cn(
                      'max-w-[90%] rounded-lg rounded-bl-sm border border-border bg-background px-2.5 py-1.5 text-xs',
                      m.error && 'border-destructive/40 text-destructive',
                    )}
                  >
                    {m.pending ? (
                      <span className="flex items-center gap-1.5 text-muted-foreground">
                        <Loader2 className="size-3 animate-spin" aria-hidden /> {stageLabel ?? 'thinking…'}
                      </span>
                    ) : (
                      <div className="prose prose-sm dark:prose-invert max-w-none break-words text-xs [&_p]:my-1 [&_pre]:my-1 [&_ul]:my-1">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
                      </div>
                    )}
                  </div>
                </div>
              ),
            )}
          </div>

          <form onSubmit={submit} className="flex items-center gap-1.5 border-t border-border p-2">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={busy ? `${agentName} is working…` : `Reply to ${agentName}…`}
              className="h-8 text-xs"
            />
            <Button type="submit" size="icon" className="size-8 shrink-0" disabled={!draft.trim() || busy} aria-label="Send">
              <Send aria-hidden />
            </Button>
          </form>
        </>
      )}
    </div>
  );
}
