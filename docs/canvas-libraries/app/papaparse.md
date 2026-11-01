# Papa Parse in a mini app

Version: papaparse 5.7.0, as this brain's app runtime serves it.
Source: the Papa Parse docs (papaparse.com: config, results, unparse) and
its changelog. Written for Mantle, not copied.

## Import

```tsx
import Papa from 'papaparse';
```

A default import. The frame's import map serves it; it is not bundled into
the app.

## In a React component

- Text in: `Papa.parse(text, { header: true, skipEmptyLines: true, dynamicTyping: true })`
  returns `{ data, errors, meta }` at once. `header: true` gives objects
  keyed by the first row; `meta.fields` lists the columns.
  `dynamicTyping` turns `'12.5'` into `12.5` and `'true'` into `true`;
  leave it off for tags with leading zeros (`'007'`).
- `errors` holds one entry per bad row (`{ row, message }`): show them, do
  not drop them in silence.
- A file people pick (`<input type="file" accept=".csv">`):
  `Papa.parse(file, { header: true, complete: (r) => setRows(r.data) })`.
  It reads the file in the frame; nothing is uploaded.
- Text out: `Papa.unparse(rows)` writes CSV from objects (the keys become
  the header) or from arrays; `{ columns: ['tag', 'value'] }` picks and
  orders columns, `{ delimiter: ';' }` for a European Excel.
- Here `download: true` (fetch a URL) and `worker: true` (parse in a
  worker) throw: the frame has no network and no workers. Parse text or a
  File the app already holds.
- Getting the CSV out: the frame cannot download a file (its sandbox has
  no downloads). Show the CSV for people to copy, or keep the rows in
  `host.db` and export them to a Table (the app authoring guide, "Exporting
  app data to a Table"), or write a file through a declared tool where the
  app may write files.
- Store parsed rows in `host.db` in a transaction, not one call per row.

## App example

```tsx
import { useMemo, useState } from 'react';
import Papa from 'papaparse';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type Row = { tag: string; reading: number; unit: string };

const SAMPLE = `tag,reading,unit
PT-1042,12.5,bar
TT-1043,61.2,degC
FT-2201,38,m3/h
PT-1044,oops,bar
LT-0012,71,%`;

export default function App() {
  const [text, setText] = useState(SAMPLE);
  const parsed = useMemo(
    () => Papa.parse<Row>(text, { header: true, skipEmptyLines: true, dynamicTyping: true }),
    [text],
  );
  const good = parsed.data.filter((r) => typeof r.reading === 'number');
  const bad = parsed.data.filter((r) => typeof r.reading !== 'number');
  const out = Papa.unparse(
    good.map((r) => ({ ...r, checked: 'yes' })),
    { columns: ['tag', 'reading', 'unit', 'checked'] },
  );
  return (
    <div className="mx-auto grid max-w-4xl gap-4 p-6 text-foreground md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>CSV in</CardTitle>
        </CardHeader>
        <CardContent>
          <textarea
            className="h-48 w-full rounded-md border bg-background p-2 font-mono text-sm"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <p className="mt-2 text-sm text-muted-foreground">
            Columns: {parsed.meta.fields?.join(', ')}. {good.length} good,{' '}
            <span className="text-destructive">{bad.length} without a number</span>
            {parsed.errors.length > 0 && `, ${parsed.errors.length} parse errors`}.
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>CSV out</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="h-48 overflow-auto rounded-md bg-muted p-2 text-sm">{out}</pre>
          <p className="mt-2 text-sm text-muted-foreground">
            Select and copy, or save the rows to host.db.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
```
