'use client';

import { useState } from 'react';
import { Check, Copy, FileCode2 } from 'lucide-react';
import { Button } from '@mantle/web-ui/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@mantle/web-ui/ui/dialog';
import { useToast } from '@mantle/web-ui/ui/toast';
// Browser-safe LEAF, not the @mantle/content barrel (server-only deps there).
import { docToMarkdown } from '@mantle/content/doc-to-markdown';

/**
 * Read-only markdown view of the page as it stands RIGHT NOW — the editor's
 * live doc (draft edits included), serialized through the same `docToMarkdown`
 * agents and exports use. The dialect principle made visible: every page is
 * inspectable as the human-legible markdown it round-trips through. View +
 * copy only; markdown *editing* is a separate feature (a few app-native nodes
 * — file embeds, sub-page cards, mentions — don't round-trip losslessly yet).
 */
export function MarkdownDialog({ getDoc }: { getDoc: () => unknown }) {
  const toast = useToast();
  const [markdown, setMarkdown] = useState('');
  const [copied, setCopied] = useState(false);

  return (
    <Dialog
      onOpenChange={(open) => {
        if (open) {
          setMarkdown(docToMarkdown(getDoc()));
          setCopied(false);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" title="View this page as markdown">
          <FileCode2 />
          <span className="hidden sm:inline">Markdown</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Markdown</DialogTitle>
          <DialogDescription>
            The page as rich markdown — the same text agents read and write, and what the Markdown
            export downloads. Includes your unsaved draft edits.
          </DialogDescription>
        </DialogHeader>
        <pre className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-muted/30 p-4 font-mono text-sm whitespace-pre-wrap text-foreground scrollbar-thin">
          {markdown || '(empty page)'}
        </pre>
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(markdown);
                setCopied(true);
                toast.success('Markdown copied');
              } catch {
                toast.error('Copy failed');
              }
            }}
          >
            {copied ? <Check /> : <Copy />}
            Copy markdown
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
