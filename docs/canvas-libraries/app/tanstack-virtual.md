# TanStack Virtual in a mini app

Version: @tanstack/react-virtual 3.14.24, as this brain's app runtime serves it.
Source: the TanStack Virtual docs (tanstack.com/virtual: the virtualizer
API, dynamic sizes, window scrolling). Written for Mantle, not copied.

## Import

```tsx
import { useVirtualizer } from '@tanstack/react-virtual';
```

Named imports only. It runs on the app's one shared React. The frame's
import map serves it; it is not bundled into the app.

## In a React component

- For a list or grid of thousands of rows: it renders only the rows in
  view (plus `overscan`), so 50,000 rows scroll like 50.
- A scroll element with a real height and `overflow: auto`, in a ref:
  `getScrollElement: () => ref.current`. Without a fixed height the
  element grows to fit and nothing is virtual.
- `useVirtualizer({ count, getScrollElement, estimateSize: () => 36, overscan: 8 })`.
  `count` is the number of rows (after your filter and sort).
- Inside the scroll element, one spacer `div` of
  `height: virtualizer.getTotalSize()` and `position: relative`; each
  visible row from `virtualizer.getVirtualItems()` is absolutely placed at
  `transform: translateY(${item.start}px)` with `height: item.size`.
- Key rows by your data id (`getItemKey: (i) => rows[i].id`), not the
  index, when rows can be filtered or reordered.
- Rows of different heights: give each row `data-index={item.index}` and
  `ref={virtualizer.measureElement}`, and drop the fixed height.
- Jump to a row: `virtualizer.scrollToIndex(i, { align: 'center' })`.
- With `@tanstack/react-table`: count the table's
  `getRowModel().rows`, not the raw data, so the virtual rows follow the
  sort and filter.
- A virtual list is not in the DOM all at once: the browser's find
  (Ctrl+F) sees only what is drawn. Give a search box (`fuse.js` has a
  guide) when people look for one row.

## App example

```tsx
import { useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Input } from '@/components/ui/input';

type Reading = { id: string; tag: string; value: number; at: string };
const ALL: Reading[] = Array.from({ length: 20000 }, (_, i) => ({
  id: `r${i}`,
  tag: `TT-${1000 + (i % 400)}`,
  value: Math.round((40 + 25 * Math.sin(i / 17) + (i % 7)) * 10) / 10,
  at: `2026-10-${String(1 + (i % 28)).padStart(2, '0')} ${String(i % 24).padStart(2, '0')}:00`,
}));

export default function App() {
  const [q, setQ] = useState('');
  const rows = useMemo(() => (q ? ALL.filter((r) => r.tag.includes(q.toUpperCase())) : ALL), [q]);
  const scroller = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 36,
    getItemKey: (i) => rows[i]!.id,
    overscan: 8,
  });
  return (
    <div className="mx-auto max-w-2xl space-y-3 p-6 text-foreground">
      <div className="flex items-center gap-3">
        <Input placeholder="Tag, e.g. TT-1042" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="shrink-0 text-sm text-muted-foreground">
          {rows.length.toLocaleString()} rows
        </span>
      </div>
      <div
        ref={scroller}
        className="overflow-auto rounded-lg border bg-card"
        style={{ height: 460 }}
      >
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((item) => {
            const r = rows[item.index]!;
            return (
              <div
                key={item.key}
                className="absolute inset-x-0 flex items-center justify-between border-b px-4 text-sm"
                style={{ height: item.size, transform: `translateY(${item.start}px)` }}
              >
                <span className="font-mono">{r.tag}</span>
                <span className="text-muted-foreground">{r.at}</span>
                <span className={r.value > 70 ? 'font-semibold text-destructive' : ''}>
                  {r.value.toFixed(1)} °C
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
```
