/**
 * The snapshot sanitizer (svg-sanitize.ts) against the ways a link hides from
 * a text search: another prefix bound to the xlink or SVG namespace, a
 * prefixed element, CSS url(), use and feImage, xml:base, a DOCTYPE with
 * entities, an inline SVG picture. Each case must come out with no way to
 * reach a file, and a real export's shape must come out drawable.
 */
import { describe, expect, it } from 'vitest';
import {
  SVG_MAX_DEPTH,
  SVG_MAX_ELEMENTS,
  SVG_MAX_USES,
  allowedHref,
  rasterSize,
  sanitizeSceneSvg,
} from './svg-sanitize';

/** A PNG header of a given size: all the pixel budget reads. */
const png = (w: number, h = 1) => {
  const b = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(b);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b.toString('base64');
};
const P1 = png(1);
const P2 = png(2);
const P3 = png(3);

const OPEN =
  '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100" width="100" height="100">';
const doc = (body: string, open = OPEN) => `${open}${body}</svg>`;
/** No trace of the path anywhere in the output, under any spelling. */
const clean = (out: string) => {
  const body = out.replace(' xmlns="http://www.w3.org/2000/svg"', '');
  expect(body).not.toMatch(/etc\/hosts|hosts"|file:|https?:|xml:base|xmlns/i);
  return out;
};

describe('sanitizeSceneSvg: links under any name', () => {
  it('drops a link under another prefix bound to the xlink namespace', () => {
    const out = sanitizeSceneSvg(
      doc(
        '<image xmlns:q="http://www.w3.org/1999/xlink" q:href="/etc/hosts" width="10" height="10"/>',
      ),
    ).svg;
    expect(clean(out)).toContain('<image width="10" height="10">');
  });

  it('drops an attribute bound to the SVG namespace under a prefix', () => {
    const out = sanitizeSceneSvg(
      doc('<image xmlns:s="http://www.w3.org/2000/svg" s:href="/etc/hosts" width="10"/>'),
    ).svg;
    clean(out);
  });

  it('drops a prefixed element, whatever namespace its prefix names', () => {
    const out = sanitizeSceneSvg(
      doc(
        '<p:image xmlns:p="http://www.w3.org/2000/svg" href="/etc/hosts"/><x:image xmlns:x="urn:other" href="/etc/hosts"/>',
      ),
    ).svg;
    // Both are dropped: an export never prefixes an element.
    expect(clean(out)).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"></svg>',
    );
  });

  it('keeps #id and inline raster pictures on use and image, nothing else', () => {
    const out = sanitizeSceneSvg(
      doc(
        `<use xlink:href="#a"/><image href="data:image/png;base64,${P1}"/>` +
          '<image href="data:image/svg+xml;base64,PHN2Zy8+"/><image href="file:///etc/hosts"/>' +
          '<rect href="#a"/><image href="https://example.invalid/x.png"/>',
      ),
    ).svg;
    expect(out).toContain('<use href="#a">');
    expect(out).toContain(`<image href="data:image/png;base64,${P1}">`);
    expect(out).not.toContain('svg+xml');
    expect(out).toContain('<rect>');
    clean(out);
  });

  it('drops feImage, filters, foreignObject, script and style', () => {
    const out = sanitizeSceneSvg(
      doc(
        '<filter id="f"><feImage href="/etc/hosts"/></filter><foreignObject><div>x</div></foreignObject>' +
          '<script>1</script><style>@import url(/etc/hosts); rect{fill:url(/etc/hosts)}</style><g filter="url(#f)"/>',
      ),
    ).svg;
    expect(out).not.toMatch(/filter|feImage|foreignObject|script|style|@import/i);
    clean(out);
  });

  it('keeps url(#id) and drops every other url(), in attributes and style', () => {
    const out = sanitizeSceneSvg(
      doc(
        '<g clip-path="url(#c)" mask="url(/etc/hosts)" fill="url(\'file:///etc/hosts\')"' +
          ' style="fill:url(/etc/hosts);stroke:#f00;stro\\ke:red;white-space:pre"/>',
      ),
    ).svg;
    expect(out).toContain('clip-path="url(#c)"');
    expect(out).toContain('style="stroke:#f00;white-space:pre"');
    expect(out).not.toMatch(/mask=|fill=|\\/);
    clean(out);
  });

  it('drops xml:base and every namespaced attribute', () => {
    const out = sanitizeSceneSvg(
      doc('<g xml:base="file:///etc/"><image href="hosts" xml:space="preserve"/></g>'),
    ).svg;
    expect(out).toContain('<g><image></image></g>');
    clean(out);
  });

  it('refuses a DOCTYPE and an undefined entity', () => {
    const withEntity =
      '<!DOCTYPE svg [<!ENTITY p "/etc/hosts">]>' + doc('<image href="&p;" width="1" height="1"/>');
    expect(() => sanitizeSceneSvg(withEntity)).toThrow(/DOCTYPE/);
    expect(() => sanitizeSceneSvg(doc('<image href="&p;"/>'))).toThrow();
  });

  it('refuses a document that is not an SVG, or has no size', () => {
    expect(() => sanitizeSceneSvg('<html xmlns="http://www.w3.org/2000/svg"/>')).toThrow(
      /not an SVG/,
    );
    expect(() => sanitizeSceneSvg('<svg xmlns="urn:x" viewBox="0 0 1 1"/>')).toThrow(/not an SVG/);
    expect(() => sanitizeSceneSvg('<svg xmlns="http://www.w3.org/2000/svg"/>')).toThrow(
      /no usable size/,
    );
    expect(() => sanitizeSceneSvg('<svg')).toThrow();
  });

  it('caps elements and depth', () => {
    const many = doc('<g/>'.repeat(SVG_MAX_ELEMENTS + 1));
    expect(() => sanitizeSceneSvg(many)).toThrow(/too many elements/);
    const deep = doc('<g>'.repeat(SVG_MAX_DEPTH + 1) + '</g>'.repeat(SVG_MAX_DEPTH + 1));
    expect(() => sanitizeSceneSvg(deep)).toThrow(/too deep/);
  });
});

