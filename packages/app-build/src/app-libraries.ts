/**
 * The canvas libraries a MINI APP may import, and the ones it may not.
 *
 * One vendored copy: an app imports the same content-hashed files a Present
 * canvas does (`/canvas-runtime/`, canvas-runtime.ts), never a copy bundled
 * into the app. The app runtime build (build-runtime.ts) copies each
 * specifier's URL into the app import map and its export names into the app
 * import check, so the bundler leaves the import bare (index.ts) and the
 * frame resolves it, as it resolves React.
 *
 * The exceptions are the libraries that import React (`motion/react`, the
 * TanStack table and virtualizer, dnd-kit): they are built into the APP
 * runtime against the one shared React (build-runtime.ts), not taken from
 * the canvas set, which has no React.
 *
 * Each library is its own content-hashed file, fetched only when an app
 * imports it: the import map is an address book, so a large library (pdf-lib,
 * mathjs) costs an app that does not import it nothing.
 *
 * Every entry is an exact specifier. A subpath (`echarts/core`,
 * `three/examples/jsm/...`) is refused like any other unlisted import.
 */

/** A library an app may import: the specifier as written in app source,
 *  the canvas_library guide that covers it, and a one-line hint of what to
 *  use it for, written for agents to read as is. */
export type AppLibrary = Readonly<{ specifier: string; guide: string; hint: string }>;

/** An app-runtime library: also the entry it is built as (build-runtime.ts). */
export type AppRuntimeLibrary = AppLibrary & Readonly<{ entry: string }>;

/** Taken from the canvas runtime's manifest (must be in CANVAS_MODULES). */
export const APP_CANVAS_LIBRARIES: readonly AppLibrary[] = [
  { specifier: 'echarts', guide: 'echarts', hint: 'business charts and dashboards' },
  { specifier: 'd3', guide: 'd3', hint: 'custom charts, scales, shapes, force graphs' },
  { specifier: 'three', guide: 'three', hint: '3D scenes' },
  // The addon imports `three` through the import map, so a scene and its
  // controls share one Three.
  {
    specifier: 'three/addons/controls/OrbitControls.js',
    guide: 'three',
    hint: 'orbit, zoom and pan for a 3D scene',
  },
  { specifier: 'konva', guide: 'konva', hint: '2D shapes people drag and click' },
  { specifier: 'katex', guide: 'katex', hint: 'typeset formulas' },
  // The diagram templates (flow, pid): `render` + `domMeasurer` draw a
  // template's data to an SVG string in the app's own document.
  {
    specifier: '@mantle/diagram-templates/browser',
    guide: 'diagram-templates',
    hint: 'flow and P&ID diagrams drawn from data',
  },
  {
    specifier: 'mathjs',
    guide: 'mathjs',
    hint: 'units and engineering maths, formulas a person types',
  },
  { specifier: 'date-fns', guide: 'date-fns', hint: 'dates: format, add business days, ranges' },
  { specifier: 'zod', guide: 'zod', hint: 'form checks and the shape of rows' },
  { specifier: 'fuse.js', guide: 'fuse', hint: 'fuzzy search (typos, partial words)' },
  { specifier: 'papaparse', guide: 'papaparse', hint: 'CSV in and out' },
  { specifier: 'pdf-lib', guide: 'pdf-lib', hint: 'make or fill a PDF' },
  { specifier: 'qrcode', guide: 'qrcode', hint: 'QR codes for labels and tags' },
  // One guide: markdown-it's HTML reaches the DOM only through DOMPurify.
  {
    specifier: 'markdown-it',
    guide: 'markdown',
    hint: 'markdown to HTML; always pass the HTML through dompurify',
  },
  { specifier: 'dompurify', guide: 'markdown', hint: 'sanitize HTML before it reaches the DOM' },
];

/** Built into the app runtime itself (build-runtime.ts ENTRY_SRC). */
export const APP_RUNTIME_LIBRARIES: readonly AppRuntimeLibrary[] = [
  { specifier: 'motion/react', guide: 'motion', entry: 'motion-react', hint: 'animation' },
  {
    specifier: '@tanstack/react-table',
    guide: 'tanstack-table',
    entry: 'tanstack-table',
    hint: 'big grids: sort, filter (v9 API: useTable)',
  },
  {
    specifier: '@tanstack/react-virtual',
    guide: 'tanstack-virtual',
    entry: 'tanstack-virtual',
    hint: 'long lists that render only the rows on screen',
  },
  // Sortable imports core: splitting gives both one copy, so one drag context.
  {
    specifier: '@dnd-kit/core',
    guide: 'dnd-kit',
    entry: 'dnd-kit-core',
    hint: 'drag and drop',
  },
  {
    specifier: '@dnd-kit/sortable',
    guide: 'dnd-kit',
    entry: 'dnd-kit-sortable',
    hint: 'reorder a list or a board by dragging (with @dnd-kit/core)',
  },
];

/** Canvas libraries an app may NOT import, and why. The error text names
 *  them so the builder does not keep trying. */
export const APP_LIBRARIES_LEFT_OUT: Readonly<Record<string, string>> = {
  'reveal.js':
    'a slide-deck framework that owns the whole page (its own layout, scaling and keys); a deck is a Present canvas',
  alpinejs:
    'a second reactive DOM framework that fights React for the same nodes, and it needs unsafe-eval, which the app frame does not allow',
  motion: "use 'motion/react' in an app (the vanilla build is for canvases)",
};

/** Every library specifier an app may import. */
export const APP_LIBRARY_SPECIFIERS: readonly string[] = [
  ...APP_CANVAS_LIBRARIES,
  ...APP_RUNTIME_LIBRARIES,
].map((l) => l.specifier);

/** The canvas-runtime subset an app reads, from that runtime's manifest:
 *  its URLs (for the app import map) and export names (for the import
 *  check). Throws when the canvas runtime lacks one: an app import map that
 *  silently missed a library would ship apps that fail to link. */
export function appCanvasLibraries(canvas: {
  imports: Record<string, string>;
  exports?: Record<string, string[]>;
}): { imports: Record<string, string>; exports: Record<string, string[]> } {
  const imports: Record<string, string> = {};
  const exports: Record<string, string[]> = {};
  for (const { specifier } of APP_CANVAS_LIBRARIES) {
    const url = canvas.imports[specifier];
    const names = canvas.exports?.[specifier];
    if (!url || !names) {
      throw new Error(
        `canvas runtime manifest has no '${specifier}' (url or exports); rebuild the canvas runtime before the app runtime`,
      );
    }
    imports[specifier] = url;
    exports[specifier] = names;
  }
  return { imports, exports };
}
