'use client';

import { useMemo, useState, useTransition } from 'react';
import { Eye, Loader2, Paperclip } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { previewSender, type SenderPreviewResult } from './actions';

const BODY_LIMIT = 8000;
type Mode = 'html' | 'text';

export function PreviewButton({ address }: { address: string }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<SenderPreviewResult | undefined>(undefined);
  const [mode, setMode] = useState<Mode>('html');

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next && !result && !pending) {
      startTransition(async () => {
        const r = await previewSender(address);
        setResult(r);
        // Default to whichever representation we actually have.
        if (r.ok) setMode(r.preview.bodyHtmlSafe ? 'html' : 'text');
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <Button
        size="sm"
        variant="ghost"
        type="button"
        title="Preview latest message"
        onClick={() => handleOpenChange(true)}
        className="h-8 px-2"
      >
        <Eye className="size-4" aria-hidden />
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{result?.ok ? result.preview.subject || '(no subject)' : 'Latest message'}</DialogTitle>
          <DialogDescription>
            From <span className="font-mono">{address}</span> — live-fetched from IMAP, not stored.
          </DialogDescription>
        </DialogHeader>

        {pending && (
          <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Fetching from your mail server…
          </div>
        )}

        {result && result.ok === false && (
          <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {result.error}
          </p>
        )}

        {result?.ok && (
          <article className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {result.preview.fromName && (
                <span className="text-foreground">{result.preview.fromName}</span>
              )}
              <time dateTime={result.preview.internalDate}>
                {new Date(result.preview.internalDate).toLocaleString()}
              </time>
              {result.preview.folder && <span>in {result.preview.folder}</span>}
              {result.preview.bodyHtmlSafe && result.preview.bodyText && (
                <div className="ml-auto flex gap-1 rounded-md border border-border bg-background p-0.5 text-[11px]">
                  <button
                    type="button"
                    onClick={() => setMode('html')}
                    className={`rounded px-1.5 py-0.5 ${
                      mode === 'html' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'
                    }`}
                  >
                    HTML
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode('text')}
                    className={`rounded px-1.5 py-0.5 ${
                      mode === 'text' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'
                    }`}
                  >
                    Plain
                  </button>
                </div>
              )}
            </div>

            <PreviewBody
              mode={mode}
              bodyText={result.preview.bodyText}
              bodyHtmlSafe={result.preview.bodyHtmlSafe}
            />

            {result.preview.attachments.length > 0 && (
              <div className="border-t border-border pt-3 text-xs text-muted-foreground">
                <p className="mb-1 flex items-center gap-1 font-medium">
                  <Paperclip className="size-3" aria-hidden />
                  {result.preview.attachments.length} attachment
                  {result.preview.attachments.length === 1 ? '' : 's'}
                </p>
                <ul className="ml-4 list-disc">
                  {result.preview.attachments.map((a, i) => (
                    <li key={i}>
                      {a.filename}
                      {a.sizeBytes ? ` · ${formatBytes(a.sizeBytes)}` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </article>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PreviewBody({
  mode,
  bodyText,
  bodyHtmlSafe,
}: {
  mode: Mode;
  bodyText?: string;
  bodyHtmlSafe?: string;
}) {
  // Prefer the user's chosen mode if both representations exist.
  const effectiveMode: Mode = bodyHtmlSafe && mode === 'html' ? 'html' : bodyText ? 'text' : 'html';

  if (effectiveMode === 'html' && bodyHtmlSafe) {
    // useMemo is cheap insurance — the srcDoc string can be big.
    return <HtmlFrame html={bodyHtmlSafe} />;
  }

  if (bodyText) {
    const truncated = bodyText.length > BODY_LIMIT;
    const shown = truncated ? bodyText.slice(0, BODY_LIMIT) : bodyText;
    return (
      <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-muted/30 p-3">
        <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">{shown}</pre>
        {truncated && (
          <p className="mt-2 text-xs text-muted-foreground">
            …truncated at {BODY_LIMIT.toLocaleString()} characters.
          </p>
        )}
      </div>
    );
  }

  return (
    <p className="rounded-md border border-dashed border-border bg-muted/30 p-4 text-sm text-muted-foreground">
      Empty body.
    </p>
  );
}

/**
 * Sandboxed iframe via `srcDoc`. The sandbox attribute denies scripts,
 * same-origin, forms, and plugins by default. We allow popups (and let them
 * escape the sandbox) so that clicking a link opens a normal new tab.
 * `<base target="_blank">` makes every <a> open in a new tab without us
 * having to rewrite each href client-side.
 */
function HtmlFrame({ html }: { html: string }) {
  const srcDoc = useMemo(
    () =>
      [
        '<!doctype html>',
        '<html><head>',
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width">',
        '<base target="_blank">',
        // Reset + minimum-viable email styles so the preview looks reasonable
        // even when the email leans on inherited defaults (e.g. text-only
        // body inside a styled wrapper).
        `<style>
          html,body{margin:0;padding:12px;background:white;color:#111;font-family:-apple-system,system-ui,sans-serif;font-size:14px;line-height:1.5;word-wrap:break-word;}
          a{color:#1d4ed8;}
          table{border-collapse:collapse;max-width:100%;}
          img{max-width:100%;height:auto;}
          pre{white-space:pre-wrap;}
        </style>`,
        '</head><body>',
        html,
        '</body></html>',
      ].join(''),
    [html],
  );
  return (
    <iframe
      title="Email HTML preview"
      srcDoc={srcDoc}
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      className="min-h-0 w-full flex-1 rounded-md border border-border bg-white"
    />
  );
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}
