/**
 * App render bridge: `app_render` draws a mini app in the browser sidecar
 * (app-render/sidecar.ts). The same shape as canvas-render-bridge.ts: the
 * processes that run tools (server/web, server/api, server/mcp) register the
 * renderer at boot; a process that never registers one (a worker) gets a
 * clear refusal instead of a crash.
 */
import type { AppViewer } from '@mantle/client-types/app-viewer';

/** What the render answers one bridge request from the app with: the
 *  `@host` kit's own reply shape (`ok`, `output` or `error`, `reason`).
 *  `refused` names a call the picture would not run (`tool.call file_sql`),
 *  for the report. */
export type AppRenderHostAnswer =
  { ok: true; output: unknown } | { ok: false; error: string; reason?: string; refused?: string };

export type AppRenderRequest = {
  ownerId: string;
  /** The build to draw (green): its bundle and its CSS, by storage key. */
  build: { storageKey: string; css?: { storageKey: string } | null };
  /** What `host.me()` answers in the frame (null: it rejects). */
  viewer: AppViewer | null;
  width: number;
  height: number;
  theme: 'light' | 'dark';
  /** Seconds to wait after the app is ready, before the picture. */
  atSeconds: number;
  /** Answers one bridge request (app-render/host-calls.ts
   *  answerRenderHostCall), bound to the caller's scope. Never throws. */
  hostCall: (message: Record<string, unknown>) => Promise<AppRenderHostAnswer>;
};

export type AppRenderResult =
  | {
      ok: true;
      /** A PNG, or a JPEG when the PNG was over the byte cap. */
      png: Buffer;
      mime: 'image/png' | 'image/jpeg';
      width: number;
      height: number;
      /** The app said it was ready (its first paint) before the picture. */
      ready: boolean;
      /** Uncaught errors, console errors and the app's own error reports. */
      consoleErrors: string[];
      /** Requests the render refused (an app has no network). */
      blocked: string[];
      /** Bridge calls a picture does not run, once each. */
      refused: string[];
      /** Bridge calls the app made. */
      hostCalls: number;
    }
  | { ok: false; error: string };

export type AppRenderer = (req: AppRenderRequest) => Promise<AppRenderResult>;

let renderer: AppRenderer | null = null;

export function registerAppRenderer(fn: AppRenderer | null): void {
  renderer = fn;
}

export function getAppRenderer(): AppRenderer | null {
  return renderer;
}

/** The refusal a process without the sidecar gives. */
export const APP_RENDER_UNAVAILABLE =
  'No picture: apps are not drawn in this process (a background worker). The app itself is saved; open it to see it.';
