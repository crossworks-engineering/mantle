'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Loader2, Share2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';

type ShareInfo = { id: string; token: string; path: string } | null;

/**
 * Owner control for read-only public sharing of a node. A popover with a single
 * toggle ("anyone with the link can view"); when on, shows the link + Copy.
 * Loads the current link lazily on first open. One link per item — toggling on
 * mints (or returns) it, off revokes it (link 404s instantly). See docs/sharing.md.
 */
export function ShareControl({
  nodeId,
  iconOnly = false,
}: {
  nodeId: string;
  iconOnly?: boolean;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [share, setShare] = useState<ShareInfo>(null);
  const [copied, setCopied] = useState(false);

  const absoluteUrl =
    share && typeof window !== 'undefined' ? window.location.origin + share.path : '';

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/shares?nodeId=${encodeURIComponent(nodeId)}`, { cache: 'no-store' });
      if (r.ok) setShare(((await r.json()) as { share: ShareInfo }).share);
    } catch {
      // best-effort; the toggle still works
    } finally {
      setLoaded(true);
    }
  }, [nodeId]);

  useEffect(() => {
    if (open && !loaded) void load();
  }, [open, loaded, load]);

  const toggle = async (next: boolean) => {
    setBusy(true);
    try {
      if (next) {
        const r = await fetch('/api/shares', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ nodeId }),
        });
        const d = (await r.json()) as { share?: ShareInfo; error?: string };
        if (!r.ok || !d.share) throw new Error(d.error ?? 'Could not create link');
        setShare(d.share);
      } else if (share) {
        const r = await fetch(`/api/shares/${share.id}`, { method: 'DELETE' });
        if (!r.ok) throw new Error('Could not revoke link');
        setShare(null);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(absoluteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Copy failed');
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size={iconOnly ? 'icon' : 'sm'} aria-label="Share">
          <Share2 />
          {!iconOnly && 'Share'}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">Share to web</p>
              <p className="text-xs text-muted-foreground">Anyone with the link can view.</p>
            </div>
            <Switch
              checked={!!share}
              disabled={busy || !loaded}
              onCheckedChange={(v) => void toggle(v)}
              aria-label="Enable public link"
            />
          </div>

          {share && (
            <div className="flex items-center gap-2">
              <Input
                readOnly
                value={absoluteUrl}
                className="h-8 text-xs"
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button
                size="icon"
                variant="outline"
                className="size-8 shrink-0"
                onClick={copy}
                aria-label="Copy link"
              >
                {copied ? <Check /> : <Copy />}
              </Button>
            </div>
          )}

          {!loaded && (
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" aria-hidden /> Loading…
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
