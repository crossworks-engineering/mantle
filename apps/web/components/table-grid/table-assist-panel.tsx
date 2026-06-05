'use client';

import { useRef, useState } from 'react';
import { Loader2, SendHorizontal, Sparkles, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { ensureTableDoc, type TableDoc } from '@mantle/content/table-model';
import { AssistAgentPicker } from '@/components/assist-agent-picker';

type Msg = { role: 'user' | 'assistant'; text: string };

const SUGGESTIONS = [
  'Add a Total column = Qty × Price',
  'Sum the price column',
  'Sort by date, newest first',
  'Add a status column with a few options',
];

/**
 * In-editor assistant for a table — the Tables specialist runs against the open
 * grid (reads rows by id, edits into the draft), and the editor reloads the
 * draft so changes appear live. The user reviews + commits as usual.
 */
export function TableAssistPanel({
  tableId,
  agentName,
  onApplied,
  onClose,
}: {
  tableId: string;
  agentName: string;
  onApplied: (doc: TableDoc) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // The picker can repoint Assist at a different agent; reflect its name in the
  // copy below. null (the default option) falls back to the passed agentName.
  const [pickedName, setPickedName] = useState<string | null>(null);
  const displayName = pickedName ?? agentName;

  async function send(prompt: string) {
    const text = prompt.trim();
    if (!text || busy) return;
    setInput('');
    setMessages((m) => [...m, { role: 'user', text }]);
    setBusy(true);
    try {
      const res = await fetch(`/api/tables/${tableId}/ai-assist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: text }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(j.error ?? 'Assist failed');
        setMessages((m) => [...m, { role: 'assistant', text: `⚠️ ${j.error ?? 'Something went wrong.'}` }]);
        return;
      }
      // Reload the draft into the grid so the change is visible immediately.
      if (j.table) onApplied(ensureTableDoc(j.table.draft ?? j.table.data));
      const delta =
        j.summary && (j.summary.rowsAfter !== j.summary.rowsBefore || j.summary.columnsAfter !== j.summary.columnsBefore)
          ? ` (${j.summary.columnsAfter} cols · ${j.summary.rowsAfter} rows)`
          : '';
      setMessages((m) => [...m, { role: 'assistant', text: (j.reply || 'Done.') + delta }]);
    } catch {
      toast.error('Assist failed');
    } finally {
      setBusy(false);
      requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }));
    }
  }

  return (
    <div className="flex h-full min-h-0 w-80 shrink-0 flex-col border-l border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
          <Sparkles className="size-4 shrink-0 text-primary" aria-hidden />
          {/* Configurable on the surface itself; defaults to the Ledger specialist. */}
          <AssistAgentPicker
            surface="tables"
            defaultLabel={`${agentName} (default)`}
            onAgentNameChange={setPickedName}
          />
        </div>
        <Button size="icon" variant="ghost" className="size-7 text-muted-foreground" onClick={onClose} aria-label="Close assistant">
          <X />
        </Button>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto scrollbar-thin p-3">
        {messages.length === 0 ? (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Ask {displayName} to work on this table — add totals or formula columns, sort &amp; filter, clean up values,
              add rows from data you paste. Edits go to the draft; review and Commit when ready.
            </p>
            <div className="flex flex-col gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => void send(s)}
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
            <div
              key={i}
              className={cn(
                'rounded-lg px-2.5 py-1.5 text-sm',
                m.role === 'user' ? 'bg-muted text-foreground' : 'border border-border bg-background',
              )}
            >
              {m.role === 'assistant' && (
                <div className="mb-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{displayName}</div>
              )}
              <p className="whitespace-pre-wrap leading-relaxed">{m.text}</p>
            </div>
          ))
        )}
        {busy && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden /> {displayName} is working…
          </div>
        )}
      </div>

      <form
        className="flex items-center gap-2 border-t border-border p-2"
        onSubmit={(e) => { e.preventDefault(); void send(input); }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={`Ask ${displayName}…`}
          disabled={busy}
          className="min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
          aria-label="Message the table assistant"
        />
        <Button type="submit" size="icon" className="size-8 shrink-0" disabled={busy || !input.trim()} aria-label="Send">
          {busy ? <Loader2 className="animate-spin" /> : <SendHorizontal />}
        </Button>
      </form>
    </div>
  );
}
