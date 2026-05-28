'use client';

import * as React from 'react';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

export type ToggleListItem = {
  /** Stable value stored in the selection (e.g. a slug). */
  value: string;
  /** Primary label shown on the row. */
  label: string;
  /** Secondary line shown muted under the label. */
  description?: string | null;
  /** Small trailing content beside the label — a mono slug, ⚠ badge, count, … */
  meta?: React.ReactNode;
  /** Optional section header to cluster rows under (sticky while scrolling). */
  group?: string;
  /** Greyed + non-interactive. */
  disabled?: boolean;
};

/**
 * A scannable multi-select rendered as a list of rows — name + description +
 * a Switch — instead of a wall of pills. The whole row is the toggle target;
 * the Switch is a visual indicator. Selected rows are highlighted. Pass
 * `group` on items to cluster them under sticky sub-headers. The list scrolls
 * past `maxHeightClassName` so a long catalog stays contained.
 * (See docs/ui-style-guide.md §6.)
 */
export function ToggleList({
  items,
  selected,
  onChange,
  maxHeightClassName = 'max-h-80',
}: {
  items: ToggleListItem[];
  selected: string[];
  onChange: (next: string[]) => void;
  maxHeightClassName?: string;
}) {
  const set = new Set(selected);
  const toggle = (value: string) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(Array.from(next));
  };

  // Cluster by group, preserving first-seen order. '' = ungrouped (no header).
  const groups: Array<[string, ToggleListItem[]]> = [];
  const index = new Map<string, ToggleListItem[]>();
  for (const it of items) {
    const g = it.group ?? '';
    let bucket = index.get(g);
    if (!bucket) {
      bucket = [];
      index.set(g, bucket);
      groups.push([g, bucket]);
    }
    bucket.push(it);
  }

  return (
    <div
      className={cn(
        'divide-y divide-border overflow-y-auto rounded-md border border-border scrollbar-thin',
        maxHeightClassName,
      )}
    >
      {groups.map(([group, rows]) => (
        <div key={group || '_'} className="divide-y divide-border">
          {group && (
            <div className="sticky top-0 z-10 bg-muted/70 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur">
              {group} · {rows.length}
            </div>
          )}
          {rows.map((it) => {
            const on = set.has(it.value);
            return (
              <button
                key={it.value}
                type="button"
                onClick={() => toggle(it.value)}
                disabled={it.disabled}
                aria-pressed={on}
                className={cn(
                  'flex w-full items-center gap-3 px-3 py-2 text-left transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                  on ? 'bg-accent/50' : 'hover:bg-accent/30',
                  it.disabled && 'cursor-not-allowed opacity-60',
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{it.label}</span>
                    {it.meta}
                  </div>
                  {it.description && (
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                      {it.description}
                    </p>
                  )}
                </div>
                <Switch
                  checked={on}
                  aria-hidden
                  tabIndex={-1}
                  className="pointer-events-none shrink-0"
                />
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
