import type { Editor } from '@tiptap/core';

/**
 * Upload a file through the existing files pipeline and turn it into an
 * embeddable node. Reuses POST /api/files/files (MinIO + a `file` node) and the
 * raw-serve route (`?raw=1`) as the `<img src>` / download href — pages
 * reference the file node by id, they don't inline bytes.
 */
export type UploadedFile = {
  id: string;
  src: string;
  filename: string;
  mime: string;
  size: number;
  isImage: boolean;
};

export async function uploadToFiles(file: File): Promise<UploadedFile> {
  const fd = new FormData();
  // Page embeds land in the files root; the user can reorganise in /files.
  fd.set('parentPath', 'files');
  fd.set('file', file);
  const res = await fetch('/api/files/files', { method: 'POST', body: fd });
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(b.error ?? `upload failed (${res.status})`);
  }
  const { file: row } = (await res.json()) as {
    file: { id: string; filename: string; mimeType: string; sizeBytes: number };
  };
  const mime = row.mimeType ?? file.type ?? '';
  return {
    id: row.id,
    src: `/api/files/files/${row.id}?raw=1`,
    filename: row.filename ?? file.name,
    mime,
    size: row.sizeBytes ?? file.size,
    isImage: mime.startsWith('image/'),
  };
}

export function imageAttrs(up: UploadedFile) {
  return { src: up.src, alt: up.filename, nodeId: up.id };
}

export function fileEmbedAttrs(up: UploadedFile) {
  return { nodeId: up.id, href: up.src, filename: up.filename, mime: up.mime, size: up.size };
}

/** Upload then insert the right node (image vs file chip) — at `pos` if given
 *  (drag-drop drop point), else at the current selection (slash / paste). */
export async function uploadAndInsert(editor: Editor, file: File, pos?: number): Promise<void> {
  const up = await uploadToFiles(file);
  const node = up.isImage
    ? { type: 'image', attrs: imageAttrs(up) }
    : { type: 'fileEmbed', attrs: fileEmbedAttrs(up) };
  if (typeof pos === 'number') editor.chain().focus().insertContentAt(pos, node).run();
  else editor.chain().focus().insertContent(node).run();
}

/** Handle a batch of dropped/pasted files. Returns true if any were files we
 *  took over (so the caller can preventDefault). Uploads run async. */
export function handleDroppedFiles(editor: Editor, files: File[], pos?: number): boolean {
  const usable = files.filter((f) => f.size > 0);
  if (usable.length === 0) return false;
  for (const f of usable) void uploadAndInsert(editor, f, pos);
  return true;
}
