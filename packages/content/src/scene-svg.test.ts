import { describe, expect, it } from 'vitest';
import { acceptSceneSvg, keepSvgImages, SCENE_SVG_MAX_BYTES, svgHasImages } from './scene-svg';

const OK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect/></svg>';

describe('acceptSceneSvg', () => {
  it('accepts a plain svg document', () => {
    expect(acceptSceneSvg(OK)).toBe(OK);
    expect(acceptSceneSvg(`  ${OK}  `)).toBe(OK);
    expect(acceptSceneSvg(`<?xml version="1.0"?>\n${OK}`)).toContain('<svg');
  });

  it('rejects non-strings and empties', () => {
    expect(acceptSceneSvg(undefined)).toBeNull();
    expect(acceptSceneSvg(null)).toBeNull();
    expect(acceptSceneSvg(42)).toBeNull();
    expect(acceptSceneSvg('')).toBeNull();
    expect(acceptSceneSvg('   ')).toBeNull();
  });

  it('rejects documents that are not svg', () => {
    expect(acceptSceneSvg('<html><svg/></html>')).toBeNull();
    expect(acceptSceneSvg('hello <svg/>')).toBeNull();
  });

  it('rejects scripts, foreignObject, handlers and js urls', () => {
    expect(acceptSceneSvg('<svg><script>alert(1)</script></svg>')).toBeNull();
    expect(acceptSceneSvg('<svg><foreignObject><div/></foreignObject></svg>')).toBeNull();
    expect(acceptSceneSvg('<svg>< script>x</script></svg>')).toBeNull();
    expect(acceptSceneSvg('<svg><rect onclick="x()"/></svg>')).toBeNull();
    expect(acceptSceneSvg('<svg><a href="javascript:x()">y</a></svg>')).toBeNull();
    expect(acceptSceneSvg('<svg><image href="data:text/html,x"/></svg>')).toBeNull();
    expect(acceptSceneSvg('<svg><iframe/></svg>')).toBeNull();
  });

  it('allows data:image urls (embedded raster fills)', () => {
    expect(acceptSceneSvg('<svg><image href="data:image/png;base64,AAAA"/></svg>')).not.toBeNull();
  });

  it('rejects oversized documents', () => {
    const big = `<svg>${'x'.repeat(SCENE_SVG_MAX_BYTES)}</svg>`;
    expect(acceptSceneSvg(big)).toBeNull();
  });

  // Every case below defeated the original filter and was confirmed executing
  // in a browser (docs/draw-audit-findings.md §2). The surfaces no longer
  // inject this markup, so none of them is exploitable today; these exist so
  // the second layer stops being trivially bypassable, and so a future author
  // who reverts to inline rendering fails loudly here first.
  describe('regressions from the 2026-08-07 audit', () => {
    it('rejects handlers separated by a solidus, not whitespace', () => {
      // `/` is a valid attribute separator to the HTML tokenizer, so this
      // parses onerror as a live attribute.
      expect(acceptSceneSvg('<svg><image href="/x"/onerror="alert(1)"/></svg>')).toBeNull();
      expect(acceptSceneSvg('<svg><svg/onload="alert(1)"></svg></svg>')).toBeNull();
      expect(acceptSceneSvg('<svg><rect/ONMOUSEOVER="alert(1)"/></svg>')).toBeNull();
    });

    it('rejects hyphenated handler names', () => {
      expect(acceptSceneSvg('<svg><animate onbegin="alert(1)"/></svg>')).toBeNull();
    });

    it('rejects character references, which the parser decodes after us', () => {
      // `&#106;avascript:` becomes a live javascript: URL in the DOM.
      expect(
        acceptSceneSvg('<svg><a xlink:href="&#106;avascript:alert(1)">x</a></svg>'),
      ).toBeNull();
      expect(
        acceptSceneSvg('<svg><set attributeName="href" to="&#106;avascript:alert(1)"/></svg>'),
      ).toBeNull();
    });

    it('still accepts what a real export contains', () => {
      // The two constructs that CANNOT be blocklisted: the font <style> block
      // exportToSvg always emits, and an <a href> from an element link.
      const real =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
        '<defs><style class="style-fonts">@font-face{font-family:Excalifont;' +
        'src:url(data:font/woff2;base64,AAAA)}</style></defs>' +
        '<a href="https://example.com/docs"><rect/></a>' +
        '<text>A &amp; B</text>' +
        '<image href="data:image/png;base64,AAAA"/></svg>';
      expect(acceptSceneSvg(real)).toBe(real);
    });
  });
});

