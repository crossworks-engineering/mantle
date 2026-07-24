'use client';

import * as React from 'react';
import { useFormStatus } from 'react-dom';
import { Loader2 } from 'lucide-react';
import { Button, type ButtonProps } from './button';

export interface SubmitButtonProps extends ButtonProps {
  /**
   * Busy state for client-side forms (those that submit via `fetch` +
   * `useState`/`useTransition` rather than a server action). When provided it
   * drives the spinner + disabled state. When omitted, the button falls back
   * to the enclosing `<form action={…}>`'s pending state via React 19's
   * `useFormStatus` — so server-action forms can pass nothing.
   */
  pending?: boolean;
}

/**
 * The standard form submit button (see docs/ui-style-guide.md §6). Always
 * carries a descriptive **verb + noun** label — "Save agent", "Create event",
 * "Save profile" — never a bare "Save" and never a text-swap to "Saving…".
 * While the submit is in flight it disables itself and shows a leading
 * spinner; the label stays put so the user reads what's being saved.
 *
 * Drop-in for `<Button type="submit">`. Two ways to drive the busy state:
 *   - client forms:        `<SubmitButton pending={saving}>Save agent</SubmitButton>`
 *   - server-action forms: `<SubmitButton>Save</SubmitButton>` (reads useFormStatus)
 */
export function SubmitButton({ children, disabled, pending, ...rest }: SubmitButtonProps) {
  const formStatus = useFormStatus();
  const busy = pending ?? formStatus.pending;
  return (
    <Button type="submit" disabled={busy || disabled} aria-busy={busy || undefined} {...rest}>
      {busy && <Loader2 className="animate-spin" aria-hidden />}
      {children}
    </Button>
  );
}
