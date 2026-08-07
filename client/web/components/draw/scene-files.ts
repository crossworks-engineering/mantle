import type { BinaryFileData, BinaryFiles } from '@excalidraw/excalidraw/types';
import { assetUrl } from '@mantle/web-ui/asset-url';
import { uploadToFiles } from '@/components/page-editor/upload';

/**
 * Scene images ↔ the files pipeline.
 *
 * Excalidraw keeps pasted/dropped images as in-memory BinaryFiles (dataURLs).
 * Persisting those inside the scene jsonb would balloon the row (and the
 * autosave payload) by megabytes per screenshot — so, exactly like the page
 * editor, the bytes live as real `file` nodes (uploaded once, OCR'd once by
 * the files pipeline) and the draw stores only `file_refs`: BinaryFile id →
 * file node id. On load the map is resolved back into BinaryFiles.
 */

/** Decode a dataURL into a File for the standard upload path. */
function dataUrlToFile(dataURL: string, name: string): File | null {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/.exec(dataURL);
  if (!m) return null;
  const mime = m[1] || 'application/octet-stream';
  try {
    const bytes = m[2]
      ? Uint8Array.from(atob(m[3]!), (c) => c.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(m[3]!));
    return new File([bytes], name, { type: mime });
  } catch {
    return null;
  }
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

/**
 * Upload every scene file that has no mapping yet. Mutates nothing: returns
 * the updated map (input map + new entries) so the caller can persist it with
 * the same draft/commit write. Failures skip the file (it stays unmapped and
 * is retried on the next save) — an upload error must never block autosave.
 */
export async function uploadNewSceneFiles(
  files: BinaryFiles,
  refs: Record<string, string>,
): Promise<Record<string, string>> {
  let next = refs;
  for (const [fileId, data] of Object.entries(files)) {
    if (next[fileId]) continue;
    if (!data?.dataURL) continue;
    const ext = EXT_BY_MIME[data.mimeType] ?? 'bin';
    const file = dataUrlToFile(data.dataURL, `drawing-image-${fileId.slice(0, 8)}.${ext}`);
    if (!file) continue;
    try {
      const up = await uploadToFiles(file);
      next = { ...next, [fileId]: up.id };
    } catch {
      // Retry on the next save; the in-memory canvas still renders it.
    }
  }
  return next;
}

/**
 * Resolve `file_refs` back into BinaryFiles for the canvas: fetch each file
 * node's raw bytes (assetUrl carries the asset token in split deployments)
 * and re-encode as the dataURL Excalidraw wants. Missing/failed files are
 * skipped — the canvas shows its built-in broken-image placeholder rather
 * than failing the load.
 */
export async function loadSceneFiles(refs: Record<string, string>): Promise<BinaryFileData[]> {
  const out: BinaryFileData[] = [];
  await Promise.all(
    Object.entries(refs).map(async ([fileId, nodeId]) => {
      try {
        const res = await fetch(assetUrl(`/api/files/files/${nodeId}?raw=1`));
        if (!res.ok) return;
        const blob = await res.blob();
        const dataURL = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result as string);
          r.onerror = () => reject(r.error ?? new Error('read failed'));
          r.readAsDataURL(blob);
        });
        out.push({
          id: fileId,
          dataURL,
          mimeType: (blob.type || 'application/octet-stream') as BinaryFileData['mimeType'],
          created: Date.now(),
        } as BinaryFileData);
      } catch {
        // Skipped — placeholder renders.
      }
    }),
  );
  return out;
}
