/**
 * canvas_library: one guide per library of the canvas runtime, for the
 * version the runtime pins. Pinned here: every library has its guide, each
 * guide is 3 to 6 KB, names the exact pinned version (a bump without a new
 * guide fails here), and holds one complete example canvas that passes the
 * save-time load check. canvas-render/library-examples.test.ts
 * renders each example in a real browser.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_LIBRARY_SPECIFIERS, CANVAS_MODULE_SPECIFIERS } from '@mantle/app-build';
import { canvasLoadProblems } from '@mantle/content-core/canvas';
import {
  APP_GUIDE_LIBRARIES,
  CANVAS_LIBRARIES,
  CANVAS_LIBRARY_TOOLS,
  appSpecifiers,
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

describe('canvas_library for a mini app', () => {
  const APP_GUIDES = path.join(GUIDES, 'app');
  const versionOf = (pkg: string) =>
    pkg === '@mantle/diagram-templates'
      ? (
          JSON.parse(
            readFileSync(path.join(ROOT, 'packages/diagram-templates/package.json'), 'utf8'),
          ) as { version: string }
        ).version
      : pinned[pkg];

  it('has one app guide per library an app may import, and no other', () => {
    const files = readdirSync(APP_GUIDES).filter((f) => f.endsWith('.md'));
    expect(files.sort()).toEqual(APP_GUIDE_LIBRARIES.map(guideFile).sort());
    // Every specifier an app may import is covered by a guide.
    const covered = APP_GUIDE_LIBRARIES.flatMap(appSpecifiers).sort();
    expect(covered).toEqual([...APP_LIBRARY_SPECIFIERS].sort());
  });

  for (const lib of APP_GUIDE_LIBRARIES) {
    it(`${lib.name}: 2 to 5 KB, the pinned version, an App.tsx that imports what it names`, () => {
      const md = readFileSync(path.join(APP_GUIDES, guideFile(lib)), 'utf8');
      expect(md.length).toBeGreaterThanOrEqual(2000);
      expect(md.length).toBeLessThanOrEqual(5000);
      expect(guideVersion(md, lib.pkg)).toBe(versionOf(lib.pkg));
      expect(md).toMatch(/^Source: /m);
      expect(md).not.toMatch(/[–—]/);
      expect(md).toContain('## In a React component');
      const example = appExampleOf(md);
      expect(example).toMatch(/export default function App\(/);
      for (const spec of appSpecifiers(lib)) expect(example).toContain(`from '${spec}'`);
    });
  }

  it('returns the app guide, with the library API from the canvas guide; replies stay small', async () => {
    let largest = 0;
    for (const lib of APP_GUIDE_LIBRARIES) {
      const res = await tool.handler({ name: lib.name, for: 'app' }, ctx);
      expect(res.ok, lib.name).toBe(true);
      const out = (
        res as {
          output: {
            library: string;
            for: string;
            import: string[];
            version: string;
            guide: string;
          };
        }
      ).output;
      expect(out.for).toBe('app');
      expect(out.import).toEqual(appSpecifiers(lib));
      expect(out.version).toBe(versionOf(lib.pkg));
      expect(out.guide).toContain('## App example');
      expect(out.guide).not.toContain('## In a canvas');
      if (CANVAS_LIBRARIES.includes(lib)) {
        expect(out.guide.indexOf('## Core API')).toBeGreaterThan(0);
        expect(out.guide.indexOf('## Core API')).toBeLessThan(
          out.guide.indexOf('## In a React component'),
        );
      }
      largest = Math.max(largest, Buffer.byteLength(JSON.stringify(out)));
    }
    expect(largest).toBeLessThan(10 * 1024);
  });

  it('a library apps cannot use says why, and what they can use', async () => {
    for (const [name, why] of [
      ['reveal.js', 'slide-deck'],
      ['alpine', 'unsafe-eval'],
    ] as const) {
      const res = await tool.handler({ name, for: 'app' }, ctx);
      expect(res.ok).toBe(false);
      const error = (res as { error: string }).error;
      expect(error).toContain(why);
      expect(error).toContain('echarts');
    }
  });

  it("the app guide's Allowed imports section lists every library", () => {
    const doc = readFileSync(path.join(ROOT, 'docs/app-authoring-guide.md'), 'utf8');
    const start = doc.indexOf('## Allowed imports');
    const section = doc.slice(start, doc.indexOf('\n## ', start + 3));
    for (const spec of APP_LIBRARY_SPECIFIERS) expect(section, spec).toContain(`\`${spec}\``);
  });

  it('the diagram templates app example draws in the app theme', () => {
    const md = readFileSync(path.join(GUIDES, 'app', 'diagram-templates.md'), 'utf8');
    expect(appExampleOf(md)).toContain("{ theme: 'tokens' }");
  });

  it('motion in an app is motion/react', async () => {
    const res = await tool.handler({ name: 'framer-motion', for: 'app' }, ctx);
    expect((res as { output: { import: string[] } }).output.import).toEqual(['motion/react']);
  });

  it('the diagram templates have an app guide but no canvas guide', async () => {
    const asCanvas = await tool.handler({ name: 'pid' }, ctx);
    expect(asCanvas.ok).toBe(false);
    expect((asCanvas as { error: string }).error).toContain('diagram_render');
    const asApp = await tool.handler({ name: 'pid', for: 'app' }, ctx);
    expect(asApp.ok).toBe(true);
  });
});

/** The one complete App.tsx of an app guide. */
export function appExampleOf(md: string): string {
  const m = /## App example\n+```tsx\n([\s\S]*?)\n```/.exec(md);
  if (!m) throw new Error('no ## App example tsx block');
  return m[1]!;
}
