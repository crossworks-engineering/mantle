/**
 * The shared runtime's export map as a TEST fixture. Production never uses
 * this — `loadRuntimeExports()` reads the generated manifest, so the real
 * check always describes the runtime that is actually deployed. This exists so
 * tests can call `buildApp` without building the whole runtime first.
 *
 * `runtime-exports.drift.test.ts` builds the real runtime and asserts this
 * matches, so a fixture that falls behind fails loudly instead of quietly
 * letting tests pass against a runtime shape that no longer exists.
 */
export const RUNTIME_EXPORTS_FIXTURE: Record<string, string[]> = {
  react: ['default', 'useState', 'useEffect', 'useRef', 'useCallback', 'useMemo'],
  'react-dom': ['default'],
  'react-dom/client': ['createRoot', 'hydrateRoot', 'version'],
  'react/jsx-runtime': ['Fragment', 'jsx', 'jsxs'],
  '@/lib/utils': ['cn'],
  '@/components/ui/button': ['Button'],
  '@/components/ui/card': [
    'Card',
    'CardContent',
    'CardDescription',
    'CardFooter',
    'CardHeader',
    'CardTitle',
  ],
  '@/components/ui/input': ['Input'],
  '@/components/ui/label': ['Label'],
  '@/components/ui/badge': ['Badge'],
  '@/components/ui/separator': ['Separator'],
  '@host': ['__mount', 'host'],
  'motion/react': ['motion', 'AnimatePresence', 'animate', 'useAnimate', 'useReducedMotion'],
  '@tanstack/react-table': [
    'useTable',
    'tableFeatures',
    'createColumnHelper',
    'createSortedRowModel',
    'rowSortingFeature',
    'sortFn_alphanumeric',
    'columnFilteringFeature',
    'globalFilteringFeature',
    'createFilteredRowModel',
    'filterFn_includesString',
    'FlexRender',
  ],
  '@tanstack/react-virtual': ['useVirtualizer', 'useWindowVirtualizer'],
  '@dnd-kit/core': [
    'DndContext',
    'closestCenter',
    'KeyboardSensor',
    'PointerSensor',
    'useSensor',
    'useSensors',
    'useDraggable',
    'useDroppable',
    'DragOverlay',
  ],
  '@dnd-kit/sortable': [
    'SortableContext',
    'useSortable',
    'arrayMove',
    'sortableKeyboardCoordinates',
    'verticalListSortingStrategy',
  ],
};

/**
 * The canvas-runtime libraries an app reads (app-libraries.ts
 * APP_CANVAS_LIBRARIES), as subsets of what the canvas runtime's manifest
 * records. `app-libraries.build.test.ts` builds the real canvas runtime and
 * asserts every name here is real and every library is here.
 */
export const LIBRARY_EXPORTS_FIXTURE: Record<string, string[]> = {
  echarts: ['init', 'graphic', 'use'],
  d3: ['select', 'scaleLinear', 'axisBottom'],
  three: ['Scene', 'WebGLRenderer', 'PerspectiveCamera', 'Mesh'],
  'three/addons/controls/OrbitControls.js': ['OrbitControls'],
  konva: ['default'],
  katex: ['default'],
  '@mantle/diagram-templates/browser': ['domMeasurer', 'mount', 'render'],
  mathjs: ['evaluate', 'unit', 'create', 'all', 'format', 'round'],
  'date-fns': ['format', 'addDays', 'differenceInCalendarDays', 'parseISO', 'isWeekend'],
  zod: ['z', 'object', 'string', 'number', 'ZodError', 'prettifyError'],
  'fuse.js': ['default'],
  papaparse: ['default'],
  'pdf-lib': ['PDFDocument', 'StandardFonts', 'rgb'],
  qrcode: ['default'],
  'markdown-it': ['default'],
  dompurify: ['default'],
};
