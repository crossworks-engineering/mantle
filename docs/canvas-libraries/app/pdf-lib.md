# pdf-lib in a mini app

Version: pdf-lib 1.17.1, as this brain's app runtime serves it.
Source: the pdf-lib docs (pdf-lib.js.org) and its README. Written for Mantle, not copied.

## Import

```tsx
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
```

Named imports only. The frame's import map serves it (about 440 KB,
fetched only by an app that imports it); it is not bundled into the app.

## In a React component

- Async: `await PDFDocument.create()`, then `await pdf.save()` gives the
  bytes (`Uint8Array`). Run it in a handler or an effect, not in render.
- A page: `pdf.addPage([595.28, 841.89])` is A4 in points (72 to the inch);
  `[612, 792]` is US Letter. The origin is the BOTTOM left: y grows up, so
  the first line sits near `height - 50`.
- Text: `const font = await pdf.embedFont(StandardFonts.Helvetica)`, then
  `page.drawText('PT-1042', { x, y, size: 11, font, color: rgb(0, 0, 0) })`.
  `font.widthOfTextAtSize(text, size)` measures; pdf-lib does not wrap.
- The standard fonts encode WinAnsi only (Latin letters, digits, common
  signs). A character outside it (Greek, CJK, an emoji) THROWS. There is no
  custom font support here (it needs `fontkit`, not served): keep to Latin
  text, or make the PDF with `pdf_render`, which takes HTML.
- Shapes: `drawRectangle`, `drawLine`; `rgb(r, g, b)` from 0 to 1. Paper
  is white: use print colours, not theme tokens.
- Images: `await pdf.embedPng(bytes)`, then `page.drawImage` (a QR code
  from `qrcode` too).
- A PDF people pick: `PDFDocument.load(await file.arrayBuffer())`; fill
  its form with `getForm().getTextField('Name').setText(...)`, `flatten()`.
- Getting it out: the frame cannot download a file or show a PDF (no
  downloads, no nested frame). Keep the bytes in `host.db` as a BLOB, or,
  for a report that lands in the admin's files, use `pdf_render` (the app
  authoring guide, "Reports").

## App example

```tsx
import { useEffect, useState } from 'react';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const ROWS = [
  ['PT-1042', 'Pressure transmitter', 'OK'],
  ['PSV-14', 'Relief valve', 'Due'],
  ['E-101', 'Exchanger', 'OK'],
  ['P-305A', 'Reflux pump', 'Overdue'],
];

async function makeSheet(title: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  const page = pdf.addPage([595.28, 841.89]);
  const { height } = page.getSize();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  page.drawText(title, { x: 50, y: height - 70, size: 20, font: bold });
  // Rows from the top down: y counts up from the bottom.
  let y = height - 120;
  for (const [tag, what, status] of ROWS) {
    page.drawRectangle({ x: 45, y: y - 8, width: 505, height: 26, color: rgb(0.95, 0.95, 0.95) });
    page.drawText(tag!, { x: 55, y, size: 11, font: bold });
    page.drawText(what!, { x: 160, y, size: 11, font });
    const red = status === 'Overdue';
    const w = font.widthOfTextAtSize(status!, 11);
    page.drawText(status!, {
      x: 540 - w,
      y,
      size: 11,
      font,
      color: red ? rgb(0.75, 0.1, 0.1) : rgb(0, 0, 0),
    });
    y -= 34;
  }
  return pdf.save();
}

export default function App() {
  const [info, setInfo] = useState<{ pages: number; kb: string; head: string } | null>(null);
  const [error, setError] = useState('');
  async function build() {
    try {
      const bytes = await makeSheet('Inspection sheet, week 45');
      const back = await PDFDocument.load(bytes);
      setInfo({
        pages: back.getPageCount(),
        kb: (bytes.length / 1024).toFixed(1),
        head: new TextDecoder().decode(bytes.slice(0, 8)),
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void build();
  }, []);
  return (
    <div className="mx-auto max-w-lg p-6 text-foreground">
      <Card>
        <CardHeader>
          <CardTitle>Inspection sheet</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <ul className="space-y-1 text-sm">
            {ROWS.map(([tag, what, status]) => (
              <li key={tag} className="flex justify-between rounded-md bg-muted px-3 py-2">
                <span className="font-mono">{tag}</span>
                <span>{what}</span>
                <span className={status === 'Overdue' ? 'text-destructive' : ''}>{status}</span>
              </li>
            ))}
          </ul>
          <Button onClick={build}>Make the PDF</Button>
          {info && (
            <p className="text-sm text-muted-foreground">
              {info.head}: {info.pages} page, {info.kb} KB, ready for host.db.
            </p>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
```
