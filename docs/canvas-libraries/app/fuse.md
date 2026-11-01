# Fuse.js in a mini app

Version: fuse.js 7.5.0, as this brain's app runtime serves it.
Source: the Fuse.js docs (fusejs.io: options, scoring, extended search,
indexing). Written for Mantle, not copied.

## Import

```tsx
import Fuse from 'fuse.js';
```

A default import (a class). The frame's import map serves it; it is not
bundled into the app.

## In a React component

- Fuzzy search finds `'contrl valv'` in `'Control valve'`: typos, partial
  words, words out of order. For an exact filter (a status, a unit) a plain
  `array.filter` is clearer; use Fuse for the search box.
- Build the index once, in `useMemo` keyed on the list:
  `new Fuse(items, { keys: ['tag', 'name'], threshold: 0.35, ignoreLocation: true })`.
  A new `Fuse` on every keystroke rebuilds the index each time.
- `fuse.search(query, { limit: 50 })` returns `[{ item, refIndex, score }]`,
  best first; `score` is 0 for a perfect match up to 1. An empty query
  returns nothing: show the whole list then.
- `threshold`: 0 is exact, 0.6 is loose. 0.3 to 0.4 suits names and tags.
- `ignoreLocation: true` matches anywhere in a long field; without it a
  match far from the start scores badly and is dropped.
- Weighted keys: `keys: [{ name: 'tag', weight: 2 }, 'description']`.
  Nested fields by path: `'area.name'`.
- `includeMatches: true` adds the matched character ranges
  (`matches[].indices`), for highlighting.
- `useExtendedSearch: true` adds operators: `'=PT-101` exact, `^PT` starts
  with, `!spare` does not include, a space for AND, `|` for OR.
- Tens of thousands of items search in a few milliseconds; for more, pass a
  prebuilt `Fuse.createIndex(keys, items)` as the third argument.

## App example

```tsx
import { useMemo, useState } from 'react';
import Fuse from 'fuse.js';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';

type Item = { tag: string; name: string; area: string };
const ITEMS: Item[] = [
  { tag: 'FV-2201', name: 'Feed control valve', area: 'Crude unit' },
  { tag: 'P-305A', name: 'Reflux pump, duty', area: 'Crude unit' },
  { tag: 'P-305B', name: 'Reflux pump, standby', area: 'Crude unit' },
  { tag: 'E-101', name: 'Feed and effluent exchanger', area: 'Hydrotreater' },
  { tag: 'PSV-14', name: 'Relief valve on the separator', area: 'Hydrotreater' },
  { tag: 'TT-1042', name: 'Reactor bed temperature', area: 'Hydrotreater' },
  { tag: 'LT-12', name: 'Drum level transmitter', area: 'Sulphur unit' },
  { tag: 'K-401', name: 'Air blower', area: 'Sulphur unit' },
];

export default function App() {
  const [q, setQ] = useState('contrl valv');
  const fuse = useMemo(
    () =>
      new Fuse(ITEMS, {
        keys: [{ name: 'tag', weight: 2 }, 'name', 'area'],
        threshold: 0.4,
        ignoreLocation: true,
      }),
    [],
  );
  const hits = q.trim() ? fuse.search(q, { limit: 20 }) : ITEMS.map((item) => ({ item, score: 0 }));
  return (
    <div className="mx-auto max-w-xl space-y-3 p-6 text-foreground">
      <Input placeholder="Search tags and names" value={q} onChange={(e) => setQ(e.target.value)} />
      <ul className="space-y-2">
        {hits.map(({ item, score }) => (
          <li
            key={item.tag}
            className="flex items-center justify-between rounded-lg border bg-card px-4 py-3 text-card-foreground"
          >
            <div>
              <p className="font-mono text-sm">{item.tag}</p>
              <p>{item.name}</p>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="secondary">{item.area}</Badge>
              <span className="w-10 text-right text-xs text-muted-foreground">
                {(1 - (score ?? 0)).toFixed(2)}
              </span>
            </div>
          </li>
        ))}
        {hits.length === 0 && <li className="text-sm text-muted-foreground">No match.</li>}
      </ul>
    </div>
  );
}
```
