'use client';

import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { Download, FileText } from 'lucide-react';
import { formatBytes } from '@mantle/web-ui/lib/format-bytes';

/**
 * Download chip for an embedded file. Read-only chrome (the node is an atom) —
 * clicking opens the raw-serve route in a new tab. Themed via tokens so it
 * tracks the active theme like the rest of the document.
 */
export function FileEmbedView({ node }: NodeViewProps) {
  const href = typeof node.attrs.href === 'string' ? node.attrs.href : undefined;
  const filename = typeof node.attrs.filename === 'string' ? node.attrs.filename : 'file';
  const size = typeof node.attrs.size === 'number' ? node.attrs.size : null;
  return (
    <NodeViewWrapper className="my-3" data-drag-handle>
      <a
        href={href ?? '#'}
        target="_blank"
        rel="noreferrer"
        contentEditable={false}
        className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 p-3 no-underline transition-colors hover:bg-accent/40"
      >
        <FileText className="size-5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">{filename}</span>
          {size != null && (
            <span className="block text-xs text-muted-foreground">{formatBytes(size)}</span>
          )}
        </span>
        <Download className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </a>
    </NodeViewWrapper>
  );
}
