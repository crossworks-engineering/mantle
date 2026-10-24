# Konva in a mini app

Version: konva 10.9.0, as this brain's app runtime serves it.
Source: the Konva docs (konvajs.org: API reference and the Stage, Layer and
drag pages) and its changelog. Written for Mantle, not copied.

## Import

```tsx
import Konva from 'konva';
```

A default import, and plain Konva: `react-konva` is not served. The frame's
import map serves the library; it is not bundled into the app.

## In a React component

- Use it for 2D shapes people drag and click: a floor plan, a seating
  chart, a whiteboard of cards. For a chart, ECharts or D3 fit better.
- A container `div` with a real height, kept in a `useRef`. In a
  `useEffect`: `new Konva.Stage({ container: el, width, height })`, one or a
  few `Konva.Layer`s, shapes added to a layer. Cleanup: `stage.destroy()`
  (it removes its canvases and listeners).
- React state is the source of truth for anything you save. On `dragend`,
  read `node.x()` and `node.y()` and write them to state or `host.db` once
  (not on every `dragmove`: the call budget).
- Resize: a `ResizeObserver` calls `stage.width(w)` and `stage.height(h)`.
- Colours: Konva paints a canvas, so CSS variables do not reach it. Convert
  tokens with `token()` (oklch as rgb), set them again when the host
  switches theme, then `layer.batchDraw()`.
- Keep the stage out of React's render: never put shapes in JSX inside the
  container.

## App example

```tsx
import { useEffect, useRef, useState } from 'react';
import Konva from 'konva';

function token(name: string): string {
  const g = document.createElement('canvas').getContext('2d')!;
  g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
  g.fillRect(0, 0, 1, 1);
  const [r, gr, b] = g.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${gr}, ${b})`;
}

const CARDS = [
  { id: 'a', label: 'Pump P-101', x: 40, y: 40 },
  { id: 'b', label: 'Drum V-201', x: 260, y: 90 },
  { id: 'c', label: 'Exchanger E-301', x: 120, y: 190 },
];

export default function App() {
  const ref = useRef<HTMLDivElement>(null);
  const [moved, setMoved] = useState('Drag a card.');
  useEffect(() => {
    const el = ref.current!;
    const stage = new Konva.Stage({
      container: el,
      width: el.clientWidth,
      height: el.clientHeight,
    });
    const layer = new Konva.Layer();
    stage.add(layer);
    const rects: Konva.Rect[] = [];
    const texts: Konva.Text[] = [];
    for (const c of CARDS) {
      const group = new Konva.Group({ x: c.x, y: c.y, draggable: true });
      const rect = new Konva.Rect({ width: 170, height: 56, cornerRadius: 8, strokeWidth: 1.5 });
      const text = new Konva.Text({
        text: c.label,
        x: 14,
        y: 20,
        fontSize: 15,
        fontFamily: getComputedStyle(document.body).fontFamily,
      });
      group.add(rect, text);
      group.on('dragend', () =>
        setMoved(`${c.label} at ${Math.round(group.x())}, ${Math.round(group.y())}`),
      );
      layer.add(group);
      rects.push(rect);
      texts.push(text);
    }
    const paint = () => {
      for (const r of rects) r.setAttrs({ fill: token('--card'), stroke: token('--chart-1') });
      for (const t of texts) t.fill(token('--foreground'));
      layer.batchDraw();
    };
    paint();
    const ro = new ResizeObserver(() =>
      stage.size({ width: el.clientWidth, height: el.clientHeight }),
    );
    ro.observe(el);
    const mo = new MutationObserver(paint);
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-color-theme'],
    });
    return () => {
      mo.disconnect();
      ro.disconnect();
      stage.destroy();
    };
  }, []);
  return (
    <div className="space-y-2 p-4">
      <div ref={ref} className="h-72 w-full rounded-lg border bg-muted" />
      <p className="text-sm text-muted-foreground">{moved}</p>
    </div>
  );
}
```
