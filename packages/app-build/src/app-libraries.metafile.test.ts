/**
 * The libraries an app imports are external: the bundler never opens their
 * files. Main's metafile backstop (inputsOutsideTheApp, index.ts) refuses a
 * build that read any file off the app, so a green build already says so;
 * this checks the metafile itself. esbuild is wrapped (not changed) to keep
 * each build's inputs.
 */
import { describe, expect, it, vi } from 'vitest';
import { RUNTIME_EXPORTS_FIXTURE } from './runtime-exports.fixture';

const seen = vi.hoisted(() => [] as string[][]);

vi.mock('esbuild', async (importOriginal) => {
  const real = (await importOriginal()) as { default: typeof import('esbuild') };
  const build = (async (options: Parameters<typeof real.default.build>[0]) => {
    const res = await real.default.build(options);
    seen.push(Object.keys(res.metafile?.inputs ?? {}));
    return res;
  }) as typeof real.default.build;
  return { ...real, default: { ...real.default, build }, build };
});

const { buildApp, APP_LIBRARY_SPECIFIERS } = await import('./index');

/** The runtime shapes of the libraries (subsets), as app-libraries.test.ts. */
const RT: Record<string, string[]> = {
  ...RUNTIME_EXPORTS_FIXTURE,
  echarts: ['init'],
  d3: ['select'],
  three: ['Scene'],
  'three/addons/controls/OrbitControls.js': ['OrbitControls'],
  konva: ['default'],
  katex: ['default'],
  '@mantle/diagram-templates/browser': ['render'],
};

describe('library imports read no file', () => {
  for (const spec of APP_LIBRARY_SPECIFIERS) {
    it(`'${spec}': the metafile holds the app's own files only`, async () => {
      seen.length = 0;
      const res = await buildApp(
        {
          entry: 'App.tsx',
          files: {
            'App.tsx': `import * as lib from '${spec}';\nconsole.log(lib);\nexport default function App() { return <div />; }\n`,
          },
        },
        { runtimeExports: RT },
      );
      expect(res.errors).toEqual([]);
      expect(seen).toHaveLength(1);
      const inputs = seen[0]!;
      expect(inputs).toContain('app:App.tsx');
      for (const input of inputs) {
        expect(input).not.toMatch(/node_modules|canvas-runtime|app-runtime|diagram-templates\//);
        expect(input === 'app:App.tsx' || input.endsWith('<stdin>'), input).toBe(true);
      }
    });
  }
});
