'use client';

import { useActionState, useState } from 'react';
import { Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { addManualDecision, type ManualDecisionResult } from './actions';

const initial: ManualDecisionResult | undefined = undefined;

/**
 * Pre-approve or pre-deny a sender (full address) or domain that hasn't
 * been seen yet. The input intentionally accepts either shape — anything
 * with `@` becomes an address rule, anything without becomes a domain rule.
 *
 * Controlled input so React 19's post-action form.reset() doesn't blow
 * away what was just typed (matches the IMAP form fix).
 */
export function ManualEntry() {
  const [state, formAction, pending] = useActionState(addManualDecision, initial);
  const [input, setInput] = useState('');

  // Clear the field on a successful submit; keep it on error so the user
  // can fix the typo.
  if (state?.ok && input !== '') {
    queueMicrotask(() => setInput(''));
  }

  return (
    <form action={formAction} className="space-y-2 rounded-md border border-border bg-muted/20 p-3">
      <div className="flex gap-2">
        <Input
          name="input"
          placeholder="friend@example.com   or   noisy.com   or   @anthropic.com"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          autoComplete="off"
          className="h-9"
        />
        <Button type="submit" name="status" value="approved" disabled={pending || !input.trim()}>
          {pending ? '…' : 'Approve'}
        </Button>
        <Button
          type="submit"
          name="status"
          value="denied"
          variant="outline"
          disabled={pending || !input.trim()}
        >
          {pending ? '…' : 'Deny'}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Type an address to decide just that sender, or a domain (with or without the leading
        <code className="mx-1 rounded bg-background px-1 font-mono">@</code>) to set a rule covering every
        address on it. Approving auto-backfills the last 90 days.
      </p>
      <ResultPanel state={state} />
    </form>
  );
}

function ResultPanel({ state }: { state: ManualDecisionResult | undefined }) {
  if (!state) return null;
  if (state.ok === false) {
    return (
      <div className="flex items-start gap-1.5 text-xs text-destructive">
        <X className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>{state.error}</span>
      </div>
    );
  }
  const verb = state.status === 'approved' ? 'Approved' : 'Denied';
  return (
    <div className="flex items-start gap-1.5 text-xs text-green-900 dark:text-green-100">
      <Check className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>
        {verb}{' '}
        {state.kind === 'address' ? (
          <>
            <span className="font-medium">{state.target}</span>
            {state.status === 'approved' && '. Backfill queued.'}
          </>
        ) : (
          <>
            <span className="font-medium">@{state.target}</span>
            {state.cascadedCount > 0
              ? `. Moved ${state.cascadedCount} existing pending sender${state.cascadedCount === 1 ? '' : 's'} into ${state.status === 'approved' ? 'Approved' : 'Denied'}.`
              : '. No existing pending senders matched.'}
            {state.status === 'approved' && state.cascadedCount > 0 && ' Backfills queued.'}
          </>
        )}
      </span>
    </div>
  );
}
