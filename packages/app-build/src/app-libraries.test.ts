/**
 * The vendored libraries a mini app may import (app-libraries.ts): each exact
 * specifier stays a bare import for the frame's import map (never bundled),
 * a near miss or a left-out library is refused with a message that names the
 * fix, and the import check knows their export shapes.
 */
import { describe, expect, it } from 'vitest';
import { buildApp, type AppSource } from './index';
import {
  APP_CANVAS_LIBRARIES,
  APP_LIBRARY_SPECIFIERS,
  APP_RUNTIME_LIBRARIES,
  appCanvasLibraries,
} from './app-libraries';
import { addRuntimeLibraries } from './build-runtime';
import { CANVAS_MODULE_SPECIFIERS } from './canvas-runtime';
import { LIBRARY_EXPORTS_FIXTURE, RUNTIME_EXPORTS_FIXTURE } from './runtime-exports.fixture';

/** The fixture plus the library shapes the canvas runtime manifest records
 *  (subsets; app-libraries.build.test.ts checks them against the real build). */
const RT: Record<string, string[]> = { ...RUNTIME_EXPORTS_FIXTURE, ...LIBRARY_EXPORTS_FIXTURE };

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

  it('refuses an import attribute on a library import', async () => {
    for (const spec of ['echarts', '@mantle/diagram-templates/browser']) {
      for (const attr of ["{ type: 'text' }", "{ type: 'json' }"]) {
        const res = await buildApp(
          app(`import * as x from '${spec}' with ${attr};\nconsole.log(x);`),
          { runtimeExports: RT },
        );
        expect(res.ok, `${spec} ${attr}`).toBe(false);
        expect(res.errors[0]!.text, `${spec} ${attr}`).toMatch(/import attribute|not allowed/);
      }
    }
  });

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

  it('every library carries a one-line hint an agent can read', () => {
    for (const l of [...APP_CANVAS_LIBRARIES, ...APP_RUNTIME_LIBRARIES]) {
      expect(l.hint.trim().length, l.specifier).toBeGreaterThan(3);
      expect(l.hint.length, l.specifier).toBeLessThanOrEqual(80);
      expect(l.hint, l.specifier).not.toMatch(/[\n\u2013\u2014]/);
    }
  });

  it('a runtime library may not take a runtime entry or specifier, nor a chunk name', () => {
    const base = (): { entries: Record<string, string>; specs: Record<string, string> } => ({
      entries: { host: 'h', react: 'r' },
      specs: { '@host': 'host' },
    });
    const lib = (entry: string, specifier = 'x-lib') => [
      { specifier, entry, guide: 'g', hint: 'h' },
    ];
    for (const [entry, specifier, why] of [
      ['host', 'x-lib', /entry 'host' is taken/],
      ['x-lib', '@host', /specifier '@host' is taken/],
      ['chunk', 'x-lib', /not a usable entry name/],
      ['chunk-a', 'x-lib', /not a usable entry name/],
      ['Bad Name', 'x-lib', /not a usable entry name/],
    ] as const) {
      const b = base();
      expect(() => addRuntimeLibraries(b.entries, b.specs, lib(entry, specifier))).toThrow(why);
    }
    const b = base();
    addRuntimeLibraries(b.entries, b.specs, lib('x-lib'));
    expect(b.specs['x-lib']).toBe('x-lib');
    expect(b.entries['x-lib']).toBe('export * from "x-lib";');
    // The same library twice is refused on the second pass.
    expect(() => addRuntimeLibraries(b.entries, b.specs, lib('x-lib'))).toThrow(/taken/);
  });
});
