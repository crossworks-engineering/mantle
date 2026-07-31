import * as React from 'react';
import { cn } from '../lib/utils';

/** Id convention shared with the field it describes, so the input can point at
 *  the hint with `aria-describedby={hintId('historyLimit')}`. */
export function hintId(fieldId: string) {
  return `${fieldId}-hint`;
}

export interface FieldHintProps {
  /** The `id` of the field this describes — becomes `<id>-hint`. Pair it with
   *  `aria-describedby={hintId(id)}` on the input. */
  id?: string;
  /** The cost of overdoing it: rendered after the description in `warning-ink`.
   *  Only for fields where excess actually bites — money, load, or answer
   *  quality. Most fields want a plain description and nothing here. */
  warn?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}

/** The one-line dimmed description under a settings field. Says what the field
 *  does; `warn` adds the consequence of pushing it too far, in a second tone. */
export function FieldHint({ id, warn, className, children }: FieldHintProps) {
  return (
    <p id={id ? hintId(id) : undefined} className={cn('text-xs text-muted-foreground', className)}>
      {children}
      {warn ? (
        <>
          {children ? ' ' : null}
          <span className="text-warning-ink">{warn}</span>
        </>
      ) : null}
    </p>
  );
}
