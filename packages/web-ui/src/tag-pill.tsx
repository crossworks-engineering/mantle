import { cn } from './lib/utils';

/**
 * Theme categorical palette (chart-1..5). Full literal class strings so the
 * Tailwind scanner emits them.
 *
 * **Text colour: `text-foreground`, NOT `text-chart-N`.** The earlier same-hue
 * approach (text + bg both pulled from `chart-N`) read as ghost text on many
 * themes — chart tokens are calibrated for fills, not for legible text on a
 * tinted version of themselves. Using the regular foreground guarantees
 * contrast, while the colored border + bg tint still encode the tag's identity.
 */
const TAG_COLORS = [
  'border-chart-1/50 bg-chart-1/20 text-foreground',
  'border-chart-2/50 bg-chart-2/20 text-foreground',
  'border-chart-3/50 bg-chart-3/20 text-foreground',
  'border-chart-4/50 bg-chart-4/20 text-foreground',
  'border-chart-5/50 bg-chart-5/20 text-foreground',
];

/** Deterministic color class for a tag — the same tag always maps to the
 *  same palette slot, so a tag looks consistent everywhere it appears. */
export function tagColorClass(tag: string): string {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0;
  return TAG_COLORS[h % TAG_COLORS.length]!;
}

/** Read-only colored tag pill. */
export function TagPill({ tag, className }: { tag: string; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium',
        tagColorClass(tag),
        className,
      )}
    >
      {tag}
    </span>
  );
}
