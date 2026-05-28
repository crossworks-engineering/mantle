'use client';

import * as React from 'react';
import { useState } from 'react';
import { ChevronRight, Search } from 'lucide-react';
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

type StateFilter = 'all' | 'on' | 'off';

/**
 * A scannable multi-select rendered as a list of rows — name + description +
 * a Switch — instead of a wall of pills. The whole row is the toggle target;
 * the Switch is a visual indicator. Selected rows are highlighted. Pass
 * `group` on items to cluster them under sub-headers. The list flows inline
 * in the page (no inner scroll); pass `collapsible` to fold it behind a header
 * that shows the selected/total count, and `searchable` to add a filter bar
 * (text search over label/value/description + an All / On / Off selection
 * filter). (See docs/ui-style-guide.md §6.)
 */
export function ToggleList({
  items,
  selected,
  onChange,
  collapsible = false,
  defaultOpen = true,
  searchable = false,
}: {
  items: ToggleListItem[];
  selected: string[];
  onChange: (next: string[]) => void;
  /** Render a header that folds the rows away. */
  collapsible?: boolean;
  /** Initial open state when collapsible. */
  defaultOpen?: boolean;
  /** Add a search box + All/On/Off selection filter above the rows. */
  searchable?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [query, setQuery] = useState('');
  const [stateFilter, setStateFilter] = useState<StateFilter>('all');
  const set = new Set(selected);
  const toggle = (value: string) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(Array.from(next));
  };

  const q = query.trim().toLowerCase();
  const filtered = items.filter((it) => {
    if (stateFilter === 'on' && !set.has(it.value)) return false;
    if (stateFilter === 'off' && set.has(it.value)) return false;
    if (q) {
      const hay = `${it.label} ${it.value} ${it.description ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  // Cluster by group, preserving first-seen order. '' = ungrouped (no header).
  const groups: Array<[string, ToggleListItem[]]> = [];
  const index = new Map<string, ToggleListItem[]>();
  for (const it of filtered) {
    const g = it.group ?? '';
    let bucket = index.get(g);
    if (!bucket) {
      bucket = [];
      index.set(g, bucket);
      groups.push([g, bucket]);
    }
    bucket.push(it);
  }

  // Only worth a filter bar once the list is long enough to scan past; small
  // lists (a couple of skills, a handful of delegates) stay clean.
  const showToolbar = searchable && items.length > 6;
  const toolbar = showToolbar && (
    <div className="flex items-center gap-2 border-b border-border p-2">
      <div className="relative flex-1">
        <Search
          className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Don't let Enter submit the surrounding form.
            if (e.key === 'Enter') e.preventDefault();
          }}
          placeholder="Search…"
          aria-label="Search"
          className="h-8 w-full rounded-md border border-input bg-background pl-7 pr-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>
      <div className="flex shrink-0 items-center rounded-md border border-input p-0.5 text-xs">
        {(['all', 'on', 'off'] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setStateFilter(f)}
            aria-pressed={stateFilter === f}
            className={cn(
              'rounded px-2 py-1 font-medium transition-colors',
              stateFilter === f
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {f === 'all' ? 'All' : f === 'on' ? 'On' : 'Off'}
          </button>
        ))}
      </div>
    </div>
  );

  const list =
    groups.length === 0 ? (
      <p className="px-3 py-6 text-center text-xs text-muted-foreground">
        {items.length === 0 ? 'Nothing available.' : 'No matches.'}
      </p>
    ) : (
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

  const body = (
    <>
      {toolbar}
      {list}
    </>
  );

  if (!collapsible) {
    return <div className="overflow-hidden rounded-md border border-border">{body}</div>;
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
      {open && <div className="border-t border-border">{body}</div>}
    </div>
  );
}
