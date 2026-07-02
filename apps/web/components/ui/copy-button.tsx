'use client';

import { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { copyText } from '@/lib/secure-context-fallbacks';

/** A copy-to-clipboard button that flips to a check for ~1.2s. Used by the
 *  Local Network status page + the Connect-a-device guide. */
export function CopyButton({
  value,
  label,
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={className ?? 'h-7 gap-1.5 px-2 text-xs'}
      onClick={async () => {
        if (await copyText(value)) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } else {
          toast.error('Could not copy to clipboard');
        }
      }}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {label ?? (copied ? 'Copied' : 'Copy')}
    </Button>
  );
}

/** A code/snippet block with a copy button pinned top-right. Monospace, scrolls
 *  horizontally, preserves whitespace. */
export function CopyBlock({ code }: { code: string }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 pr-20 text-xs leading-relaxed">
        <code>{code}</code>
      </pre>
      <div className="absolute right-2 top-2">
        <CopyButton value={code} />
      </div>
    </div>
  );
}
