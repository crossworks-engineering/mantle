# ECharts in a mini app

Version: echarts 6.1.0, as this brain's app runtime serves it.
Source: the Apache ECharts handbook (echarts.apache.org) and its 5 to 6
upgrade guide. Written for Mantle, not copied.

## Import

```tsx
import * as echarts from 'echarts';
```

A namespace import: `echarts` has no default export, and the build refuses
`import echarts from 'echarts'`. The bare name only (`echarts/core` is
refused). The frame's import map serves the library; it is not bundled into
the app.

## In a React component

- Give the chart a `div` with a real height (`h-80`, not `h-full` in a
  card), keep it in a `useRef`, and call `echarts.init(ref.current, null,
{ renderer: 'svg' })` in a `useEffect`. Never at module level or in render.
- Keep the instance in a ref. A second effect with the data as its
  dependency calls `chart.setOption(...)` again; ECharts merges it.
- Resize: a `ResizeObserver` on the container calls `chart.resize()`.
- Cleanup: the effect returns `() => { observer.disconnect(); chart.dispose(); }`.
- Theme: the tokens (`--chart-1` to `--chart-5`, `--foreground`,
  `--muted-foreground`, `--border`) are `oklch()`, which ECharts cannot
  parse. Convert them with `token()` from the example and set every colour
  ECharts would otherwise default (series `color`, text, axis labels, axis
  lines, split lines, tooltip), and repaint when the
  host switches theme (a `MutationObserver` on the `<html>` class).
- Data comes from `host.db` or a declared tool, never a URL: the frame has
  no network.
- A `formatter` FUNCTION (tooltip, label) returns raw HTML: pass row text
  through `echarts.format.encodeHTML(text)` first. A string template
  (`'{b}: {c}'`) is escaped for you.
- Reduced motion: `animation: false` when `prefers-reduced-motion` asks.

## App example

```tsx
import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';

/** A theme token (oklch) as rgb, which every chart library reads. */
function token(name: string): string {
  const g = document.createElement('canvas').getContext('2d')!;
  g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
  g.fillRect(0, 0, 1, 1);
  const [r, gr, b] = g.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${gr}, ${b})`;
}

/** Calls `fn` when the host switches theme; returns the stop function. */
function onThemeChange(fn: () => void): () => void {
  const mo = new MutationObserver(fn);
  mo.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'data-color-theme'],
  });
  return () => mo.disconnect();
}

/** ECharts draws axes in its own fixed greys: set them from the tokens. */
const axis = () => ({
  axisLabel: { color: token('--muted-foreground') },
  axisLine: { lineStyle: { color: token('--border') } },
  axisTick: { lineStyle: { color: token('--border') } },
});

const UNITS = ['Unit 1', 'Unit 2', 'Unit 3'];
const THROUGHPUT = [420, 515, 380];

export default function App() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current!;
    const chart = echarts.init(el, null, { renderer: 'svg' });
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const paint = () =>
      chart.setOption({
        animation: !reduce,
        color: [token('--chart-1'), token('--chart-2')],
        textStyle: {
          color: token('--foreground'),
          fontFamily: getComputedStyle(document.body).fontFamily,
        },
        legend: { top: 0, textStyle: { color: token('--foreground') } },
        grid: { left: 48, right: 16, top: 40, bottom: 32 },
        xAxis: { type: 'category', data: UNITS, ...axis() },
        yAxis: { type: 'value', ...axis(), splitLine: { lineStyle: { color: token('--border') } } },
        series: [
          { name: 'Throughput', type: 'bar', data: THROUGHPUT, barWidth: '40%' },
          { name: 'Target', type: 'line', data: [450, 450, 450], symbol: 'none' },
        ],
      });
    paint();
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);
    const stop = onThemeChange(paint);
    return () => {
      stop();
      ro.disconnect();
      chart.dispose();
    };
  }, []);
  return (
    <div className="p-4">
      <div ref={ref} className="h-80 w-full" />
    </div>
  );
}
```
