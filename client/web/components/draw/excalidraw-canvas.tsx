'use client';

/**
 * The Excalidraw canvas, wrapped once for the whole app.
 *
 * - Client-only: the package touches window/document at module scope, so it
 *   loads via next/dynamic with ssr:false. Everything else in the app imports
 *   THIS component, never @excalidraw/excalidraw directly — the wrapper is
 *   where the asset path, theme wiring and dynamic import live, and it keeps
 *   the ~1.8 MB editor chunk referenced only by routes that render a canvas.
 * - Self-hosted assets: EXCALIDRAW_ASSET_PATH is set at module scope (before
 *   the dynamic import resolves) so fonts load from /excalidraw-assets/,
 *   synced into public/ by scripts/copy-excalidraw-assets.mjs. A self-hosted
 *   instance must never reach for the package CDN.
 * - Theme follows the app (next-themes resolvedTheme), so the canvas flips
 *   with the rest of the UI; Excalidraw's own theme toggle stays hidden.
 */

import '@excalidraw/excalidraw/index.css';

import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from '@excalidraw/excalidraw/types';
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import dynamic from 'next/dynamic';
import { useTheme } from 'next-themes';

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

if (typeof window !== 'undefined') {
  window.EXCALIDRAW_ASSET_PATH = '/excalidraw-assets/';
}

const Excalidraw = dynamic(async () => (await import('@excalidraw/excalidraw')).Excalidraw, {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
      Loading canvas…
    </div>
  ),
});

export type SceneChange = {
  elements: readonly OrderedExcalidrawElement[];
  appState: AppState;
  files: BinaryFiles;
};

type ExcalidrawCanvasProps = {
  /** Committed-or-draft scene to mount with. Run through restore() upstream
   *  of this component (the loader does it) — the canvas just renders. */
  initialData?: ExcalidrawInitialDataState | null;
  /** Fires on every editor change (selection and viewport included — callers
   *  dedupe real content changes via hashElementsVersion). */
  onChange?: (change: SceneChange) => void;
  /** Read-only rendering (list preview, share view). */
  viewMode?: boolean;
  /** Receives the imperative API once the canvas mounts (exports, updateScene). */
  onApiReady?: (api: ExcalidrawImperativeAPI) => void;
};

export function ExcalidrawCanvas({
  initialData,
  onChange,
  viewMode = false,
  onApiReady,
}: ExcalidrawCanvasProps) {
  const { resolvedTheme } = useTheme();

  return (
    <div className="h-full w-full" data-testid="excalidraw-canvas">
      <Excalidraw
        theme={resolvedTheme === 'dark' ? 'dark' : 'light'}
        viewModeEnabled={viewMode}
        initialData={initialData ?? null}
        excalidrawAPI={onApiReady}
        onChange={
          onChange
            ? (elements, appState, files) => onChange({ elements, appState, files })
            : undefined
        }
        UIOptions={{
          canvasActions: {
            // The app's theme is the theme; no per-canvas toggle.
            toggleTheme: false,
            // Scene load/save-to-disk stay available — they're user data
            // portability, same spirit as the pages Download button.
          },
        }}
      />
    </div>
  );
}
