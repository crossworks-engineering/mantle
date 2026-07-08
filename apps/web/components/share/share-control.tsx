'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Loader2, Share2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { apiFetch, apiSend, ApiError } from '@/lib/api-fetch';

type ShareInfo = { id: string; token: string; path: string; mode?: 'public' | 'team' } | null;

/**
 * Owner control for read-only public sharing of a node. A popover with a single
 * toggle ("anyone with the link can view"); when on, shows the link + Copy.
 * Loads the current link lazily on first open. One link per item — toggling on
 * mints (or returns) it, off revokes it (link 404s instantly). See docs/sharing.md.
 *
 * `teamMode` adds a second toggle switching the link between public admission
 * and team-members-only (visitors must enter their contact team token; the
 * /s/ surface enforces it). `teamHint` tailors the toggle's explanation —
 * apps pass their tools/data warning; content kinds use the default.
 * Team-shared PAGES also appear on the /team hub as briefing cards.
 */
export function ShareControl({
  nodeId,
  iconOnly = false,
  beforeEnable,
  teamMode = false,
  teamHint = 'Visitors must enter their team token to open the link. Team-shared pages appear on the Team Hub.',
}: {
  nodeId: string;
  iconOnly?: boolean;
  /** Run before a link is first created — e.g. a page commits its draft so the
   *  shared copy reflects what the owner currently sees (pages publish on
   *  commit; notes/tasks/events/files save live and don't pass this). */
  beforeEnable?: () => Promise<void> | void;
  /** Offer the public/team admission toggle. */
  teamMode?: boolean;
  /** Explanation under the team toggle (kind-specific consequences). */
  teamHint?: string;
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
      const data = await apiFetch<{ share: ShareInfo }>(
        `/api/shares?nodeId=${encodeURIComponent(nodeId)}`,
        { cache: 'no-store' },
      );
      setShare(data.share);
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
        // Publish the current state first (pages commit their draft) so the
        // link reflects exactly what the owner sees at share time.
        await beforeEnable?.();
        const d = await apiSend<{ share?: ShareInfo }>('/api/shares', 'POST', { nodeId });
        if (!d.share) throw new Error('Could not create link');
        setShare(d.share);
      } else if (share) {
        await apiSend(`/api/shares/${share.id}`, 'DELETE');
        setShare(null);
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return; // already bounced to /login
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

  const setMode = async (team: boolean) => {
    if (!share) return;
    const mode = team ? 'team' : 'public';
    setBusy(true);
    try {
      await apiSend(`/api/shares/${share.id}`, 'PATCH', { mode });
      setShare({ ...share, mode });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return; // already bounced to /login
      toast.error(e instanceof Error ? e.message : 'Could not change who can open the link');
    } finally {
      setBusy(false);
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

          {share && teamMode && (
            <div className="flex items-start justify-between gap-3 border-t border-border pt-3">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">Team members only</p>
                <p className="text-xs text-muted-foreground">{teamHint}</p>
              </div>
              <Switch
                checked={share.mode === 'team'}
                disabled={busy}
                onCheckedChange={(v) => void setMode(v)}
                aria-label="Require a team token"
              />
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
