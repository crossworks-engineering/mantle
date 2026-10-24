/**
 * The vendored libraries a mini app may import (app-libraries.ts): each exact
 * specifier stays a bare import for the frame's import map (never bundled),
 * a near miss or a left-out library is refused with a message that names the
 * fix, and the import check knows their export shapes.
 */
import { describe, expect, it } from 'vitest';
import { buildApp, type AppSource } from './index';
import { APP_CANVAS_LIBRARIES, APP_LIBRARY_SPECIFIERS, appCanvasLibraries } from './app-libraries';
import { CANVAS_MODULE_SPECIFIERS } from './canvas-runtime';
import { RUNTIME_EXPORTS_FIXTURE } from './runtime-exports.fixture';

/** The fixture plus the library shapes the canvas runtime manifest records
 *  (subsets; the browser test checks the real build). */
const RT: Record<string, string[]> = {
  ...RUNTIME_EXPORTS_FIXTURE,
  echarts: ['init', 'graphic', 'use'],
  d3: ['select', 'scaleLinear', 'axisBottom'],
  three: ['Scene', 'WebGLRenderer', 'PerspectiveCamera', 'Mesh'],
  'three/addons/controls/OrbitControls.js': ['OrbitControls'],
  konva: ['default'],
  katex: ['default'],
  '@mantle/diagram-templates/browser': ['domMeasurer', 'mount', 'render'],
};

const app = (body: string): AppSource => ({
  entry: 'App.tsx',
  files: { 'App.tsx': `${body}\nexport default function App() { return <div />; }\n` },
});

describe('mini-app library imports', () => {
  it('every canvas library an app reads is one the canvas runtime serves', () => {
    for (const { specifier } of APP_CANVAS_LIBRARIES) {
      expect(CANVAS_MODULE_SPECIFIERS).toContain(specifier);
    }
  });

  for (const spec of APP_LIBRARY_SPECIFIERS) {
    it(`'${spec}' stays a bare import (served by the import map, not bundled)`, async () => {
      const res = await buildApp(app(`import * as lib from '${spec}';\nconsole.log(lib);`), {
        runtimeExports: RT,
      });
      expect(res.errors).toEqual([]);
      expect(res.ok).toBe(true);
      expect(res.code).toContain(JSON.stringify(spec));
      // Bundling any of them would run to tens of kilobytes at least.
      expect(res.code!.length).toBeLessThan(5000);
    });
  }

  it('refuses a subpath of an allowed library', async () => {
    const res = await buildApp(app("import { use } from 'echarts/core';\nuse([]);"), {
      runtimeExports: RT,
    });
    expect(res.ok).toBe(false);
    expect(res.errors[0]!.text).toContain("Import 'echarts/core' is not allowed");
    expect(res.errors[0]!.text).toContain('canvas_library');
  });

  it('refuses the libraries left out, with the reason', async () => {
    for (const [spec, why] of [
      ['reveal.js', 'slide-deck'],
      ['alpinejs', 'unsafe-eval'],
      ['motion', "'motion/react'"],
    ] as const) {
      const res = await buildApp(app(`import x from '${spec}';\nconsole.log(x);`), {
        runtimeExports: RT,
      });
      expect(res.ok, spec).toBe(false);
      expect(res.errors[0]!.text).toContain(`'${spec}' is not available in a mini app`);
      expect(res.errors[0]!.text).toContain(why);
    }
  });

  it('refuses an unlisted @-scoped package', async () => {
    const res = await buildApp(app("import x from '@mantle/diagram-templates';\nconsole.log(x);"), {
      runtimeExports: RT,
    });
    expect(res.ok).toBe(false);
    expect(res.errors[0]!.text).toContain("Unknown import '@mantle/diagram-templates'");
  });

  it('the import check catches the usual wrong shape: a default import of echarts', async () => {
    const res = await buildApp(app("import echarts from 'echarts';\nconsole.log(echarts);"), {
      runtimeExports: RT,
    });
    expect(res.ok).toBe(false);
    expect(res.errors[0]!.text).toContain("'echarts' has no default export");
  });

  it('accepts the default import of konva and katex', async () => {
    const res = await buildApp(
      app("import Konva from 'konva';\nimport katex from 'katex';\nconsole.log(Konva, katex);"),
      { runtimeExports: RT },
    );
    expect(res.errors).toEqual([]);
  });

  it('appCanvasLibraries throws when the canvas manifest lacks a library', () => {
    expect(() => appCanvasLibraries({ imports: {}, exports: {} })).toThrow(/echarts/);
    const imports = Object.fromEntries(
      APP_CANVAS_LIBRARIES.map((l) => [l.specifier, `/canvas-runtime/${l.guide}.js`]),
    );
    const exports = Object.fromEntries(APP_CANVAS_LIBRARIES.map((l) => [l.specifier, ['x']]));
    const out = appCanvasLibraries({
      imports: { ...imports, 'reveal.js': '/canvas-runtime/reveal.js' },
      exports,
    });
    // Only the app subset: a left-out library never reaches the app map.
    expect(Object.keys(out.imports).sort()).toEqual(
      APP_CANVAS_LIBRARIES.map((l) => l.specifier).sort(),
    );
    expect(out.imports['reveal.js']).toBeUndefined();
  });
});
