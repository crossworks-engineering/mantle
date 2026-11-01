# QR codes in a mini app (qrcode)

Version: qrcode 1.5.4, as this brain's app runtime serves it.
Source: the node-qrcode README (its API: create, toString, toDataURL,
toCanvas, options). Written for Mantle, not copied.

## Import

```tsx
import QRCode from 'qrcode';
```

A default import. The browser build: `toFile` and the terminal output are
not in it. The frame's import map serves it; it is not bundled into the
app.

## In a React component

- `QRCode.create(text, { errorCorrectionLevel: 'M' })` returns the code at
  once: `modules.size` (squares per side) and `modules.data` (one byte per
  square, row by row, 1 for dark). Draw it as React SVG, as below: no
  `innerHTML`, and it scales to any size sharp.
- `await QRCode.toString(text, { type: 'svg', margin: 1 })` gives an SVG
  string; `await QRCode.toDataURL(text, { width: 512 })` a PNG data URL,
  for an `<img>` or to embed in a PDF with `pdf-lib`. Both return a promise:
  call them in an effect.
- Keep the code dark on light, on a white tile, in both themes. Many
  scanners refuse a light-on-dark code; the theme styles the label around
  it, not the code.
- Leave a quiet zone (`margin`, in squares; 2 or more on a printed label).
- `errorCorrectionLevel`: `'L'` 7%, `'M'` 15% (the default), `'Q'` 25%,
  `'H'` 30% of the code can be damaged and still read. Use `'Q'` or `'H'`
  for a tag on equipment that gets dirty.
- Encode the tag or a short id, not a long URL: a shorter text gives
  bigger squares, which read from further away. A URL to the brain works
  only for people who can reach the brain.
- A sheet of labels to print: a grid of tiles with fixed sizes in `mm`,
  and `@media print` classes (`print:hidden` on the controls).

## App example

```tsx
import { useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { Input } from '@/components/ui/input';

function QR({ text, px = 132 }: { text: string; px?: number }) {
  const path = useMemo(() => {
    const { size, data } = QRCode.create(text, { errorCorrectionLevel: 'Q' }).modules;
    let d = '';
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) if (data[y * size + x]) d += `M${x + 2} ${y + 2}h1v1h-1z`;
    }
    return { d, n: size + 4 };
  }, [text]);
  return (
    <svg viewBox={`0 0 ${path.n} ${path.n}`} width={px} height={px} shapeRendering="crispEdges">
      <rect width={path.n} height={path.n} fill="#fff" />
      <path d={path.d} fill="#000" />
    </svg>
  );
}

export default function App() {
  const [prefix, setPrefix] = useState('PSV');
  const tags = Array.from({ length: 6 }, (_, i) => `${prefix || 'TAG'}-${101 + i}`);
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6 text-foreground">
      <div className="flex max-w-xs items-center gap-2 print:hidden">
        <span className="text-sm text-muted-foreground">Prefix</span>
        <Input value={prefix} onChange={(e) => setPrefix(e.target.value.toUpperCase())} />
      </div>
      <div className="grid grid-cols-3 gap-4">
        {tags.map((t) => (
          <div
            key={t}
            className="flex flex-col items-center gap-2 rounded-lg border bg-card p-4 text-card-foreground"
          >
            <div className="rounded bg-white p-1">
              <QR text={t} />
            </div>
            <span className="font-mono text-sm font-semibold">{t}</span>
            <span className="text-xs text-muted-foreground">Relief valve, unit 2</span>
          </div>
        ))}
      </div>
    </div>
  );
}
```
