/**
 * `canvas_library`: our own short guide to one library of the canvas
 * runtime, for the exact version the runtime pins (docs/canvas-libraries/).
 *
 * A model knows these libraries from their older versions (ECharts 5, D3 5,
 * framer-motion, reveal.js 4, Konva 9, three.js before colour management),
 * and writes canvases that fail in ways the picture shows only after a
 * save. Each guide says the import, the core API, what changed, the canvas
 * rules (no network, the import map, theme tokens, reduced motion, the
 * render check) and one complete example canvas, which a browser test
 * renders, so an upgrade that breaks it fails the gates
 * (canvas-render/library-examples.test.ts).
 *
 * The guides are files baked into the image (MANTLE_DOCS_ROOT, /app/docs in
 * production), read straight from disk like the diagram guides: no
 * collection, no index, no model call, no database.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { docsRoot } from '@mantle/files';
import type { BuiltinToolDef, ToolHandlerResult } from './types';
import { str } from './coerce';

export const CANVAS_LIBRARY_DIR = 'canvas-libraries';

export type CanvasLibrary = Readonly<{
  /** The name a caller passes, and the guide's file stem. */
  name: string;
  /** The npm package whose pinned version the guide is written for. */
  pkg: string;
  /** One line: what to reach for it for. */
  useFor: string;
  aliases?: readonly string[];
}>;

/** Every library the canvas runtime serves that has a guide. */
export const CANVAS_LIBRARIES: readonly CanvasLibrary[] = [
  {
    name: 'echarts',
    pkg: 'echarts',
    useFor: 'business charts and dashboards',
    aliases: ['apache-echarts'],
  },
  { name: 'd3', pkg: 'd3', useFor: 'custom charts, schematics, force graphs, scales and axes' },
  { name: 'three', pkg: 'three', useFor: '3D scenes', aliases: ['threejs', 'three.js'] },
  { name: 'motion', pkg: 'motion', useFor: 'animation', aliases: ['framer-motion', 'motion-one'] },
  { name: 'reveal.js', pkg: 'reveal.js', useFor: 'slide decks', aliases: ['reveal', 'revealjs'] },
  { name: 'konva', pkg: 'konva', useFor: '2D shapes people drag and click', aliases: ['konvajs'] },
  { name: 'katex', pkg: 'katex', useFor: 'typeset formulas', aliases: ['latex', 'math'] },
  {
    name: 'alpinejs',
    pkg: 'alpinejs',
    useFor: 'tabs, toggles, step-throughs',
    aliases: ['alpine'],
  },
];

const key = (s: string) => s.toLowerCase().trim().replace(/\s+/g, '');

export function resolveCanvasLibrary(name: string): CanvasLibrary | null {
  const k = key(name);
  if (!k) return null;
  return CANVAS_LIBRARIES.find((l) => l.name === k || (l.aliases ?? []).includes(k)) ?? null;
}

/** The guide's file, by its library name. */
export function guideFile(lib: CanvasLibrary): string {
  return `${lib.name.replace(/\.js$/, '')}.md`;
}

/** Where the guides may be: the docs root first, then the repo's docs/
 *  seen from a process's or a package's cwd. */
function candidateDirs(): string[] {
  const cwd = process.cwd();
  return [
    path.join(docsRoot(), CANVAS_LIBRARY_DIR),
    path.resolve(cwd, 'docs', CANVAS_LIBRARY_DIR),
    path.resolve(cwd, '..', 'docs', CANVAS_LIBRARY_DIR),
    path.resolve(cwd, '..', '..', 'docs', CANVAS_LIBRARY_DIR),
  ];
}

export async function readCanvasLibraryGuide(lib: CanvasLibrary): Promise<string | null> {
  for (const dir of candidateDirs()) {
    try {
      return await readFile(path.join(dir, guideFile(lib)), 'utf8');
    } catch {
      // try the next one
    }
  }
  return null;
}

/** The version a guide says it was written for (its header line). */
export function guideVersion(md: string, pkg: string): string | null {
  const m = new RegExp(`^Version: ${pkg.replace(/[.]/g, '\\.')} (\\S+),`, 'm').exec(md);
  return m?.[1] ?? null;
}

export async function canvasLibraryHandler(
  input: Record<string, unknown>,
): Promise<ToolHandlerResult> {
  const asked = str(input.name);
  const lib = resolveCanvasLibrary(asked);
  if (!lib) {
    return {
      ok: false,
      error: `No canvas library '${asked}'. Valid: ${CANVAS_LIBRARIES.map((l) => l.name).join(', ')}. Plain SVG and JS need no library; Plotly loads with the script tag the canvas_authoring skill gives.`,
    };
  }
  const md = await readCanvasLibraryGuide(lib);
  if (md === null) {
    return {
      ok: false,
      error: `The ${lib.name} guide (${CANVAS_LIBRARY_DIR}/${guideFile(lib)}) is not on this server. Check MANTLE_DOCS_ROOT; meanwhile follow the canvas_authoring skill alone.`,
    };
  }
  return {
    ok: true,
    output: {
      library: lib.name,
      version: guideVersion(md, lib.pkg),
      guide: md,
    },
  };
}

const canvas_library: BuiltinToolDef = {
  slug: 'canvas_library',
  policy: { effect: 'read', spends: 'none', scope: 'any' },
  name: 'Read a canvas library guide',
  description:
    'Return the guide to one library a Present canvas can import, for the exact version this brain serves: the import line, the core API, what changed from versions you may know, the canvas rules (no network, theme tokens, reduced motion) and one complete example canvas that renders. Call it before writing a canvas that uses that library; plain SVG and JS need none. Reads only; changes nothing.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: `The library: ${CANVAS_LIBRARIES.map((l) => l.name).join(', ')}.`,
      },
    },
    required: ['name'],
  },
  handler: (input) => canvasLibraryHandler(input),
};

export const CANVAS_LIBRARY_TOOLS: BuiltinToolDef[] = [canvas_library];
