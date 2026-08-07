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
  }
}

/**
 * Rehydrate scene images from the files pipeline, mirroring what the editor
 * does on load. Scene images are stored as real `file` nodes (`file_refs`
 * maps BinaryFile id → node id), never inside the scene blob, so a render
 * that skipped this would draw empty frames where the screenshots are — and
 * then overwrite a perfectly good committed snapshot with the worse one.
 *
 * Throws if any referenced file cannot be loaded. That is deliberate: the
 * caller keeps whatever is already cached, which still shows the images,
 * rather than replacing it with a degraded render.
 */
async function loadSceneFiles(refs: Record<string, string>): Promise<Record<string, unknown>> {
  const files: Record<string, unknown> = {};
  for (const [fileId, nodeId] of Object.entries(refs)) {
    const res = await fetch(`/api/files/files/${encodeURIComponent(nodeId)}?raw=1`);
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
  }
  return files;
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
  const files = await loadSceneFiles(window.__mantleDrawFileRefs ?? {});

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
