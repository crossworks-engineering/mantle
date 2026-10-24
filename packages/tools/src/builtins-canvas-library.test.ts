/**
 * canvas_library: one guide per library of the canvas runtime, for the
 * version the runtime pins. Pinned here: every library has its guide, each
 * guide is 3 to 6 KB, names the exact pinned version (a bump without a new
 * guide fails here), and holds one complete example canvas that passes the
 * save-time load check. canvas-render/library-examples.browser.test.ts
 * renders each example in a real browser.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CANVAS_MODULE_SPECIFIERS } from '@mantle/app-build';
import { canvasLoadProblems } from '@mantle/content-core/canvas';
import {
  CANVAS_LIBRARIES,
  CANVAS_LIBRARY_TOOLS,
  guideFile,
  guideVersion,
  resolveCanvasLibrary,
} from './builtins-canvas-library';

const ROOT = path.resolve(__dirname, '../../..');
const GUIDES = path.join(ROOT, 'docs/canvas-libraries');
const pinned = JSON.parse(readFileSync(path.join(ROOT, 'packages/app-build/package.json'), 'utf8'))
  .dependencies as Record<string, string>;
const tool = CANVAS_LIBRARY_TOOLS[0]!;
const ctx = { ownerId: 'owner-1' };

/** The one complete example canvas of a guide. */
export function exampleOf(md: string): string {
  const m = /## Example\n+```html\n([\s\S]*?)\n```/.exec(md);
  if (!m) throw new Error('no ## Example html block');
  return m[1]!;
}

describe('canvas_library guides', () => {
  it('has one guide per library and a library per guide', () => {
    const files = readdirSync(GUIDES).filter((f) => f.endsWith('.md'));
    expect(files.sort()).toEqual(CANVAS_LIBRARIES.map(guideFile).sort());
  });

  for (const lib of CANVAS_LIBRARIES) {
    it(`${lib.name}: 3 to 6 KB, the pinned version, an example that loads`, () => {
      const md = readFileSync(path.join(GUIDES, guideFile(lib)), 'utf8');
      expect(md.length).toBeGreaterThanOrEqual(3000);
      expect(md.length).toBeLessThanOrEqual(6000);
      expect(guideVersion(md, lib.pkg), 'the header names the pinned version').toBe(
        pinned[lib.pkg],
      );
      expect(md).toMatch(/^Source: /m);
      expect(md).not.toMatch(/[\u2013\u2014]/);
      const example = exampleOf(md);
      expect(example).toMatch(/<title>[^<]+<\/title>/);
      expect(example).toMatch(/name="canvas:size"/);
      expect(canvasLoadProblems(example, CANVAS_MODULE_SPECIFIERS)).toEqual([]);
    });
  }

  it('resolves names and aliases', () => {
    expect(resolveCanvasLibrary('ECharts')?.name).toBe('echarts');
    expect(resolveCanvasLibrary('threejs')?.name).toBe('three');
    expect(resolveCanvasLibrary('framer-motion')?.name).toBe('motion');
    expect(resolveCanvasLibrary('reveal')?.name).toBe('reveal.js');
    expect(resolveCanvasLibrary('gsap')).toBeNull();
  });
});

describe('the canvas_library tool', () => {
  it('returns the guide and its version; every reply stays small', async () => {
    let largest = 0;
    for (const lib of CANVAS_LIBRARIES) {
      const res = await tool.handler({ name: lib.name }, ctx);
      expect(res.ok, lib.name).toBe(true);
      const out = (res as { output: { library: string; version: string; guide: string } }).output;
      expect(out.library).toBe(lib.name);
      expect(out.version).toBe(pinned[lib.pkg]);
      largest = Math.max(largest, Buffer.byteLength(JSON.stringify(out)));
    }
    // The largest reply today is three.js, about 5.5 KB of JSON.
    expect(largest).toBeLessThan(8 * 1024);
  });

  it('names the valid libraries for an unknown one', async () => {
    const res = await tool.handler({ name: 'gsap' }, ctx);
    expect(res.ok).toBe(false);
    const error = (res as { error: string }).error;
    for (const lib of CANVAS_LIBRARIES) expect(error).toContain(lib.name);
  });
});
