'use client';

/**
 * AI-assist side panel for /pages/[id] — the Phase 3a user-facing
 * surface that invokes the Pages agent on the current page.
 *
 * UX:
 *   - Header: "AI assist" + collapse button
 *   - Chat surface (stateless turns — Pages is a one-shot specialist
 *     per its persona; multi-turn history isn't needed here, and not
 *     storing it keeps the panel snappy + matches /assistant for the
 *     reflexive editor flow)
 *   - Per-reply: diff summary card (added / changed / removed counts +
 *     up to 8 sample block previews from the response payload), so the
 *     user sees WHAT changed without leaving the panel.
 *   - Hint: "review in editor / commit / discard" — the editor is
 *     already showing the new draft (it loads draft ?? doc); this
 *     surfaces the controls that promote or revert it.
 *
 * What this panel does NOT do (Pass 2 / Phase 3a.2):
 *   - Per-block inline visual diff inside the TipTap editor (red strike
 *     on removed, green border on added). Requires custom decorations
 *     keyed by block id; bigger lift, deferred.
 *   - Per-block Accept / Discard. Today: whole-draft Commit / Discard
 *     (the existing editor's Commit button + this panel's Discard).
 *   - Streaming token output. The endpoint is request/response.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Send, Sparkles, X, ChevronDown, ChevronUp, Highlighter } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

type ChangeKind = 'added' | 'removed' | 'changed';
type SampleChange =
  | { kind: 'added'; id: string; blockKind: string; preview: string }
  | { kind: 'removed'; id: string; blockKind: string; preview: string }
  | { kind: 'changed'; id: string; blockKind: string; fromPreview: string; toPreview: string };

type AssistReply = {
  reply: string;
  diff: {
    added: number;
    removed: number;
    changed: number;
    unchangedCount: number;
    sample: SampleChange[];
  };
  hasDraft: boolean;
};

type Message =
  | { role: 'user'; text: string }
  | { role: 'assistant'; data: AssistReply };

export function AiAssistPanel({
  pageId,
  focusBlockIds = [],
  onChanged,
  onClearMarks,
  onClose,
  onPendingChange,
}: {
  pageId: string;
  /** Block ids the user marked via the gutter focus marker. When non-empty,
   *  Pages is told to operate ONLY on these blocks and leave the rest
   *  byte-for-byte. */
  focusBlockIds?: string[];
  /** Called after Pages successfully edits the draft, so the parent can
   *  refresh the editor's content from the server. */
  onChanged: () => void;
  /** Clear the gutter marks (offered after a focused edit). */
  onClearMarks?: () => void;
  /** Collapse the panel. The parent re-renders without it. */
  onClose: () => void;
  /** Bubbles up the pending state so the parent can lock the editor
   *  while Pages is running (prevents the race where user typing
   *  lands in draft_doc while Pages is computing on a stale baseline,
   *  then gets clobbered by Pages's saveDraft). */
  onPendingChange?: (pending: boolean) => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const toast = useToast();

  // Bubble the pending flag up so the parent can lock the editor while
  // the AI call is in flight. The cleanup releases the lock on unmount
  // (defensive — should never fire while pending, but if the user closes
  // the panel mid-call the editor must come back unlocked).
  useEffect(() => {
    onPendingChange?.(pending);
    return () => onPendingChange?.(false);
  }, [pending, onPendingChange]);

  const submit = useCallback(async () => {
    const prompt = draft.trim();
    if (!prompt || pending) return;
    setMessages((m) => [...m, { role: 'user', text: prompt }]);
    setDraft('');
    setPending(true);
    try {
      const res = await fetch(`/api/pages/${pageId}/ai-assist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          focusBlockIds: focusBlockIds.length ? focusBlockIds : undefined,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as
        | { ok: true; reply: string; diff: AssistReply['diff']; hasDraft: boolean }
        | { error: string };
      if (!res.ok || !('ok' in json)) {
        const err = 'error' in json ? json.error : `request failed (${res.status})`;
        setMessages((m) => [
          ...m,
          { role: 'assistant', data: { reply: `⚠ ${err}`, diff: { added: 0, removed: 0, changed: 0, unchangedCount: 0, sample: [] }, hasDraft: false } },
        ]);
        return;
      }
      setMessages((m) => [
        ...m,
        { role: 'assistant', data: { reply: json.reply, diff: json.diff, hasDraft: json.hasDraft } },
      ]);
      // If Pages actually changed something, tell the parent so the
      // editor refreshes from the new draft.
      const total = json.diff.added + json.diff.changed + json.diff.removed;
      if (total > 0) onChanged();
    } finally {
      setPending(false);
      // Defer scroll to next tick so the new message is in the DOM.
      requestAnimationFrame(() => {
        if (scrollerRef.current) scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
      });
    }
  }, [draft, pending, pageId, focusBlockIds, onChanged]);

  const discardDraft = useCallback(async () => {
    if (discarding) return;
    setDiscarding(true);
    try {
      const res = await fetch(`/api/pages/${pageId}/discard-draft`, { method: 'POST' });
      if (!res.ok) {
        toast.error('Could not discard draft');
        return;
      }
      toast.success('Draft discarded — page reverted to last commit');
      onChanged();
    } finally {
      setDiscarding(false);
    }
  }, [pageId, discarding, onChanged, toast]);

  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-l border-border bg-card">
      {/* ── Header ──────────────────────────────────────────────────── */}
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary" />
          <span className="text-sm font-semibold">AI assist</span>
        </div>
        <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Close panel">
          <X />
        </Button>
      </header>

      {/* ── Chat / message list ─────────────────────────────────────── */}
      <div
        ref={scrollerRef}
        className="flex-1 min-h-0 overflow-y-auto scrollbar-thin space-y-3 p-3"
      >
        {messages.length === 0 && (
          <div className="rounded-md border border-dashed border-border bg-background/50 p-3 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">Ask Pages to edit this page.</p>
            <p className="mt-1">
              Examples:{' '}
              <em>&ldquo;Add callouts around the key quotes.&rdquo;</em>{' '}
              <em>&ldquo;Convert section 2 into two columns.&rdquo;</em>{' '}
              <em>&ldquo;Add a TOC at the top.&rdquo;</em>
            </p>
            <p className="mt-2">
              Edits land in a <strong>draft</strong> — the live page only changes when
              you press <strong>Commit</strong> in the editor.
            </p>
          </div>
        )}
        {messages.map((m, i) => (m.role === 'user' ? <UserBubble key={i} text={m.text} /> : <AssistantBubble key={i} data={m.data} />))}
        {pending && <PendingIndicator />}
      </div>

      {/* ── Draft controls ─────────────────────────────────────────── */}
      {messages.some((m) => m.role === 'assistant' && (m.data.diff.added + m.data.diff.changed + m.data.diff.removed > 0)) && (
        <div className="border-t border-border bg-background/40 px-3 py-2 text-xs">
          <p className="text-muted-foreground">
            Editor is showing the draft. Use the toolbar to <strong>Commit</strong> when ready, or revert below.
          </p>
          <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
            ⚠ Revert wipes the <strong>entire draft</strong> — both Pages&apos; changes AND
            any unsaved typing of yours. Per-block discard is queued for Phase 3a.2.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2 w-full text-destructive"
            onClick={discardDraft}
            disabled={discarding}
          >
            {discarding ? 'Reverting…' : 'Revert draft to last commit'}
          </Button>
        </div>
      )}

      {/* ── Focus marker banner ─────────────────────────────────────── */}
      {focusBlockIds.length > 0 && (
        <div className="flex items-center justify-between gap-2 border-t border-border bg-primary/5 px-3 py-2 text-xs">
          <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
            <Highlighter className="size-3.5 text-primary" />
            Focusing {focusBlockIds.length} marked section{focusBlockIds.length === 1 ? '' : 's'}
          </span>
          {onClearMarks && (
            <button
              type="button"
              className="text-muted-foreground underline-offset-2 hover:underline"
              onClick={onClearMarks}
            >
              Clear
            </button>
          )}
        </div>
      )}

      {/* ── Input row ───────────────────────────────────────────────── */}
      <form
        className="flex items-end gap-2 border-t border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={
            focusBlockIds.length > 0
              ? 'What should Pages do to the marked sections?'
              : 'What should Pages do to this page?'
          }
          rows={2}
          className="min-h-[3rem] resize-none text-sm"
          disabled={pending}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <Button
          type="submit"
          size="icon"
          disabled={!draft.trim() || pending}
          aria-label="Send to Pages"
        >
          <Send />
        </Button>
      </form>
    </aside>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────

function UserBubble({ text }: { text: string }) {
  return (
    <div className="ml-6 rounded-md border border-border bg-background/60 p-2 text-sm">
      {text}
    </div>
  );
}

function AssistantBubble({ data }: { data: AssistReply }) {
  const total = data.diff.added + data.diff.changed + data.diff.removed;
  return (
    <div className="mr-6 space-y-2">
      <div className="rounded-md border border-primary/30 bg-primary/5 p-2 text-sm">
        <p className="whitespace-pre-wrap">{data.reply}</p>
      </div>
      {total > 0 && <DiffSummary diff={data.diff} />}
      {total === 0 && data.hasDraft && (
        <p className="text-[11px] italic text-muted-foreground">
          No new changes this turn — a draft from earlier is still in place.
        </p>
      )}
      {total === 0 && !data.hasDraft && (
        <p className="text-[11px] italic text-muted-foreground">
          No changes were made to the page.
        </p>
      )}
    </div>
  );
}

function DiffSummary({ diff }: { diff: AssistReply['diff'] }) {
  const [expanded, setExpanded] = useState(false);
  const total = diff.added + diff.changed + diff.removed;
  return (
    <div className="rounded-md border border-border bg-background/40 p-2 text-[11px]">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="font-medium">
          {total} block{total === 1 ? '' : 's'} changed in draft
          <span className="ml-1 text-muted-foreground">
            ({diff.changed} edited · {diff.added} added · {diff.removed} removed · {diff.unchangedCount} unchanged)
          </span>
        </span>
        {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
      </button>
      {expanded && diff.sample.length > 0 && (
        <ul className="mt-2 space-y-1.5 border-t border-border pt-2">
          {diff.sample.map((c) => (
            <li key={c.id} className="flex gap-2">
              <ChangeChip kind={c.kind} />
              <div className="min-w-0 flex-1">
                <code className="text-[10px] text-muted-foreground">{c.blockKind}</code>
                {c.kind === 'changed' ? (
                  <>
                    <div className="truncate text-destructive line-through opacity-70">{c.fromPreview || '—'}</div>
                    <div className="truncate text-emerald-700 dark:text-emerald-300">{c.toPreview || '—'}</div>
                  </>
                ) : (
                  <div className={cn('truncate', c.kind === 'added' ? 'text-emerald-700 dark:text-emerald-300' : 'text-destructive line-through opacity-70')}>
                    {c.preview || '—'}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ChangeChip({ kind }: { kind: ChangeKind }) {
  const cls =
    kind === 'added'
      ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
      : kind === 'removed'
        ? 'bg-destructive/15 text-destructive'
        : 'bg-amber-500/15 text-amber-700 dark:text-amber-300';
  const label = kind === 'added' ? '+' : kind === 'removed' ? '−' : '~';
  return (
    <span className={cn('inline-flex size-4 shrink-0 items-center justify-center rounded text-[10px] font-bold', cls)}>
      {label}
    </span>
  );
}

function PendingIndicator() {
  return (
    <div className="mr-6 flex items-center gap-2 rounded-md border border-border bg-background/40 p-2 text-xs text-muted-foreground">
      <Sparkles className="size-3 animate-pulse" />
      Pages is thinking…
    </div>
  );
}
