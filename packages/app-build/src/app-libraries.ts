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
 * The one exception is `motion/react`: Motion's React API imports React, so
 * it is built into the APP runtime against the one shared React
 * (build-runtime.ts), not taken from the canvas set, which has no React.
 *
 * Every entry is an exact specifier. A subpath (`echarts/core`,
 * `three/examples/jsm/...`) is refused like any other unlisted import.
 */

/** A canvas-runtime module an app may import: the specifier as written in
 *  app source, and the canvas_library guide that covers it. */
export type AppLibrary = Readonly<{ specifier: string; guide: string }>;

/** Taken from the canvas runtime's manifest (must be in CANVAS_MODULES). */
export const APP_CANVAS_LIBRARIES: readonly AppLibrary[] = [
  { specifier: 'echarts', guide: 'echarts' },
  { specifier: 'd3', guide: 'd3' },
  { specifier: 'three', guide: 'three' },
  // The addon imports `three` through the import map, so a scene and its
  // controls share one Three.
  { specifier: 'three/addons/controls/OrbitControls.js', guide: 'three' },
  { specifier: 'konva', guide: 'konva' },
  { specifier: 'katex', guide: 'katex' },
  // The diagram templates (flow, pid): `render` + `domMeasurer` draw a
  // template's data to an SVG string in the app's own document.
  { specifier: '@mantle/diagram-templates/browser', guide: 'diagram-templates' },
];

/** Built into the app runtime itself (build-runtime.ts ENTRY_SRC). */
export const APP_RUNTIME_LIBRARIES: readonly AppLibrary[] = [
  { specifier: 'motion/react', guide: 'motion' },
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
