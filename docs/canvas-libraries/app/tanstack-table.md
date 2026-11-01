# TanStack Table in a mini app

Version: @tanstack/react-table 9.3.1, as this brain's app runtime serves it.
Source: the TanStack Table v9 docs and the guides in its package.
Written for Mantle, not copied.

## Import

```tsx
import {
  useTable,
  tableFeatures,
  createColumnHelper,
  rowSortingFeature,
  createSortedRowModel,
} from '@tanstack/react-table';
```

Named imports only. It runs on the app's one shared React. The frame's
import map serves it; it is not bundled into the app.

## In a React component

- This is v9. Most examples you know are v8: `useReactTable`,
  `getCoreRowModel()` and `getSortedRowModel()` are gone. v9 is
  `useTable({ features, columns, data })`, and every behaviour is a
  feature you register.
- Features go in `tableFeatures({...})` at module scope, as in the
  example. A prerequisite comes first (`columnFilteringFeature` before
  `globalFilteringFeature`). A missing feature means a missing API.
- Keep `features`, `columns` and `data` stable (module scope, state or
  `useMemo`): a new array each render rebuilds every row model.
- Render with your own markup: `table.getHeaderGroups()`,
  `table.getRowModel().rows`, `row.getAllCells()`, and
  `<table.FlexRender header={header} />` / `<table.FlexRender cell={cell} />`.
- Controlled state: `state: { globalFilter }` needs its updater
  `onGlobalFilterChange: setGlobalFilter`.
- Sorting: `header.column.getToggleSortingHandler()` on a click,
  `header.column.getIsSorted()` gives `'asc'`, `'desc'` or `false`.
- Thousands of rows: draw only the visible ones with
  `@tanstack/react-virtual` (its own guide); this example draws 100.

## App example

```tsx
import { useState } from 'react';
import {
  columnFilteringFeature,
  createColumnHelper,
  createFilteredRowModel,
  createSortedRowModel,
  filterFn_includesString,
  globalFilteringFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  tableFeatures,
  useTable,
} from '@tanstack/react-table';
import { Input } from '@/components/ui/input';

type Valve = { tag: string; unit: string; size: number; status: string };
const UNITS = ['CDU', 'FCC', 'HDS', 'SRU'];
const DATA: Valve[] = Array.from({ length: 200 }, (_, i) => ({
  tag: `XV-${String(1000 + i * 7)}`,
  unit: UNITS[i % 4]!,
  size: [2, 4, 6, 8, 12][i % 5]!,
  status: i % 9 === 0 ? 'Overdue' : 'OK',
}));

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric },
  columnFilteringFeature,
  globalFilteringFeature,
  filteredRowModel: createFilteredRowModel(),
  filterFns: { includesString: filterFn_includesString },
});
const col = createColumnHelper<typeof features, Valve>();
const columns = col.columns([
  col.accessor('tag', { header: 'Tag', sortFn: 'alphanumeric' }),
  col.accessor('unit', { header: 'Unit' }),
  col.accessor('size', { header: 'Size (in)' }),
  col.accessor('status', { header: 'Status' }),
]);

export default function App() {
  const [globalFilter, setGlobalFilter] = useState('');
  const table = useTable({
    features,
    columns,
    data: DATA,
    globalFilterFn: 'includesString',
    state: { globalFilter },
    onGlobalFilterChange: setGlobalFilter,
  });
  const rows = table.getRowModel().rows;
  return (
    <div className="mx-auto max-w-3xl space-y-3 p-6 text-foreground">
      <Input
        placeholder="Filter, e.g. FCC or Overdue"
        value={globalFilter}
        onChange={(e) => setGlobalFilter(e.target.value)}
      />
      <p className="text-sm text-muted-foreground">{rows.length} valves</p>
      <div className="max-h-[480px] overflow-auto rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-muted">
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => (
                  <th
                    key={header.id}
                    onClick={header.column.getToggleSortingHandler()}
                    className="cursor-pointer select-none px-3 py-2 text-left font-medium"
                  >
                    <table.FlexRender header={header} />
                    {{ asc: ' ▲', desc: ' ▼' }[header.column.getIsSorted() as string] ?? ''}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {rows.slice(0, 100).map((row) => (
              <tr key={row.id} className="border-t">
                {row.getAllCells().map((cell) => (
                  <td key={cell.id} className="px-3 py-1.5">
                    <table.FlexRender cell={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```