describe('sanitizeSceneSvg: the reader image rule', () => {
  const body =
    `<defs><symbol id="image-ok"><image href="data:image/png;base64,${P1}"/></symbol>` +
    `<symbol id="image-crop-hidden-123"><image href="data:image/png;base64,${P2}"/></symbol></defs>` +
    `<image href="data:image/png;base64,${P3}"/>`;

  it('keeps every image when no rule is given (the owner)', () => {
    const out = sanitizeSceneSvg(doc(body)).svg;
    expect(out).toContain(P1);
    expect(out).toContain(P2);
    expect(out).toContain(P3);
  });

  it('keeps only images inside a symbol of an allowed scene file', () => {
    const out = sanitizeSceneSvg(doc(body), { keepImagesOf: new Set(['ok']) }).svg;
    expect(out).toContain(P1);
    expect(out).not.toContain(P2);
    // An image outside any symbol has no file to check: never kept.
    expect(out).not.toContain(P3);
  });

  it('never keeps a prefixed image, even in an allowed symbol', () => {
    const out = sanitizeSceneSvg(
      doc(
        '<defs><symbol id="image-ok"><p:image xmlns:p="http://www.w3.org/2000/svg" href="data:image/png;base64,UFJF"/></symbol></defs>',
      ),
    ).svg;
    expect(out).not.toContain('UFJF');
  });
});

