import { describe, expect, it } from 'vitest';
import { acceptSceneSvg, SCENE_SVG_MAX_BYTES } from './scene-svg';

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
