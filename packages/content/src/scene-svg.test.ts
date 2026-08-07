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
});
