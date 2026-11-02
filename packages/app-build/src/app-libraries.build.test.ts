/**
 * The libraries an app imports, against the REAL runtimes: this builds the
 * canvas runtime and the app runtime from the installed packages, as the
 * deploy does, then
 *
 * - holds the test fixture (LIBRARY_EXPORTS_FIXTURE) to the canvas
 *   runtime's manifest, so a library upgrade that drops a name the other
 *   tests rely on fails here (the app runtime's own drift test is
 *   runtime-exports.drift.test.ts);
 * - builds a sample app per library, and every canvas_library app guide's
 *   example App.tsx (docs/canvas-libraries/app/), with the real export map,
 *   so a guide that names an export the runtime lacks fails the gates
 *   without a browser (canvas-render/app-library-examples.test.ts then runs
 *   each one in a real frame).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_CANVAS_LIBRARIES, APP_LIBRARY_SPECIFIERS } from './app-libraries';
import { buildCanvasRuntime } from './canvas-runtime';
import { buildRuntime, type RuntimeManifest } from './build-runtime';
import { buildApp } from './index';
import { appLibraryScripts } from '@mantle/share-ui/app-frame-html';
import { LIBRARY_EXPORTS_FIXTURE } from './runtime-exports.fixture';

const ROOT = path.resolve(__dirname, '../../..');
const APP_GUIDES = path.join(ROOT, 'docs/canvas-libraries/app');

/** One small app per library: the imports a builder writes first. */
const SAMPLES: Record<string, string> = {
  mathjs:
    "import { evaluate, unit } from 'mathjs';\nconsole.log(evaluate('2 inch to cm'), unit(5, 'bar').toNumber('kPa'));",
  'date-fns':
    "import { format, addDays } from 'date-fns';\nconsole.log(format(addDays(new Date(2026, 0, 1), 3), 'yyyy-MM-dd'));",
  zod: "import { z } from 'zod';\nconsole.log(z.object({ tag: z.string().min(1) }).safeParse({ tag: 'P-101' }).success);",
  'fuse.js': "import Fuse from 'fuse.js';\nconsole.log(new Fuse(['pump', 'valve']).search('pmp'));",
  papaparse:
    "import Papa from 'papaparse';\nconsole.log(Papa.parse('a,b\\n1,2', { header: true }).data);",
  'pdf-lib':
    "import { PDFDocument, StandardFonts } from 'pdf-lib';\nvoid PDFDocument.create().then((d) => d.embedFont(StandardFonts.Helvetica));",
  qrcode: "import QRCode from 'qrcode';\nconsole.log(QRCode.create('TAG-1').modules.size);",
  'markdown-it':
    "import MarkdownIt from 'markdown-it';\nconsole.log(new MarkdownIt().render('# Hi'));",
  dompurify: "import DOMPurify from 'dompurify';\nconsole.log(DOMPurify.sanitize('<b>ok</b>'));",
  '@tanstack/react-table':
    "import { useTable, tableFeatures, createColumnHelper } from '@tanstack/react-table';\nconsole.log(useTable, tableFeatures, createColumnHelper);",
  '@tanstack/react-virtual':
    "import { useVirtualizer } from '@tanstack/react-virtual';\nconsole.log(useVirtualizer);",
  '@dnd-kit/core':
    "import { DndContext, useDraggable } from '@dnd-kit/core';\nconsole.log(DndContext, useDraggable);",
  '@dnd-kit/sortable':
    "import { SortableContext, useSortable, arrayMove } from '@dnd-kit/sortable';\nconsole.log(SortableContext, useSortable, arrayMove);",
};

function appExampleOf(md: string): string {
  const m = /## App example\n+```tsx\n([\s\S]*?)\n```/.exec(md);
  if (!m) throw new Error('no ## App example tsx block');
  return m[1]!;
}

describe('the app libraries, against the real runtimes', () => {
  let tmp: string;
  let canvas: Awaited<ReturnType<typeof buildCanvasRuntime>>;
  let app: RuntimeManifest;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-libs-'));
    canvas = await buildCanvasRuntime(
      path.join(tmp, 'canvas-runtime'),
      '/canvas-runtime/',
      path.join(ROOT, 'server/web'),
    );
    app = await buildRuntime(path.join(tmp, 'app-runtime'), '/app-runtime/', canvas);
  }, 240_000);

  afterAll(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('the fixture covers every canvas library an app reads, with real names only', () => {
    expect(Object.keys(LIBRARY_EXPORTS_FIXTURE).sort()).toEqual(
      APP_CANVAS_LIBRARIES.map((l) => l.specifier).sort(),
    );
    for (const [spec, names] of Object.entries(LIBRARY_EXPORTS_FIXTURE)) {
      const real = new Set(canvas.exports[spec]);
      for (const name of names) expect(real, `${spec} should export ${name}`).toContain(name);
    }
  });

  it('every library an app may import is in the app import map, at a file that exists', () => {
    for (const spec of APP_LIBRARY_SPECIFIERS) {
      const url = app.imports[spec];
      expect(url, spec).toBeTruthy();
      const dir = url!.startsWith('/canvas-runtime/') ? 'canvas-runtime' : 'app-runtime';
      expect(fs.existsSync(path.join(tmp, dir, path.basename(url!))), url).toBe(true);
      expect(app.exports[spec]?.length, spec).toBeGreaterThan(0);
    }
  });

  it('the app frame CSP allows every library file the app import map names', () => {
    const lib = Object.values(app.imports).filter((u) => u.startsWith('/canvas-runtime/'));
    expect(lib.length).toBeGreaterThan(0);
    expect(appLibraryScripts(app.imports)).toEqual([...new Set(lib)].sort());
  });

  it('there is a sample for every library', () => {
    expect(Object.keys(SAMPLES).every((s) => APP_LIBRARY_SPECIFIERS.includes(s))).toBe(true);
  });

  for (const [spec, body] of Object.entries(SAMPLES)) {
    it(`a sample app importing '${spec}' builds, with the import left bare`, async () => {
      const res = await buildApp(
        {
          entry: 'App.tsx',
          files: { 'App.tsx': `${body}\nexport default function App() { return <div />; }\n` },
        },
        { runtimeExports: app.exports },
      );
      expect(res.errors).toEqual([]);
      expect(res.ok).toBe(true);
      expect(res.code).toContain(JSON.stringify(spec));
      expect(res.code!.length).toBeLessThan(5000);
    });
  }

  const guides = fs.readdirSync(APP_GUIDES).filter((f) => f.endsWith('.md'));
  for (const file of guides) {
    it(`the ${file} app example builds against the real export map`, async () => {
      const example = appExampleOf(fs.readFileSync(path.join(APP_GUIDES, file), 'utf8'));
      const res = await buildApp(
        { entry: 'App.tsx', files: { 'App.tsx': example } },
        { runtimeExports: app.exports },
      );
      expect(res.errors).toEqual([]);
      expect(res.ok).toBe(true);
    });
  }

  it('the papaparse module refuses download and worker, and parses text', async () => {
    const url = canvas.imports['papaparse']!;
    const mod = (await import(path.join(tmp, 'canvas-runtime', path.basename(url)))) as {
      default: { parse: (i: string, c?: Record<string, unknown>) => { data: unknown[] } };
    };
    const Papa = mod.default;
    expect(() => Papa.parse('https://x.invalid/a.csv', { download: true })).toThrow(/download/);
    expect(() => Papa.parse('a,b', { worker: true })).toThrow(/worker/);
    expect(Papa.parse('a,b\n1,2', { header: true }).data).toEqual([{ a: '1', b: '2' }]);
  });
});
