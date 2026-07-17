/**
 * Shared Forum presentation atoms: kind/status badges + relative time.
 * Kind colours ride the theme's chart tokens as DOTS beside muted text —
 * never as fills (chart tokens have no `-foreground` pair, so a filled badge
 * could not guarantee contrast across the ~40 themes).
 */
import { Lock, Pin } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ForumKind = 'question' | 'review' | 'feature' | 'bug' | 'discussion';
export type ForumStatus = 'open' | 'answered' | 'closed';

export const FORUM_KINDS: Array<{ value: ForumKind; label: string; dot: string; hint: string }> = [
  {
    value: 'question',
    label: 'Question',
    dot: 'bg-chart-1',
    hint: 'Ask the brain — the assistant answers in the thread.',
  },
  {
    value: 'discussion',
    label: 'Discussion',
    dot: 'bg-chart-2',
    hint: 'Talk with the team — the assistant stays out unless asked.',
  },
  {
    value: 'review',
    label: 'Review',
    dot: 'bg-chart-3',
    hint: 'Ask for content to be reviewed or corrected.',
  },
  {
    value: 'feature',
    label: 'Feature',
    dot: 'bg-chart-4',
    hint: 'Propose something new.',
  },
  {
    value: 'bug',
    label: 'Bug',
    dot: 'bg-chart-5',
    hint: 'Report something wrong.',
  },
];

export function kindMeta(kind: ForumKind) {
  return FORUM_KINDS.find((k) => k.value === kind) ?? FORUM_KINDS[0]!;
}

export function KindBadge({ kind, className }: { kind: ForumKind; className?: string }) {
  const meta = kindMeta(kind);
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground',
        className,
      )}
    >
      <span className={cn('size-1.5 rounded-full', meta.dot)} aria-hidden />
      {meta.label}
    </span>
  );
}

export function TopicFlags({
  pinned,
  visibility,
  status,
}: {
  pinned: boolean;
  visibility: 'team' | 'private';
  status: ForumStatus;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
      {pinned && <Pin className="size-3.5" aria-label="Pinned" />}
      {visibility === 'private' && <Lock className="size-3.5" aria-label="Private topic" />}
      {status !== 'open' && (
        <span className="rounded-full border border-border px-2 py-0.5 text-[11px]">
          {status === 'answered' ? 'Answered' : 'Closed'}
        </span>
      )}
    </span>
  );
}

/** Compact relative time for list rows ("4m", "3h", "2d", else a date). */
export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (isNaN(then)) return '';
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d`;
  return new Date(iso).toLocaleDateString();
}