describe('sanitizeSceneSvg: a real export survives', () => {
  it('keeps shapes, text, symbols, masks and reads the fonts out as data', () => {
    const input =
      '<svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200" width="400" height="200">' +
      '<!-- svg-source:excalidraw --><metadata></metadata><defs><style class="style-fonts">\n' +
      '  @font-face { font-family: Excalifont; src: url(data:font/woff2;base64,d09GMgABAAA=); }</style>' +
      `<symbol id="image-f1"><image href="data:image/png;base64,${P1}" preserveAspectRatio="none" width="100%" height="100%"/></symbol></defs>` +
      '<rect x="0" y="0" width="400" height="200" fill="#ffffff"/>' +
      '<g stroke-linecap="round" transform="translate(10 10) rotate(0 90 50)"><path d="M0 0 L180 0" stroke="#1971c2" stroke-width="2" fill="none"/></g>' +
      '<mask id="m"><rect fill="#fff" width="10" height="10"/></mask><g mask="url(#m)"><use href="#image-f1" width="50" height="50"/></g>' +
      '<a href="https://example.invalid/"><g transform="translate(100 60)"><text x="0" y="0" font-family="Excalifont, Xiaolai, Segoe UI Emoji" font-size="28px" fill="#e03131" text-anchor="middle" style="white-space: pre;" direction="ltr" dominant-baseline="alphabetic">Hello &amp; &lt;bye&gt;</text></g></a>' +
      '</svg>';
    const out = sanitizeSceneSvg(input);
    expect(out.sceneBox).toEqual([0, 0, 400, 200]);
    expect(out.fonts).toEqual([{ family: 'Excalifont', base64: 'd09GMgABAAA=' }]);
    expect(out.svg).toContain(`<symbol id="image-f1"><image href="data:image/png;base64,${P1}"`);
    expect(out.svg).toContain('<use href="#image-f1" width="50" height="50">');
    expect(out.svg).toContain('<g mask="url(#m)">');
    expect(out.svg).toContain(
      '<text x="0" y="0" font-family="Excalifont, Xiaolai, Segoe UI Emoji" font-size="28px" fill="#e03131" text-anchor="middle" style="white-space:pre" direction="ltr" dominant-baseline="alphabetic">Hello &amp; &lt;bye&gt;</text>',
    );
    // The link wrapper became a plain group.
    expect(out.svg).not.toContain('example.invalid');
    expect(out.svg).not.toContain('@font-face');
  });

  it('a region rewrites the root view only', () => {
    const out = sanitizeSceneSvg(doc('<rect width="1" height="1"/>'), {
      region: { x: 0.5, y: 0, width: 0.5, height: 0.25 },
    });
    expect(
      out.svg.startsWith(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="50 0 50 25" width="50" height="25">',
      ),
    ).toBe(true);
    expect(out.sceneBox).toEqual([0, 0, 100, 100]);
  });
});

describe('allowedHref', () => {
  it('takes a local ref or an inline raster picture only', () => {
    expect(allowedHref(' #a ')).toBe('#a');
    expect(allowedHref('data:image/webp;base64,AA==')).toBe('data:image/webp;base64,AA==');
    for (const bad of [
      '/etc/hosts',
      'file:///etc/hosts',
      'hosts',
      'data:image/svg+xml;base64,AA==',
      'data:text/html,x',
      'data:image/png,raw',
      '#a b',
      'https://example.invalid/a.png',
    ]) {
      expect(allowedHref(bad), bad).toBeNull();
    }
  });
});

describe('sanitizeSceneSvg: decode budget (re-audit M)', () => {
  const pic = (b64: string, mime = 'png') =>
    `<image href="data:image/${mime};base64,${b64}" width="10" height="10"/>`;

  it('drops a picture whose header says it decodes past the per-picture budget', () => {
    const huge = png(20_000, 20_000);
    const out = sanitizeSceneSvg(doc(pic(huge) + pic(P1))).svg;
    expect(out).not.toContain(huge);
    expect(out).toContain(P1);
  });

  it('drops pictures past the total budget, keeps those before it', () => {
    const big = png(5_000, 5_000); // 25 MP each: one fits, two pass the 40 MP total
    const big2 = png(4_999, 5_000);
    const out = sanitizeSceneSvg(doc(pic(big) + pic(big2))).svg;
    expect(out).toContain(big);
    expect(out).not.toContain(big2);
  });

  it('drops a picture whose size it cannot read', () => {
    const out = sanitizeSceneSvg(doc(pic('AAAA') + pic('/9j/AA==', 'jpeg'))).svg;
    expect(out).not.toContain('base64,');
  });

  it('reads JPEG, GIF and WebP headers', () => {
    // JPEG: SOI, an APP0 segment, then SOF0 with height 300, width 400.
    const jpeg = Buffer.from(
      'ffd8ffe000104a46494600010100000100010000ffc0001108012c019003012200021101031101',
      'hex',
    );
    expect(rasterSize(jpeg)).toEqual({ width: 400, height: 300 });
    const gif = Buffer.from('474946383961' + '2c01' + 'c800' + '000000', 'hex');
    expect(rasterSize(gif)).toEqual({ width: 300, height: 200 });
    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0, 'latin1');
    webp.write('WEBPVP8X', 8, 'latin1');
    webp.writeUIntLE(639, 24, 3);
    webp.writeUIntLE(479, 27, 3);
    expect(rasterSize(webp)).toEqual({ width: 640, height: 480 });
    expect(rasterSize(Buffer.from('not a picture'))).toBeNull();
  });

  it('caps use elements', () => {
    expect(() => sanitizeSceneSvg(doc('<use href="#a"/>'.repeat(SVG_MAX_USES + 1)))).toThrow(
      /too many use/,
    );
  });
});