/**
 * keepSvgImages (member logins, audit LOW): exportToSvg inlines each scene
 * image's bytes in a `<symbol id="image-<fileId>">`, so a member's copy of a
 * team drawing must lose the images whose file the member may not read.
 */
describe('keepSvgImages', () => {
  const img = (bytes: string) =>
    `<image href="data:image/png;base64,${bytes}" preserveAspectRatio="none" width="100%" height="100%"></image>`;
  const sym = (id: string, bytes: string) => `<symbol id="${id}">${img(bytes)}</symbol>`;
  const wrap = (defs: string, rest = '') =>
    `<svg xmlns="http://www.w3.org/2000/svg"><defs>${defs}</defs>${rest}<use href="#x"/></svg>`;

  it('keeps an allowed file’s image and empties every other symbol', () => {
    const svg = wrap(sym('image-okfile', 'T0s=') + sym('image-adminfile', 'U0VDUkVU'));
    const out = keepSvgImages(svg, new Set(['okfile']));
    expect(out).toBe(wrap(sym('image-okfile', 'T0s=') + '<symbol id="image-adminfile"></symbol>'));
  });

  it('reads the cropped form, file ids with dashes and digits included', () => {
    const svg = wrap(
      sym('image-crop-ok-12-3456789', 'T0s=') + sym('image-crop-admin-1-42', 'U0VDUkVU'),
    );
    const out = keepSvgImages(svg, new Set(['ok-12']));
    expect(out).toContain('T0s=');
    expect(out).not.toContain('U0VDUkVU');
  });

  it('removes images outside a symbol, feImage, and self-closed images', () => {
    const svg = wrap(
      `<symbol id='image-okfile'><image href="data:image/png;base64,T0s="/></symbol>`,
      `<image href="data:image/png;base64,T1VU"/><filter><feImage href="data:image/png;base64,RkU="/></filter>${img('TE9PU0U=')}`,
    );
    const out = keepSvgImages(svg, new Set(['okfile']));
    expect(out).toContain('T0s=');
    for (const gone of ['T1VU', 'RkU=', 'TE9PU0U=']) expect(out).not.toContain(gone);
  });

  it('keeps only an <image> inside an allowed symbol, never an feImage', () => {
    const svg = wrap(
      `<symbol id="image-okfile"><image href="data:image/png;base64,T0s="/><feImage href="data:image/png;base64,RkU="/></symbol>`,
    );
    const out = keepSvgImages(svg, new Set(['okfile']));
    expect(out).toContain('T0s=');
    expect(out).not.toContain('RkU=');
  });

  it('is not fooled by a > inside an attribute value, and fails closed', () => {
    const tricky = `<symbol id="image-adminfile" data-x="a>b"><image title="x>y" href="data:image/png;base64,U0VDUkVU"></image></symbol>`;
    expect(keepSvgImages(wrap(tricky), new Set(['okfile']))).not.toContain('U0VDUkVU');
    // An allowed symbol closes; an image after it is not inside it any more.
    const after = wrap(sym('image-okfile', 'T0s='), img('U0VDUkVU'));
    expect(keepSvgImages(after, new Set(['okfile']))).not.toContain('U0VDUkVU');
    // Nothing allowed: nothing kept.
    expect(keepSvgImages(wrap(sym('image-okfile', 'T0s=')), new Set())).not.toContain('T0s=');
  });

  it('leaves a drawing with no images byte for byte', () => {
    expect(keepSvgImages(OK, new Set())).toBe(OK);
    expect(svgHasImages(OK)).toBe(false);
    expect(svgHasImages(wrap(sym('image-a', 'T0s=')))).toBe(true);
    expect(svgHasImages('<svg><feImage href="x"/></svg>')).toBe(true);
  });
});
