/**
 * Canvas render bridge. `present_render`, `diagram_render` and `diagram_save`
 * need the browser sidecar, which lives in server/web (lib/render-canvas.ts),
 * not in this package. Same shape as agent-bridge.ts: server/web registers the
 * renderer at boot; a process that never registers one (a worker) gets a
 * clear refusal instead of a crash.
 */
import type { PresentMeta } from '@mantle/db';

export type CanvasRenderRequest = {
  ownerId: string;
  /** The canvas as stored (or about to be): the document, its compiled
   *  Tailwind and the head facts the fit needs. */
  canvas: { source: string; css: string; meta: PresentMeta };
  /** The viewport for a `fill` canvas (a fixed one renders at its size). */
  width?: number;
  height?: number;
  /** Seconds after load to take the picture (an animation's moment). */
  atSeconds?: number;
  /** A deck: the slide to show, 1-based (arrow keys from the first). */
  slide?: number;
  theme?: 'light' | 'dark';
  /** Device pixels per CSS pixel (1 for a look, 2 for an export). */
  scale?: 1 | 2;
  /** A diagram template canvas: also ask it for its static SVG. */
  exportSvg?: boolean;
};

/** What a diagram template canvas said about itself (`window.diagram`). */
export type CanvasDiagramReport = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  stats: Record<string, number>;
  /** The static export, checked (`svgProblems` empty when it is static). */
  svg?: string;
  svgProblems?: string[];
};

export type CanvasRenderResult =
  | {
      ok: true;
      /** The picture: a PNG, or a JPEG when the PNG was over the byte cap
       *  (a canvas full of noise). */
      png: Buffer;
      mime: 'image/png' | 'image/jpeg';
      width: number;
      height: number;
      /** Uncaught errors and console errors the canvas raised. */
      consoleErrors: string[];
      /** Requests the render refused (a canvas has no network). */
      blocked: string[];
      diagram?: CanvasDiagramReport;
    }
  | { ok: false; error: string };

export type CanvasRenderer = (req: CanvasRenderRequest) => Promise<CanvasRenderResult>;

let renderer: CanvasRenderer | null = null;

export function registerCanvasRenderer(fn: CanvasRenderer | null): void {
  renderer = fn;
}

export function getCanvasRenderer(): CanvasRenderer | null {
  return renderer;
}

/** The refusal a process without the sidecar gives. */
export const CANVAS_RENDER_UNAVAILABLE =
  'The canvas renderer is not available in this process (it runs in the web server with the browser sidecar). Save the canvas and ask the owner to look at it in Present.';
