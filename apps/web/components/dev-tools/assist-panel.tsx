'use client';

/**
 * Toolsmith Assist panel — the API Console's in-surface agent. Describe an
 * integration ("read these Mapbox docs, give my assistant travel times")
 * and Toolsmith reads the docs, authors templated tools, tests them live,
 * and grants them to an agent. After every reply the console's Agent-tools
 * list refreshes so new tools appear immediately.
 *
 * Mirrors the /tables assist panel (same layout, same AssistAgentPicker).
 */

import { useRef, useState } from 'react';
import { Loader2, SendHorizontal, Sparkles, X } from 'lucide-react';
import { Button } from '@mantle/web-ui/ui/button';
import { useToast } from '@mantle/web-ui/ui/toast';
import { AssistAgentPicker } from '@/components/assist-agent-picker';
import { useAssistStage, SpecialistWorking } from '@/components/specialist-working';
import { ChatBubble } from '@/components/chat-bubble';
import { apiSend, ApiError } from '@mantle/web-ui/api-fetch';
import { useDevTools } from './context';

type Msg = { role: 'user' | 'assistant'; text: string };

const SUGGESTIONS = [
  'Read the API docs at <url> and build tools for <what you need>',
  'List my custom tools and test each one',
  'What vault keys do I have for tool auth?',
  'Grant the <group> tools to my assistant',
];

export function DevToolsAssistPanel({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const { refreshAgentTools } = useDevTools();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pickedName, setPickedName] = useState<string | null>(null);
  const displayName = pickedName ?? 'Toolsmith';
  // Live "what is Toolsmith doing" label, polled while a run is in flight.
  const stage = useAssistStage('/api/assist/stage?surface=dev-tools', busy);

  async function send(prompt: string) {
    const text = prompt.trim();
    if (!text || busy) return;
    setInput('');
    // Snapshot the transcript BEFORE adding this turn — it's the context the
    // agent needs to keep continuity across the one-shot delegation.
    const priorTurns = messages.slice(-12);
    setMessages((m) => [...m, { role: 'user', text }]);
    setBusy(true);
    try {
      const j = await apiSend<{ reply?: string }>('/api/dev-tools/ai-assist', 'POST', {
        prompt: text,
        history: priorTurns,
      });
      setMessages((m) => [...m, { role: 'assistant', text: j.reply || 'Done.' }]);
      // Toolsmith may have created/updated/deleted tools — reflect it now.
      void refreshAgentTools();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return; // already bounced to /login
      const msg = e instanceof Error ? e.message : 'Assist failed';
      toast.error(msg);
      setMessages((m) => [...m, { role: 'assistant', text: `⚠️ ${msg}` }]);
    } finally {
      setBusy(false);
      requestAnimationFrame(() =>
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }),
      );
    }
  }

  return (
    <div className="flex h-full min-h-0 w-80 shrink-0 flex-col border-l border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
          <Sparkles className="size-4 shrink-0 text-primary" aria-hidden />
          <AssistAgentPicker
            surface="dev-tools"
            defaultLabel="Toolsmith (default)"
            onAgentNameChange={setPickedName}
          />
        </div>
        <Button
          size="icon"
          variant="ghost"
          className="size-7 text-muted-foreground"
          onClick={onClose}
          aria-label="Close assistant"
        >
          <X />
        </Button>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto scrollbar-thin p-3">
        {messages.length === 0 ? (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Point {displayName} at a service&apos;s API docs and it builds the tools: reads the
              reference, writes the templates, wires your vault keys, tests against the live API,
              and grants the result to an agent. One prompt → a deployed ability.
            </p>
            <div className="flex flex-col gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => setInput(s)}
                  disabled={busy}
                  className="rounded-md border border-border px-2.5 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/50 disabled:opacity-50"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m, i) => (
            <ChatBubble
              key={i}
              role={m.role}
              agentName={m.role === 'assistant' ? displayName : undefined}
            >
              {m.text}
            </ChatBubble>
          ))
        )}
        {busy && <SpecialistWorking stage={stage} agentName={displayName} />}
      </div>

      <form
        className="flex items-center gap-2 border-t border-border p-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={`Ask ${displayName}…`}
          disabled={busy}
          className="min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
          aria-label="Message the Toolsmith assistant"
        />
        <Button
          type="submit"
          size="icon"
          className="size-8 shrink-0"
          disabled={busy || !input.trim()}
          aria-label="Send"
        >
          {busy ? <Loader2 className="animate-spin" /> : <SendHorizontal />}
        </Button>
      </form>
    </div>
  );
}
