'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Loader2, Share2 } from 'lucide-react';
import { Button } from '@mantle/web-ui/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@mantle/web-ui/ui/popover';
import { Switch } from '@mantle/web-ui/ui/switch';
import { Input } from '@mantle/web-ui/ui/input';
import { useToast } from '@mantle/web-ui/ui/toast';
import { apiFetch, apiSend, ApiError } from '@mantle/web-ui/api-fetch';

type ShareInfo = {
  id: string;
  token: string;
  path: string;
  mode?: 'public' | 'team';
  cascade?: boolean;
} | null;

/**
 * Owner control for read-only public sharing of a node. A popover with a single
 * toggle ("anyone with the link can view"); when on, shows the link + Copy.
 * Loads the current link lazily on first open. One link per item — toggling on
 * mints (or returns) it, off revokes it (link 404s instantly). See docs/sharing.md.
 *
 * `teamMode` adds a second toggle switching the link between public admission
 * and team-members-only (visitors must enter their contact team token; the
 * /s/ surface enforces it). `teamHint` tailors the toggle's explanation —
 * apps/tables/folders pass kind-specific warnings; content kinds use the
 * default. Every shared item (public or team) lists in the /team workspace;
 * the mode only controls who can open it.
 *
 * `allowCascade` (pages) adds a "Share sub-pages" toggle when the page has
 * descendants: on shares the whole subtree at this page's mode; off (or
 * un-sharing the page) revokes the child links. See docs/sharing.md.
 */
export function ShareControl({
  nodeId,
  iconOnly = false,
  beforeEnable,
  teamMode = false,
  teamHint = 'Visitors must enter their team token to open the link. The item lists in the team workspace either way — this only controls who can open it.',
  allowCascade = false,
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
  /** Offer the "Share sub-pages" subtree toggle (pages with children). */
  allowCascade?: boolean;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [share, setShare] = useState<ShareInfo>(null);
  const [childCount, setChildCount] = useState(0);
  const [copied, setCopied] = useState(false);

  const absoluteUrl =
    share && typeof window !== 'undefined' ? window.location.origin + share.path : '';

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<{ share: ShareInfo; childCount?: number }>(
        `/api/shares?nodeId=${encodeURIComponent(nodeId)}`,
        { cache: 'no-store' },
      );
      setShare(data.share);
      setChildCount(data.childCount ?? 0);
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

  const setCascade = async (next: boolean) => {
    if (!share) return;
    setBusy(true);
    try {
      const d = await apiSend<{ count?: number }>('/api/shares/cascade', 'POST', {
        nodeId,
        on: next,
      });
      setShare({ ...share, cascade: next });
      toast.success(
        next
          ? `Shared ${d.count ?? childCount} sub-page${(d.count ?? childCount) === 1 ? '' : 's'}`
          : 'Sub-pages unshared',
      );
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return; // already bounced to /login
      toast.error(e instanceof Error ? e.message : 'Could not share the sub-pages');
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

          {share && allowCascade && childCount > 0 && (
            <div className="flex items-start justify-between gap-3 border-t border-border pt-3">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">Share sub-pages</p>
                <p className="text-xs text-muted-foreground">
                  Also share the {childCount} page{childCount === 1 ? '' : 's'} nested under this
                  one. They match this page&rsquo;s setting above; turn off to unshare them all.
                </p>
              </div>
              <Switch
                checked={!!share.cascade}
                disabled={busy}
                onCheckedChange={(v) => void setCascade(v)}
                aria-label="Share sub-pages"
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
