'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, Check, HelpCircle, Wallet, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { SubmitButton } from '@/components/ui/submit-button';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import {
  ASK_HUMAN_SLUG,
  fmtRelative,
  parseForm,
  RUN_BUDGET_SLUG,
  str,
  stringOptions,
  type Decide,
  type FormAnswer,
  type FormQuestion,
  type PendingRow,
} from './types';

/**
 * The answer surface for a question the system is blocked on — a runner
 * `ask_human` gate or a `run_budget` pause.
 *
 * ONE renderer, three homes: /pending, the assistant panel, and anywhere else
 * a blocked run should be answerable. It renders three shapes from the same
 * row, in descending richness:
 *
 *   1. `args.form`     — a questionnaire: up to 4 sub-questions, each with
 *                        option cards and an "Other" free-text escape.
 *   2. `args.options`  — a flat pick-one: one-click chips (each chip answers).
 *   3. neither         — free text, or a bare approve/reject.
 *
 * A `run_budget` row is the degenerate case with consequence-named actions
 * ("Raise budget" / "Cancel run") — the operator must never have to infer
 * what Approve means when money is involved.
 */
/** In-progress answers, held by the CALLER so they outlive the card. */
export type CardDraft = {
  picked: Record<string, string[]>;
  other: Record<string, string>;
  /** Which questions have the free-text escape open. */
  otherOpen: Record<string, boolean>;
  freeText: string;
};

