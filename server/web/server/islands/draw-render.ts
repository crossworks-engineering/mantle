/**
 * Draw render island — turns a committed scene into an SVG snapshot inside the
 * browser sidecar's Chromium.
 *
 * Excalidraw cannot run outside a browser: text layout depends on real font
 * metrics (measureText / document.fonts), so there is no Node path that
 * produces a correct drawing. The same trick the mermaid bundle already uses
 * for /print applies here — self-host the browser-only renderer and let the
 * sidecar's real Chromium execute it.
 *
 * Deliberately does NOT mount <Excalidraw />. `restore` and `exportToSvg` are
 * standalone functions, so this bundle carries the renderer and roughjs but
 * none of the editor UI, and needs no React at all.
 *
 * Contract with /render/draws/:id — the page sets window.__mantleDrawScene and
 * window.__mantleDrawFileRefs, this sets exactly one of:
 *   window.__mantleDrawSvg + window.__mantleDrawDone = true
 *   window.__mantleDrawError (a string)
 * plus window.__mantleDrawPartial when some scene images could not be loaded,
 * and render-draw-svg.ts waits on those.
 */

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
    __mantleDrawScene?: { elements?: unknown[]; appState?: Record<string, unknown> } | null;
    /** BinaryFile id → file node id, so scene images can be rehydrated. */
    __mantleDrawFileRefs?: Record<string, string>;
    __mantleDrawSvg?: string;
    __mantleDrawDone?: boolean;
    __mantleDrawError?: string;
    /** True when the render is missing at least one scene image. The caller
     *  decides whether that beats what it already has (see draw-snapshot.ts:
     *  a partial render never overwrites a good snapshot). */
    __mantleDrawPartial?: boolean;
  }
}

/** Per-image fetch timeout: one hung request must not burn the whole render
 *  budget. Images are same-origin and small; 5s is generous. */
const FILE_FETCH_TIMEOUT_MS = 5_000;
/** Parallel image fetches. Bounded so a scene with dozens of screenshots can
 *  finish where the old one-at-a-time loop could not, without stampeding the
 *  file route. */
const FILE_FETCH_CONCURRENCY = 4;
/** Overall image-loading deadline, comfortably inside the driver's 20s render
 *  budget so exportToSvg still gets its share. Anything not loaded by then
 *  counts as missing (→ a partial render) instead of hanging the island. */
const FILE_LOAD_DEADLINE_MS = 12_000;

/**
 * Rehydrate scene images from the files pipeline, mirroring what the editor
 * does on load. Scene images are stored as real `file` nodes (`file_refs`
 * maps BinaryFile id → node id), never inside the scene blob, so a render
 * that skipped this would draw empty frames where the screenshots are.
 *
 * Failures don't abort: each unloadable image is reported in `missing` and the
 * render proceeds without it (Excalidraw draws its broken-image frame there).
 * Whether a partial render is worth KEEPING is the caller's call, not ours —
 * draw-snapshot.ts stores one only when nothing is cached at all, so a
 * degraded render never replaces a good committed snapshot.
 */
async function loadSceneFiles(
  refs: Record<string, string>,
): Promise<{ files: Record<string, unknown>; missing: string[] }> {
  const entries = Object.entries(refs);
  const files: Record<string, unknown> = {};
  const missing: string[] = [];
  const deadline = Date.now() + FILE_LOAD_DEADLINE_MS;
  let cursor = 0;

  const worker = async () => {
    while (cursor < entries.length) {
      const [fileId, nodeId] = entries[cursor++]!;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        missing.push(nodeId);
        continue;
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), Math.min(FILE_FETCH_TIMEOUT_MS, remaining));
      try {
        const res = await fetch(`/api/files/files/${encodeURIComponent(nodeId)}?raw=1`, {
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`scene image ${nodeId} failed to load (${res.status})`);
        const blob = await res.blob();
        const dataURL = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result));
          r.onerror = () => reject(new Error(`scene image ${nodeId} could not be decoded`));
          r.readAsDataURL(blob);
        });
        files[fileId] = {
          id: fileId,
          dataURL,
          mimeType: blob.type || 'image/png',
          created: Date.now(),
        };
      } catch {
        missing.push(nodeId);
      } finally {
        clearTimeout(timer);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(FILE_FETCH_CONCURRENCY, entries.length) }, worker),
  );
  return { files, missing };
}

async function render(): Promise<void> {
  const scene = window.__mantleDrawScene;
  if (!scene || !Array.isArray(scene.elements) || scene.elements.length === 0) {
    // An empty scene has no snapshot, and that is a legitimate answer rather
    // than a failure — the caller stores nothing and shows its placeholder.
    window.__mantleDrawError = 'empty scene';
    return;
  }

  // Imported here, not at module scope: EXCALIDRAW_ASSET_PATH must already be
  // set on window when the package initialises, or it reaches for the CDN.
  const { restore, exportToSvg } = await import('@excalidraw/excalidraw');

  // Before restore(): an image element whose file is missing renders empty.
  const { files, missing } = await loadSceneFiles(window.__mantleDrawFileRefs ?? {});
  if (missing.length > 0) window.__mantleDrawPartial = true;

  // restore() is upstream's scene-format migration — the same call the editor
  // makes on load, so an old stored scene renders as the current version
  // understands it rather than being silently misdrawn.
  const restored = restore(
    {
      elements: scene.elements as never,
      appState: (scene.appState ?? {}) as never,
      files: files as never,
    },
    null,
    null,
  );

  const svg = await exportToSvg({
    elements: restored.elements,
    appState: {
      exportBackground: true,
      exportWithDarkMode: false,
      exportEmbedScene: false,
      ...(scene.appState?.viewBackgroundColor
        ? { viewBackgroundColor: scene.appState.viewBackgroundColor as string }
        : {}),
    },
    files: files as never,
    // Same reason as the editor's commit path: without this an embeddable
    // renders as <foreignObject>, which acceptSceneSvg rejects wholesale, so
    // one embed would make the snapshot unstorable.
    renderEmbeddables: false,
  });

  window.__mantleDrawSvg = svg.outerHTML;
}

void (async () => {
  try {
    await render();
  } catch (err) {
    window.__mantleDrawError = err instanceof Error ? err.message : String(err);
  } finally {
    // Set last and unconditionally: the driver waits on done-or-error, so
    // failing to set this would hang the render until its timeout.
    window.__mantleDrawDone = true;
  }
})();

export {};
