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
 * The per-block inline visual diff (red ghosts for removed, green/amber
 * borders for added/changed) + per-block Discard/Restore now live in the
 * editor's "Review" mode (Phase 3a Pass 2, auto-enabled after a run; see
 * diff-review.ts). This panel keeps the whole-draft Revert (reject all);
 * the editor's Commit accepts all.
 *
 * What this panel still does NOT do:
 *   - Streaming token output. The endpoint is request/response.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { CornerDownLeft, Sparkles, X, ChevronDown, ChevronUp, Highlighter } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { apiSend, ApiError } from '@/lib/api-fetch';
import { AssistAgentPicker } from '@/components/assist-agent-picker';
import { useAssistStage, SpecialistWorking } from '@/components/specialist-working';
import { ChatBubble } from '@/components/chat-bubble';

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
   *  refresh the editor's content from the server. Receives the block ids that
   *  now differ from the committed doc (for the green "edited" highlight);
   *  called with [] on discard so the parent clears it. */
  onChanged: (changedBlockIds?: string[]) => void;
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
  // The picker can repoint Assist at a different agent; reflect its name in the
  // copy + the assistant bubbles. null (the default) falls back to "Pages".
  const [pickedName, setPickedName] = useState<string | null>(null);
  const displayName = pickedName ?? 'Pages';
  // Live "what is Pages doing" label, polled while a run is in flight.
  const stage = useAssistStage('/api/assist/stage?surface=pages', pending);

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
      const json = await apiSend<
        | {
            ok: true;
            reply: string;
            changedBlockIds?: string[];
            diff: AssistReply['diff'];
            hasDraft: boolean;
          }
        | { error: string }
      >(`/api/pages/${pageId}/ai-assist`, 'POST', {
        prompt,
        focusBlockIds: focusBlockIds.length ? focusBlockIds : undefined,
      });
      if (!('ok' in json)) {
        setMessages((m) => [
          ...m,
          { role: 'assistant', data: { reply: `⚠ ${json.error}`, diff: { added: 0, removed: 0, changed: 0, unchangedCount: 0, sample: [] }, hasDraft: false } },
        ]);
        return;
      }
      setMessages((m) => [
        ...m,
        { role: 'assistant', data: { reply: json.reply, diff: json.diff, hasDraft: json.hasDraft } },
      ]);
      // If Pages actually changed something, tell the parent so the
      // editor refreshes from the new draft + highlights the edited blocks.
      const total = json.diff.added + json.diff.changed + json.diff.removed;
      if (total > 0) onChanged(json.changedBlockIds ?? []);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return; // already bounced to /login
      const err = e instanceof Error ? e.message : 'request failed';
      setMessages((m) => [
        ...m,
        { role: 'assistant', data: { reply: `⚠ ${err}`, diff: { added: 0, removed: 0, changed: 0, unchangedCount: 0, sample: [] }, hasDraft: false } },
      ]);
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
      await apiSend(`/api/pages/${pageId}/discard-draft`, 'POST');
      toast.success('Draft discarded — page reverted to last commit');
      onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return; // already bounced to /login
      toast.error(e instanceof Error ? e.message : 'Could not discard draft');
    } finally {
      setDiscarding(false);
    }
  }, [pageId, discarding, onChanged, toast]);

  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-l border-border bg-card">
      {/* ── Header ──────────────────────────────────────────────────── */}
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Sparkles className="size-4 shrink-0 text-primary" />
          {/* Which agent handles page-assist is configurable here, on the
              surface itself; defaults to the Pages specialist. */}
          <AssistAgentPicker
            surface="pages"
            defaultLabel="Pages (default)"
            onAgentNameChange={setPickedName}
          />
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
        {messages.map((m, i) => (m.role === 'user' ? <UserBubble key={i} text={m.text} /> : <AssistantBubble key={i} data={m.data} agentName={displayName} />))}
        {pending && <SpecialistWorking stage={stage} agentName={displayName} />}
      </div>

      {/* ── Draft controls ─────────────────────────────────────────── */}
      {messages.some((m) => m.role === 'assistant' && (m.data.diff.added + m.data.diff.changed + m.data.diff.removed > 0)) && (
        <div className="border-t border-border bg-background/40 px-3 py-2 text-xs">
          <p className="text-muted-foreground">
            Editor is showing the draft. Use the toolbar to <strong>Commit</strong> when ready, or revert below.
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            To accept or reject <strong>individual</strong> changes, use{' '}
            <strong>Review</strong> in the toolbar (per-block Discard / Restore). Revert
            below wipes the <strong>entire draft</strong> — Pages&apos; changes AND any
            unsaved typing of yours.
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
            // Enter sends; Shift+Enter inserts a newline. Ignore Enter while an
            // IME composition is in flight (don't send a half-typed CJK word).
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
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
          title="Send (Enter · Shift+Enter for a new line)"
        >
          <CornerDownLeft />
        </Button>
      </form>
    </aside>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────

function UserBubble({ text }: { text: string }) {
  return <ChatBubble role="user">{text}</ChatBubble>;
}

function AssistantBubble({ data, agentName }: { data: AssistReply; agentName: string }) {
  const total = data.diff.added + data.diff.changed + data.diff.removed;
  return (
    <div className="space-y-2">
      <ChatBubble role="assistant" agentName={agentName}>
        {data.reply}
      </ChatBubble>
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
