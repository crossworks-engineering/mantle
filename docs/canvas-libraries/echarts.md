# ECharts in a canvas

Version: echarts 6.1.0, as this brain's canvas runtime pins it.
Source: the Apache ECharts handbook (echarts.apache.org), its 6.0 feature
overview and its 5 to 6 upgrade guide. Written for Mantle, not copied.

## Import

```js
import * as echarts from 'echarts';
```

The bare name only: the frame has no network, the import map serves the
whole library. Use it for business charts and dashboards: bars, lines, pies,
gauges, sankey, heatmaps, treemaps.

## Core API

- `const chart = echarts.init(el, null, { renderer: 'svg' })`: `el` needs a
  real width and height before `init`. `'svg'` keeps text crisp when the
  frame scales a fixed-size canvas; `'canvas'` is faster for many points.
- `chart.setOption({ xAxis, yAxis, series, tooltip, legend, grid, ... })`:
  `series[].type` is `'bar'`, `'line'`, `'pie'`, `'scatter'`, `'gauge'`,
  `'sankey'`, `'heatmap'`, `'treemap'` and more. Call it again with a
  partial option to update.
- `chart.resize()` after the container changes size (a `fill` canvas: on
  `resize`).
- `color: [...]` at the root sets the series palette.

## What changed (if you know ECharts 5)

- A new default theme in 6: other colours and spacing, and the legend sits
  at the bottom by default. Set `legend.top` yourself when it matters. The
  `echarts/theme/v5` file is not in the canvas runtime.
- Axis names and labels now avoid overflow and overlap on their own
  (`grid.outerBoundsMode: 'none'` turns it off). Do not add the old
  `containLabel` workarounds first; look at the render.
- Rich text labels inherit font and shadow settings from the plain label
  (`richInheritPlainLabel: false` restores 5).
- New: `chart.setTheme(name)` switches a theme at run time; a chord series
  (`type: 'chord'`); jitter on a category axis (`xAxis.jitter`) for
  beeswarm and jittered scatter.

## In a canvas

- Colours: the theme tokens are CSS variables (`--chart-1` to `--chart-5`,
  `--foreground`, `--muted-foreground`, `--border`), in `oklch()`, which
  ECharts cannot parse. Convert them with the `token()` helper in the
  example. Re-read them and call `setOption` again when the `<html>` class
  changes (the theme switched) if the canvas follows the theme.
- Animation: set `animation: false` when `prefers-reduced-motion` asks.
- Fonts: `textStyle: { fontFamily: getComputedStyle(document.body).fontFamily }`.
- Check it with `present_render` (a later `at_seconds` once the intro
  animation ends): an empty chart usually means a data shape the series
  does not read.

## Example

```html
<!doctype html>
<html>
  <head>
    <title>Throughput by unit</title>
    <meta name="description" content="Weekly throughput of three units as bars, with the target as a line." />
    <meta name="canvas:size" content="1280x720" />
  </head>
  <body class="bg-background p-10 text-foreground">
    <h1 class="mb-4 text-4xl font-semibold">Throughput by unit</h1>
    <div id="chart" style="width: 1200px; height: 560px"></div>
    <script type="module">
      import * as echarts from 'echarts';
      // A theme token (oklch) as rgb, which every chart library reads.
      function token(name) {
        const c = document.createElement('canvas').getContext('2d');
        c.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
        c.fillRect(0, 0, 1, 1);
        const [r, g, b] = c.getImageData(0, 0, 1, 1).data;
        return `rgb(${r}, ${g}, ${b})`;
      }
      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
      const chart = echarts.init(document.getElementById('chart'), null, { renderer: 'svg' });
      chart.setOption({
        animation: !reduce,
        color: [token('--chart-1'), token('--chart-2')],
        textStyle: { color: token('--foreground'), fontFamily: getComputedStyle(document.body).fontFamily, fontSize: 16 },
        legend: { top: 0, textStyle: { color: token('--foreground') } },
        grid: { left: 60, right: 20, top: 50, bottom: 40 },
        xAxis: { type: 'category', data: ['Unit 1', 'Unit 2', 'Unit 3'], axisLabel: { fontSize: 16 } },
        yAxis: { type: 'value', axisLabel: { fontSize: 16 }, splitLine: { lineStyle: { color: token('--border') } } },
        series: [
          { name: 'Throughput', type: 'bar', data: [420, 515, 380], barWidth: '40%' },
          { name: 'Target', type: 'line', data: [450, 450, 450], symbol: 'none' },
        ],
      });
    </script>
  </body>
</html>
```
