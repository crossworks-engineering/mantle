'use client';

/**
 * Owner control on the Team admin sidebar: which page TAGS render as curated
 * sections on the member Dashboard (/team overview). Each picked tag becomes a
 * section of up to 5 team-visible shared pages carrying it (newest-updated
 * first); pick order = section order. The share stays the source of truth for
 * WHAT is visible — this only chooses the groupings, so an empty pick list
 * simply means no curated block.
 *
 * Candidates come from tags on currently team-visible page shares (with
 * counts), so the owner picks from tags that actually resolve to content.
 */
import { useState } from 'react';
import { X, Pin } from 'lucide-react';
import { cn } from '@mantle/web-ui/lib/utils';
import { tagColorClass } from '@mantle/web-ui/tag-pill';
import { Label } from '@mantle/web-ui/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@mantle/web-ui/ui/select';
import { useToast } from '@mantle/web-ui/ui/toast';
import { apiSend } from '@mantle/web-ui/api-fetch';

const MAX_TAGS = 8; // mirrors TEAM_HUB_TAGS_MAX server-side

export function DashboardTagsPanel({
  initialTags,
  available,
}: {
  /** The curated tag list as stored (canonical lowercase, pref order). */
  initialTags: string[];
  /** Tags on team-visible page shares, with usage counts — pick candidates. */
  available: { tag: string; count: number }[];
}) {
  const [tags, setTags] = useState(initialTags);
  const [pending, setPending] = useState(false);
  const toast = useToast();

  const save = async (next: string[]) => {
    const prev = tags;
    setTags(next); // optimistic
    setPending(true);
    try {
      const res = await apiSend<{ tags: string[] }>('/api/team-admin/dashboard-tags', 'PUT', {
        tags: next,
      });
      setTags(res.tags); // reconcile to the stored canonical form
    } catch (err) {
      setTags(prev); // revert
      toast.error(err instanceof Error ? err.message : 'Could not update Dashboard sections.');
    } finally {
      setPending(false);
    }
  };

  const candidates = available.filter((a) => !tags.includes(a.tag));

  return (
    <div className="flex flex-col gap-1.5">
      <Label
        htmlFor="dashboardTagAdd"
        className="flex items-center gap-1.5 text-xs text-muted-foreground"
      >
        <Pin className="size-3.5" aria-hidden />
        Dashboard sections
      </Label>
      {tags.length > 0 ? (
        <ul className="flex flex-wrap gap-1">
          {tags.map((t) => {
            // Live shared-page count for the pill. 0 = the section currently
            // renders nothing on the Dashboard (all its pages unshared or
            // untagged since curation) — shown muted so a dead tag is visible
            // HERE, not just silently absent for members.
            const count = available.find((a) => a.tag === t)?.count ?? 0;
            return (
              <li key={t}>
                <span
                  title={
                    count === 0
                      ? 'No shared pages carry this tag right now — the section is hidden from members.'
                      : undefined
                  }
                  className={cn(
                    'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium',
                    count === 0 ? 'border-border bg-muted text-muted-foreground' : tagColorClass(t),
                  )}
                >
                  {t}
                  <span className={count === 0 ? undefined : 'text-muted-foreground'}>
                    · {count}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${t} from the Dashboard`}
                    disabled={pending}
                    onClick={() => void save(tags.filter((x) => x !== t))}
                    className="rounded-sm opacity-70 transition-opacity hover:opacity-100 disabled:opacity-40"
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {/* Value stays '' so the trigger always reads as the add affordance. */}
      <Select
        value=""
        onValueChange={(v) => void save([...tags, v])}
        disabled={pending || candidates.length === 0 || tags.length >= MAX_TAGS}
      >
        <SelectTrigger id="dashboardTagAdd" className="h-8 w-full text-xs">
          <SelectValue
            placeholder={
              tags.length >= MAX_TAGS
                ? `Max ${MAX_TAGS} sections`
                : candidates.length === 0
                  ? tags.length > 0
                    ? 'All shared-page tags added'
                    : 'No tags on shared pages yet'
                  : 'Add a tag section…'
            }
          />
        </SelectTrigger>
        <SelectContent>
          {candidates.map((c) => (
            <SelectItem key={c.tag} value={c.tag}>
              {c.tag} ({c.count} {c.count === 1 ? 'page' : 'pages'})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-[11px] leading-snug text-muted-foreground">
        Each tag lists its 5 most recently updated shared pages on the members&rsquo; Dashboard. Tag
        + share a page to feature it; unshare or untag to remove it.
      </p>
    </div>
  );
}
