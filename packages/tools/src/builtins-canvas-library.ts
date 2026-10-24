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
 *
 * `for: 'app'` answers a mini-app builder instead: the same libraries as a
 * mini app imports them (app-build app-libraries.ts), from an app guide
 * (docs/canvas-libraries/app/): the import, the React pattern (mount in an
 * effect, clean up, resize, theme tokens) and one complete App.tsx, which a
 * browser test builds and renders (canvas-render/app-library-examples.test.ts).
 * The library's own API sections come from its canvas guide, so they are
 * written once.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { docsRoot } from '@mantle/files';
import {
  APP_CANVAS_LIBRARIES,
  APP_LIBRARIES_LEFT_OUT,
  APP_RUNTIME_LIBRARIES,
} from '@mantle/app-build';
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

/** Libraries a mini app imports that a canvas takes another way: a
 *  template canvas is written by `diagram_render` and `present_create`. */
export const APP_ONLY_LIBRARIES: readonly CanvasLibrary[] = [
  {
    name: 'diagram-templates',
    pkg: '@mantle/diagram-templates',
    useFor: 'flow and P&ID diagrams drawn from data',
    aliases: ['diagram', 'diagrams', 'templates', 'flow', 'pid'],
  },
];

export const APP_LIBRARY_DIR = `${CANVAS_LIBRARY_DIR}/app`;

const APP_LIBRARIES = [...APP_CANVAS_LIBRARIES, ...APP_RUNTIME_LIBRARIES];

/** The specifiers an app imports a library by (its app guide's import). */
export function appSpecifiers(lib: CanvasLibrary): string[] {
  return APP_LIBRARIES.filter((l) => l.guide === lib.name).map((l) => l.specifier);
}

/** Every library a mini app may import, by guide. */
export const APP_GUIDE_LIBRARIES: readonly CanvasLibrary[] = [
  ...CANVAS_LIBRARIES,
  ...APP_ONLY_LIBRARIES,
].filter((l) => appSpecifiers(l).length > 0);

const key = (s: string) => s.toLowerCase().trim().replace(/\s+/g, '');

function find(list: readonly CanvasLibrary[], name: string): CanvasLibrary | null {
  const k = key(name);
  if (!k) return null;
  return list.find((l) => l.name === k || (l.aliases ?? []).includes(k)) ?? null;
}

export function resolveCanvasLibrary(name: string): CanvasLibrary | null {
  return find(CANVAS_LIBRARIES, name);
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

export async function readCanvasLibraryGuide(lib: CanvasLibrary, sub = ''): Promise<string | null> {
  for (const dir of candidateDirs()) {
    try {
      return await readFile(path.join(dir, sub, guideFile(lib)), 'utf8');
    } catch {
      // try the next one
    }
  }
  return null;
}

/** One `## ` section of a guide, heading included, or ''. */
function section(md: string, heading: string): string {
  const start = md.indexOf(`\n## ${heading}`);
  if (start < 0) return '';
  const next = md.indexOf('\n## ', start + 4);
  return md.slice(start + 1, next < 0 ? undefined : next + 1);
}

/** The app reply: the app guide, with the library's own API sections from
 *  its canvas guide set in before the React pattern. */
export function appGuide(appMd: string, canvasMd: string | null): string {
  if (!canvasMd) return appMd;
  const shared = section(canvasMd, 'Core API') + section(canvasMd, 'What changed');
  const at = appMd.indexOf('\n## In a React component');
  if (!shared || at < 0) return appMd;
  return `${appMd.slice(0, at + 1)}${shared}${appMd.slice(at + 1)}`;
}

async function appLibraryHandler(asked: string): Promise<ToolHandlerResult> {
  const lib = find([...CANVAS_LIBRARIES, ...APP_ONLY_LIBRARIES], asked);
  const valid = APP_GUIDE_LIBRARIES.map((l) => l.name).join(', ');
  if (!lib) {
    return {
      ok: false,
      error: `No mini-app library '${asked}'. Valid: ${valid}. Anything else: plain React and SVG, or relative files of the app.`,
    };
  }
  const specifiers = appSpecifiers(lib);
  if (!specifiers.length) {
    const why = APP_LIBRARIES_LEFT_OUT[lib.pkg] ?? 'it is not served to apps';
    return {
      ok: false,
      error: `${lib.name} is not available in a mini app: ${why}. Libraries an app can import: ${valid}.`,
    };
  }
  const md = await readCanvasLibraryGuide(lib, 'app');
  if (md === null) {
    return {
      ok: false,
      error: `The ${lib.name} app guide (${APP_LIBRARY_DIR}/${guideFile(lib)}) is not on this server. Check MANTLE_DOCS_ROOT; meanwhile follow the app_authoring skill alone.`,
    };
  }
  const canvasMd = CANVAS_LIBRARIES.includes(lib) ? await readCanvasLibraryGuide(lib) : null;
  return {
    ok: true,
    output: {
      library: lib.name,
      for: 'app',
      import: specifiers,
      version: guideVersion(md, lib.pkg),
      guide: appGuide(md, canvasMd),
    },
  };
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
  if (str(input.for) === 'app') return appLibraryHandler(asked);
  const lib = resolveCanvasLibrary(asked);
  if (!lib && find(APP_ONLY_LIBRARIES, asked)) {
    return {
      ok: false,
      error: `'${asked}' has no canvas guide: a template canvas is written for you by \`diagram_render\` and \`present_create\` (get the data contract with \`diagram_guide\`). In a mini app, call canvas_library with for: 'app'.`,
    };
  }
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
    "Return the guide to one library a Present canvas can import, for the exact version this brain serves: the import line, the core API, what changed from versions you may know, the canvas rules (no network, theme tokens, reduced motion) and one complete example canvas that renders. Call it before writing a canvas that uses that library; plain SVG and JS need none. For a mini app pass `for: 'app'`: the import as an app writes it, the React pattern (mount in an effect, clean up, resize, theme) and one complete App.tsx; a library apps cannot use says why. Reads only; changes nothing.",
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: `The library: ${CANVAS_LIBRARIES.map((l) => l.name).join(', ')}; for an app also ${APP_ONLY_LIBRARIES.map((l) => l.name).join(', ')}.`,
      },
      for: {
        type: 'string',
        enum: ['canvas', 'app'],
        default: 'canvas',
        description: "Who imports it: a Present canvas, or a mini app's React code.",
      },
    },
    required: ['name'],
  },
  handler: (input) => canvasLibraryHandler(input),
};

export const CANVAS_LIBRARY_TOOLS: BuiltinToolDef[] = [canvas_library];
