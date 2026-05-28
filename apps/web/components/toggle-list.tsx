'use client';

import * as React from 'react';
import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
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
  /** Optional section header to cluster rows under. */
  group?: string;
  /** Greyed + non-interactive. */
  disabled?: boolean;
};

/**
 * A scannable multi-select rendered as a list of rows — name + description +
 * a Switch — instead of a wall of pills. The whole row is the toggle target;
 * the Switch is a visual indicator. Selected rows are highlighted. Pass
 * `group` on items to cluster them under sub-headers. The list flows inline
 * in the page (no inner scroll); pass `collapsible` to fold it behind a header
 * that shows the selected/total count. (See docs/ui-style-guide.md §6.)
 */
export function ToggleList({
  items,
  selected,
  onChange,
  collapsible = false,
  defaultOpen = true,
}: {
  items: ToggleListItem[];
  selected: string[];
  onChange: (next: string[]) => void;
  /** Render a header that folds the rows away. */
  collapsible?: boolean;
  /** Initial open state when collapsible. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
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

  const rows = (
    <div className="divide-y divide-border">
      {groups.map(([group, groupRows]) => (
        <div key={group || '_'} className="divide-y divide-border">
          {group && (
            <div className="bg-muted/50 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {group} · {groupRows.length}
            </div>
          )}
          {groupRows.map((it) => {
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

  if (!collapsible) {
    return <div className="overflow-hidden rounded-md border border-border">{rows}</div>;
  }

  return (
    <div className="overflow-hidden rounded-md border border-border">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ChevronRight
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90',
          )}
          aria-hidden
        />
        <span className="text-sm font-medium">
          {selected.length} of {items.length} selected
        </span>
      </button>
      {open && <div className="border-t border-border">{rows}</div>}
    </div>
  );
}
