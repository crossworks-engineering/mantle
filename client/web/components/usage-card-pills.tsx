'use client';

import type { SpendRange } from '@mantle/client-types';

const COOKIE = 'mantle_spend_range';
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

const PILLS: { value: SpendRange; label: string }[] = [
  { value: 'day', label: 'D' },
  { value: 'week', label: 'W' },
  { value: 'month', label: 'M' },
];

/**
 * Day/week/month picker for the sidebar usage card.
 *
 * The cookie is still written, but only so the server layout can seed the
 * first paint without a flash. The card itself is a client component fetching
 * over HTTP now, so the pick is reported up via `onPick` rather than through
 * the `router.refresh()` this used when the card was server-rendered.
 */
export function UsageCardPills({
  current,
  onPick,
  pending,
}: {
  current: SpendRange;
  onPick: (range: SpendRange) => void;
  pending?: boolean;
}) {
  function pick(range: SpendRange) {
    if (range === current) return;
    document.cookie = `${COOKIE}=${range}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`;
    onPick(range);
  }

  return (
    <div className="mt-1 flex gap-1" aria-label="Spend range" data-pending={pending || undefined}>
      {PILLS.map((p) => {
        const active = p.value === current;
        return (
          <button
            key={p.value}
            type="button"
            onClick={() => pick(p.value)}
            className={
              'flex-1 rounded px-1 py-0.5 text-[10px] font-semibold tabular-nums transition-colors ' +
              (active
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground')
            }
            aria-pressed={active}
          >
            {p.label}
          </button>
        );
      })}
    </div>
  );
}