export function QuestionnaireCard({
  row,
  decide,
  busy,
  compact = false,
  draft,
  onDraftChange,
}: {
  row: PendingRow;
  decide: Decide;
  busy: boolean;
  /** Tighter spacing + no meta line — for the assistant panel column. */
  compact?: boolean;
  /** Previously-entered answers to restore (see `onDraftChange`). */
  draft?: CardDraft;
  /** Report every keystroke/pick so the caller can restore it if this card
   *  unmounts before it is submitted. Omit on surfaces where the card never
   *  disappears out from under the operator. */
  onDraftChange?: (draft: CardDraft) => void;
}) {
  const isBudget = row.toolSlug === RUN_BUDGET_SLUG;
  const isAsk = row.toolSlug === ASK_HUMAN_SLUG;
  const question = str(row.args?.['question']);
  const runId = str(row.args?.['run_id']);
  const form = useMemo(() => (isAsk ? parseForm(row.args?.['form']) : null), [isAsk, row.args]);
  const flatOptions = isAsk && !form ? stringOptions(row.args?.['options']) : [];

  // Per-question selections. Single-select keeps one entry; multi toggles.
  // SEEDED FROM (and mirrored back to) the caller's draft store, so a card
  // that unmounts — because a newer question pushed it out of the strip's
  // visible slice — does not silently throw away half a filled-in form.
  const [picked, setPicked] = useState<Record<string, string[]>>(() => draft?.picked ?? {});
  const [other, setOther] = useState<Record<string, string>>(() => draft?.other ?? {});
  // Which questions have the "Other…" escape OPEN. Its own map on purpose: an
  // in-band sentinel stored among the picked labels collides with a real
  // option that happens to carry the sentinel's text.
  const [otherOpen, setOtherOpen] = useState<Record<string, boolean>>(() => draft?.otherOpen ?? {});
  const [freeText, setFreeText] = useState(() => draft?.freeText ?? '');

  // Mirror on every change rather than on unmount: React does not guarantee a
  // cleanup runs before the parent discards the subtree in every path.
  const remember = (next: Partial<CardDraft>) =>
    onDraftChange?.({ picked, other, otherOpen, freeText, ...next });

  const toggleOther = (q: FormQuestion) => {
    setOtherOpen((prev) => {
      const next = { ...prev, [q.id]: !prev[q.id] };
      remember({ otherOpen: next });
      return next;
    });
    // Single-select: opening "Other" IS the answer, so clear any chip pick
    // (and vice versa in `toggle`) — otherwise both read as chosen.
    if (!q.multi_select && !otherOpen[q.id]) {
      setPicked((prev) => {
        const next = { ...prev, [q.id]: [] };
        remember({ picked: next });
        return next;
      });
    }
  };

  const toggle = (q: FormQuestion, label: string) => {
    setPicked((prev) => {
      const current = prev[q.id] ?? [];
      const next = q.multi_select
        ? {
            ...prev,
            [q.id]: current.includes(label)
              ? current.filter((l) => l !== label)
              : [...current, label],
          }
        : // Single-select: clicking the chosen option again clears it, so a
          // mis-click is recoverable without a reset button.
          { ...prev, [q.id]: current[0] === label ? [] : [label] };
      remember({ picked: next });
      return next;
    });
    // Picking a chip closes a single-select question's "Other" escape.
    if (!q.multi_select && otherOpen[q.id]) {
      setOtherOpen((prev) => {
        const next = { ...prev, [q.id]: false };
        remember({ otherOpen: next });
        return next;
      });
    }
  };

  // Answerable when every question has a selection, or "Other" text.
  const answers: FormAnswer[] = useMemo(() => {
    if (!form) return [];
    return form.questions.map((q) => {
      const sel = picked[q.id] ?? [];
      const otherText = otherOpen[q.id] ? (other[q.id] ?? '').trim() : '';
      return { question: q.id, selected: sel, ...(otherText ? { other: otherText } : {}) };
    });
  }, [form, picked, other, otherOpen]);

  const formComplete =
    !!form && answers.every((a) => a.selected.length > 0 || (a.other ?? '').length > 0);

  const submitForm = () => {
    if (!formComplete || busy) return;
    void decide(row.id, 'approve', { answers });
  };

  const Icon = isBudget ? Wallet : HelpCircle;

  return (
    <div className={cn('space-y-3', compact ? 'px-3 py-3' : 'px-3 py-3.5')}>
      {/* A bounced decision (settle-revert): the previous answer did NOT take
          effect and must be re-made. Loud + first so it can't be missed. */}
      {row.error && (
        <p className="flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>
            <strong className="font-semibold">Previous decision bounced — decide again.</strong>{' '}
            {row.error}
          </span>
        </p>
      )}

      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium leading-snug text-foreground">
            {question ?? (isBudget ? 'A run is paused on its budget.' : 'A run needs an answer.')}
          </p>
          {/* Even compact keeps the run link: three questions from three
              different runs are otherwise indistinguishable in the strip. */}
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {!compact && (
              <>
                <span>{isBudget ? 'Budget decision' : 'Question'}</span>
                <span aria-hidden>·</span>
              </>
            )}
            <span>queued {fmtRelative(row.createdAt)}</span>
            {runId && (
              <Link href={`/runs?run=${runId}`} className="underline hover:text-foreground">
                ↗ run
              </Link>
            )}
          </p>
        </div>
      </div>

      {/* ── 1. Structured questionnaire ─────────────────────────────────── */}
      {form && (
        <div className="space-y-3">
          {form.questions.map((q) => {
            const sel = picked[q.id] ?? [];
            const otherOn = !!otherOpen[q.id];
            return (
              <fieldset key={q.id} className="space-y-1.5">
                <legend className="flex flex-wrap items-baseline gap-2">
                  {q.header && (
                    <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {q.header}
                    </span>
                  )}
                  <span className="text-sm text-foreground">{q.question}</span>
                  {q.multi_select && (
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      pick any
                    </span>
                  )}
                </legend>
                {/* An exclusive choice is a RADIO GROUP, not a bank of
                    independent toggles: aria-pressed on N buttons tells a
                    screen-reader user nothing about them being mutually
                    exclusive. */}
                <div
                  className="grid gap-1.5 sm:grid-cols-2"
                  role={q.multi_select ? 'group' : 'radiogroup'}
                  aria-label={q.question}
                >
                  {q.options.map((opt) => {
                    const on = sel.includes(opt.label);
                    return (
                      <button
                        key={opt.label}
                        type="button"
                        onClick={() => toggle(q, opt.label)}
                        disabled={busy}
                        role={q.multi_select ? 'checkbox' : 'radio'}
                        aria-checked={on}
                        className={cn(
                          'flex flex-col items-start gap-0.5 rounded-md border px-2.5 py-2 text-left text-sm transition-colors disabled:opacity-60',
                          on
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-border bg-card text-foreground hover:bg-accent hover:text-accent-foreground',
                        )}
                      >
                        <span className="flex w-full items-center gap-1.5 font-medium">
                          {on && <Check className="size-3.5 shrink-0" aria-hidden />}
                          <span className="min-w-0 flex-1 break-words">{opt.label}</span>
                        </span>
                        {opt.description && (
                          <span
                            className={cn(
                              'text-xs',
                              on ? 'text-primary-foreground/80' : 'text-muted-foreground',
                            )}
                          >
                            {opt.description}
                          </span>
                        )}
                      </button>
                    );
                  })}
                  {q.allow_other !== false && (
                    <button
                      type="button"
                      onClick={() => toggleOther(q)}
                      disabled={busy}
                      role={q.multi_select ? 'checkbox' : 'radio'}
                      aria-checked={otherOn}
                      className={cn(
                        'rounded-md border border-dashed px-2.5 py-2 text-left text-sm transition-colors disabled:opacity-60',
                        otherOn
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border bg-card text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                      )}
                    >
                      Other…
                    </button>
                  )}
                </div>
                {otherOn && (
                  <Textarea
                    value={other[q.id] ?? ''}
                    onChange={(e) =>
                      setOther((p) => {
                        const next = { ...p, [q.id]: e.target.value };
                        remember({ other: next });
                        return next;
                      })
                    }
                    placeholder="Your answer…"
                    maxLength={2000}
                    rows={2}
                    disabled={busy}
                    aria-label={`Other answer for: ${q.question}`}
                  />
                )}
              </fieldset>
            );
          })}
          <div className="flex flex-wrap gap-2">
            <SubmitButton
              pending={busy}
              disabled={!formComplete}
              size="sm"
              onClick={submitForm}
              type="button"
            >
              <Check /> Answer &amp; continue
            </SubmitButton>
            <Button
              onClick={() => decide(row.id, 'reject')}
              disabled={busy}
              size="sm"
              variant="ghost"
            >
              <X /> Reject
            </Button>
          </div>
        </div>
      )}

      {/* ── 2. Flat pick-one: each chip IS the answer ───────────────────── */}
      {!form && flatOptions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {flatOptions.map((opt) => (
            <Button
              key={opt}
              onClick={() => decide(row.id, 'approve', { answer: opt })}
              disabled={busy}
              size="sm"
              variant="outline"
            >
              {opt}
            </Button>
          ))}
        </div>
      )}

      {/* ── 3. Free text (ask_human without a form) ─────────────────────── */}
      {isAsk && !form && (
        <form
          // Wraps on narrow screens: side by side the input collapsed to
          // ~120px on mobile, too small to read what you typed.
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const a = freeText.trim();
            if (!a) return;
            void decide(row.id, 'approve', { answer: a });
            setFreeText('');
          }}
        >
          <Input
            value={freeText}
            onChange={(e) => {
              setFreeText(e.target.value);
              remember({ freeText: e.target.value });
            }}
            placeholder="Type an answer…"
            maxLength={4000}
            disabled={busy}
            className="h-9 min-w-48 flex-1"
          />
          <SubmitButton pending={busy} disabled={!freeText.trim()} size="sm">
            <Check /> Answer &amp; approve
          </SubmitButton>
        </form>
      )}

      {/* Plain decision buttons. A form supplies its own submit above, so
          they'd be a second, ambiguous way to answer — omit them there. */}
      {!form && (
        <div className="flex gap-2">
          {/* Semantic action colours come from TOKENS (style guide §2):
              affirmative = primary, the destructive arm = destructive.
              A literal emerald/red ignores the ~40 themes. */}
          <Button onClick={() => decide(row.id, 'approve')} disabled={busy} size="sm">
            <Check /> {isBudget ? 'Raise budget' : 'Approve'}
          </Button>
          <Button
            onClick={() => decide(row.id, 'reject')}
            disabled={busy}
            size="sm"
            variant={isBudget ? 'destructive' : 'outline'}
          >
            <X /> {isBudget ? 'Cancel run' : 'Reject'}
          </Button>
        </div>
      )}
    </div>
  );
}
