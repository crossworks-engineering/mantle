'use client';

import * as React from 'react';
import { useFormStatus } from 'react-dom';
import { Loader2 } from 'lucide-react';
import { Button, type ButtonProps } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Drop-in replacement for <Button type="submit">. Reads the enclosing
 * form's pending state via React 19's useFormStatus and:
 *   - disables the button while the server action is in flight
 *   - overlays a spinner on top of the (invisible) label so the width
 *     stays the same, no layout shift
 *   - sets aria-busy for screen readers
 *
 * Must be a descendant of a <form action={…}> to do anything useful.
 */
export function SubmitButton({
  children,
  className,
  disabled,
  ...rest
}: ButtonProps) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      disabled={pending || disabled}
      aria-busy={pending || undefined}
      className={cn('relative', className)}
      {...rest}
    >
      <span className={pending ? 'invisible' : 'inline-flex items-center'}>{children}</span>
      {pending && (
        <Loader2
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 animate-spin"
          aria-hidden
        />
      )}
    </Button>
  );
}
