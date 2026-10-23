import { describe, expect, it } from 'vitest';
import { buildCanvasFrameCsp, buildCanvasFrameHtml } from './canvas-frame-html';

const ORIGIN = 'https://brain.example.test';

describe('buildCanvasFrameCsp', () => {
  const csp = buildCanvasFrameCsp(ORIGIN, ['https://app.example.test']);
  const directives = new Map(
    csp.split(';').map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name, values.join(' ')] as const;
    }),
  );

  it('sandboxes the document and closes every network door', () => {
    expect(directives.get('sandbox')).toBe('allow-scripts');
    expect(directives.get('default-src')).toBe("'none'");
    expect(directives.get('connect-src')).toBe("'none'");
    expect(directives.get('frame-src')).toBe("'none'");
    expect(directives.get('form-action')).toBe("'none'");
    expect(directives.get('base-uri')).toBe("'none'");
  });

  it('loads script only inline and from the vendored runtime', () => {
    expect(directives.get('script-src')).toBe(
      `'unsafe-inline' 'unsafe-eval' ${ORIGIN}/canvas-runtime/`,
    );
  });

  it('never lists the brain origin for images or media: no GET at our own API', () => {
    expect(directives.get('img-src')).toBe('data: blob:');
    expect(directives.get('media-src')).toBe('data: blob:');
  });

  it('is framed only by the brain and the named owner UI origins', () => {
    expect(directives.get('frame-ancestors')).toBe(`${ORIGIN} https://app.example.test`);
  });
});

describe('buildCanvasFrameHtml', () => {
  const base = {
    source: '<!DOCTYPE html><html><head><title>T</title></head><body>hi</body></html>',
    css: '.p-6{padding:1.5rem}',
    importMapJson: '{"imports":{"d3":"/canvas-runtime/d3-AAAAAAAA.js"}}',
    cls: 'dark',
    colorTheme: 'ocean',
    size: { w: 1600, h: 900 } as const,
    theme: 'follow' as const,
    fontCss: '@font-face{font-family:"X"}',
  };

  it('puts the import map and prelude before the canvas, with one doctype', () => {
    const html = buildCanvasFrameHtml(base);
    expect(html.startsWith('<!doctype html>\n')).toBe(true);
    expect(html.match(/<!doctype/gi)).toHaveLength(1);
    expect(html.indexOf('type="importmap"')).toBeLessThan(html.indexOf('<html>'));
    expect(html).toContain('/canvas-runtime/d3-AAAAAAAA.js');
    expect(html).toContain('.p-6{padding:1.5rem}');
    expect(html).toContain('width:1600px!important');
  });

  it('bakes the theme in as JSON a value cannot break out of', () => {
    const html = buildCanvasFrameHtml({ ...base, cls: '</script><script>alert(1)</script>' });
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('\\u003c/script>');
  });

  it('a fixed-theme canvas ignores the host theme', () => {
    const html = buildCanvasFrameHtml({ ...base, theme: 'fixed' });
    expect(html).toContain('"cls":""');
    expect(html).toContain('"ct":null');
    expect(html).toContain('"follow":false');
  });

  it('a fill canvas gets the whole viewport, no letterbox', () => {
    const html = buildCanvasFrameHtml({ ...base, size: 'fill' });
    expect(html).not.toContain('--canvas-scale,1');
    expect(html).toContain('"size":null');
  });

  it('keeps CSS from closing its style tag', () => {
    const html = buildCanvasFrameHtml({ ...base, css: '.a{content:"</style><script>"}' });
    expect(html).not.toContain('</style><script>');
  });
});
