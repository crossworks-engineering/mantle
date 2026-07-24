'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from './ui/button';
import { cn } from './lib/utils';
import { copyText } from './lib/secure-context-fallbacks';

/**
 * A compact "copy to clipboard" button with inline confirm feedback (the icon +
 * label flip to a check for ~1.5s, then revert). Used on each assistant response
 * block so a reply can be lifted out and pasted elsewhere in one click.
 *
 * Inline feedback (not a toast) is deliberate: copying is a frequent micro-action
 * and a toast per copy would be noisy. Copies the raw text passed in (the reply's
 * Markdown source) — the most portable thing to paste into another editor.
 */
export function CopyButton({
  text,
  className,
  label = 'Copy',
}: {
  /** The text placed on the clipboard. */
  text: string;
  className?: string;
  /** Idle label; swaps to "Copied" on success. */
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear a pending revert if the component unmounts mid-confirm.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const onCopy = useCallback(async () => {
    if (await copyText(text)) {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    }
    // On failure leave the idle state; nothing to recover, the user can
    // select-and-copy manually.
  }, [text]);

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onCopy}
      aria-label={copied ? 'Copied' : 'Copy response'}
      className={cn(
        'h-6 gap-1 px-1.5 text-[10px] font-normal text-muted-foreground hover:text-foreground',
        className,
      )}
    >
      {copied ? <Check className="size-3" aria-hidden /> : <Copy className="size-3" aria-hidden />}
      {copied ? 'Copied' : label}
    </Button>
  );
}
