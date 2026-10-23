import { describe, expect, it } from 'vitest';
import {
  CANVAS_DEFAULT_SIZE,
  canvasImports,
  canvasText,
  decodeHtmlEntities,
  parseCanvasHead,
  parseCanvasSize,
} from './canvas';

const CANVAS = `<!doctype html>
<html>
  <head>
    <title>Unit 3 feed section, P&amp;ID</title>
    <meta name="description" content="Pumps P-301A/B to exchanger E-302." />
    <meta name="canvas:size" content="1920x1080" />
    <meta name="canvas:theme" content="fixed" />
    <meta name="canvas:poster-at" content="2.5s" />
    <style>.x { color: red }</style>
  </head>
  <body>
    <!-- a comment the index must not read -->
    <h1>Feed <b>pumps</b></h1><p>Flow&nbsp;rate 12&#x2009;m3/h</p>
    <script type="module">
      import * as d3 from 'd3';
      import { animate } from "motion";
      import 'alpinejs';
      const m = await import('three');
      const secret = 'never indexed';
    </script>
    <script src="/canvas-runtime/plotly/plotly.min.js"></script>
    <script>import notAModule from 'classic';</script>
  </body>
</html>`;

describe('parseCanvasHead', () => {
  it('reads the head contract', () => {
    expect(parseCanvasHead(CANVAS)).toEqual({
      title: 'Unit 3 feed section, P&ID',
      description: 'Pumps P-301A/B to exchanger E-302.',
      size: { w: 1920, h: 1080 },
      theme: 'fixed',
      posterAt: 2.5,
    });
  });

  it('defaults what the head leaves out', () => {
    expect(parseCanvasHead('<html><body>hi</body></html>')).toEqual({
      title: '',
      description: '',
      size: { ...CANVAS_DEFAULT_SIZE },
      theme: 'follow',
      posterAt: null,
    });
  });

  it('reads attributes in any order and quote style', () => {
    const head = parseCanvasHead(
      "<head><meta content='fill' name=canvas:size><title> A </title></head>",
    );
    expect(head.size).toBe('fill');
    expect(head.title).toBe('A');
  });
});

describe('parseCanvasSize', () => {
  it('takes WxH within bounds, or fill', () => {
    expect(parseCanvasSize('1600x900')).toEqual({ w: 1600, h: 900 });
    expect(parseCanvasSize(' FILL ')).toBe('fill');
    expect(parseCanvasSize('50x50')).toBeNull();
    expect(parseCanvasSize('9000x900')).toBeNull();
    expect(parseCanvasSize('wide')).toBeNull();
    expect(parseCanvasSize(null)).toBeNull();
  });
});

describe('canvasText', () => {
  it('is the title, description and visible text, never script, style or comments', () => {
    const text = canvasText(CANVAS);
    expect(text).toContain('Unit 3 feed section, P&ID');
    expect(text).toContain('Pumps P-301A/B');
    expect(text).toContain('Feed pumps');
    expect(text).toContain('Flow rate 12');
    expect(text).not.toContain('never indexed');
    expect(text).not.toContain('color: red');
    expect(text).not.toContain('comment');
  });

  it('is deterministic, so an unchanged canvas changes nothing the index reads', () => {
    expect(canvasText(CANVAS)).toBe(canvasText(CANVAS));
    expect(canvasText(CANVAS.replace('red', 'blue'))).toBe(canvasText(CANVAS));
  });
});

describe('canvasImports', () => {
  it('lists module imports and script sources, not a classic script', () => {
    expect(canvasImports(CANVAS)).toEqual({
      modules: ['d3', 'motion', 'alpinejs', 'three'],
      scripts: ['/canvas-runtime/plotly/plotly.min.js'],
    });
  });
});

describe('decodeHtmlEntities', () => {
  it('decodes named and numeric references and leaves unknown ones', () => {
    expect(decodeHtmlEntities('a &lt;b&gt; &#65;&#x42; &unknown;')).toBe('a <b> AB &unknown;');
  });
});
