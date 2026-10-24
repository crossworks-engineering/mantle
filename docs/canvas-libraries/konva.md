# Konva in a canvas

Version: konva 10.9.0, as this brain's canvas runtime pins it.
Source: the Konva docs (konvajs.org, its llms.txt index and API reference)
and its changelog. Written for Mantle, not copied.

## Import

```js
import Konva from 'konva';
```

The default export. Use Konva for 2D drawings people interact with: shapes
they drag, click or connect, a layout they rearrange, a simple editor.
For a static drawing, plain SVG or D3 is lighter.

## Core API

- `const stage = new Konva.Stage({ container: 'id', width, height })`; the
  container is a `<div>` with that size.
- `const layer = new Konva.Layer(); stage.add(layer)`: each layer is its own
  `<canvas>`. Keep moving shapes on a layer of their own.
- Shapes: `Konva.Rect`, `Circle`, `Ellipse`, `Line` (`points: [x1, y1, x2, y2]`,
  `tension` for curves), `Arrow`, `Text`, `Path` (SVG path data),
  `RegularPolygon`, `Star`, `Wedge`; group them in `Konva.Group`.
- Common attributes: `x`, `y`, `fill`, `stroke`, `strokeWidth`,
  `cornerRadius`, `draggable: true`, `opacity`, `listening`.
- Events: `shape.on('click tap', fn)`, `'dragmove'`, `'mouseenter'`;
  `stage.getPointerPosition()`.
- Change and redraw: `shape.x(120)`, `shape.fill('...')`; a layer redraws
  itself on the next frame.
- Motion: `new Konva.Tween({ node, duration, x, opacity }).play()` or
  `new Konva.Animation((frame) => { ... }, layer).start()`.
- `Konva.Transformer` gives a selected shape resize and rotate handles.

## What changed (if you know Konva 9)

- 10.0 is ES modules only: `import Konva from 'konva'` (there is no
  CommonJS `require` in a canvas anyway).
- Text is now placed as the browser places it (CSS-like); old layouts may
  sit a pixel or two differently. `Konva.legacyTextRendering = true` brings
  back 9's placement.
- Filters can use the browser's native filters through `node.filters()`;
  custom filter functions now receive `(imageData, pixelRatio)`.
- `Konva.Animation.animations` is a `Set`; `Stage.bufferCanvas` is gone.
- 10.8 to 10.9: `Transformer.rotateMode()`, `Konva.beginUpdateBatch()`.

## In a canvas

- Colours: Konva cannot read `oklch()`: convert theme tokens with the
  `token()` helper in the example.
- Size: a fixed `canvas:size` and a stage of that size; the frame scales it.
  For `fill`, size the stage from `innerWidth` and `innerHeight` and resize
  it on `resize`.
- Reduced motion: skip tweens and animations when the viewer asks.
- Check it with `present_render`; dragging is for the viewer in Present.

## Example

```html
<!doctype html>
<html>
  <head>
    <title>Plot plan sketch</title>
    <meta name="description" content="Three units on a plot you can drag around, joined by a pipe rack line." />
    <meta name="canvas:size" content="1280x720" />
  </head>
  <body class="bg-background">
    <div id="stage" style="width: 1280px; height: 720px"></div>
    <script type="module">
      import Konva from 'konva';
      function token(name) {
        const c = document.createElement('canvas').getContext('2d');
        c.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
        c.fillRect(0, 0, 1, 1);
        const [r, g, b] = c.getImageData(0, 0, 1, 1).data;
        return `rgb(${r}, ${g}, ${b})`;
      }
      const stage = new Konva.Stage({ container: 'stage', width: 1280, height: 720 });
      const layer = new Konva.Layer();
      stage.add(layer);
      layer.add(new Konva.Text({ x: 40, y: 30, text: 'Plot plan sketch: drag the units', fontSize: 32, fill: token('--foreground') }));
      const rack = new Konva.Line({ points: [200, 360, 1080, 360], stroke: token('--muted-foreground'), strokeWidth: 6, dash: [16, 8] });
      layer.add(rack);
      const units = [
        { name: 'Unit 1', x: 160, colour: '--chart-1' },
        { name: 'Unit 2', x: 540, colour: '--chart-2' },
        { name: 'Unit 3', x: 920, colour: '--chart-3' },
      ];
      for (const u of units) {
        const g = new Konva.Group({ x: u.x, y: 260, draggable: true });
        g.add(new Konva.Rect({ width: 200, height: 200, cornerRadius: 8, fill: token(u.colour) }));
        g.add(new Konva.Text({ width: 200, y: 86, align: 'center', text: u.name, fontSize: 28, fill: token('--background') }));
        g.on('mouseenter', () => (stage.container().style.cursor = 'grab'));
        g.on('mouseleave', () => (stage.container().style.cursor = 'default'));
        layer.add(g);
      }
    </script>
  </body>
</html>
```
