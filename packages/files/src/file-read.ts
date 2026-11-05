/**
 * Reading a file row's bytes, wherever they live: the local disk first, then
 * object storage by the row's sha256. Uploads (web, MCP, the disk watcher)
 * write to the disk keyed by `data.filename`; email attachments and drive
 * files live in object storage, content-addressed by `data.sha256`, and may
 * carry no `data.filename`.
 *
 * Read-only and free of caches: the extractor keeps its per-extract memo and
 * its PDF unlock (server/api/src/agent/extract/file-bytes.ts), and a rebuild
 * reads through here directly.
 */
import type { Node } from '@mantle/db';
import { contentKey, getContent } from '@mantle/storage';
import { diskPathForFile } from './paths';
import { extOf, mimeForExt } from './slug';
import { foldedFilePath } from './space-disk';

/** A file row's fields a read needs. */
export type FileReadNode = Pick<Node, 'id' | 'path' | 'title' | 'data'>;

export type LoadedFileBytes = { bytes: Buffer; filename: string; ext: string; mime: string };

/** The disk path of a file row's bytes, or null when it has none. */
function diskPathOf(node: FileReadNode, filename: string): string | null {
  // A member file folded into a workspace keeps its bytes in its old space
  // directory.
  return foldedFilePath(node) ?? diskPathForFile(node.path, filename);
}

/**
 * The whole bytes of a file row, or null when neither place has them. Ext and
 * mime derive from `data.filename` when present, else the title (which IS the
 * filename for an attachment) and `data.mimeType`.
 */
export async function readFileNodeBytes(node: FileReadNode): Promise<LoadedFileBytes | null> {
  const data = (node.data ?? {}) as Record<string, unknown>;
  const nameForExt = typeof data.filename === 'string' ? data.filename : node.title;
  const ext = extOf(nameForExt);
  const mime = typeof data.mimeType === 'string' ? data.mimeType : mimeForExt(ext);
  // 1) Local disk: uploads, the disk-sync watcher, MCP file_upload.
  if (typeof data.filename === 'string') {
    const diskPath = diskPathOf(node, data.filename);
    if (diskPath) {
      try {
        const { promises: fs } = await import('node:fs');
        return { bytes: await fs.readFile(diskPath), filename: data.filename, ext, mime };
      } catch {
        // fall through to object storage
      }
    }
  }
  // 2) Object storage: email attachments live here, content-addressed.
  if (typeof data.sha256 === 'string') {
    try {
      const { body } = await getContent(contentKey(data.sha256));
      const chunks: Buffer[] = [];
      for await (const chunk of body as AsyncIterable<Buffer | string>) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return { bytes: Buffer.concat(chunks), filename: nameForExt, ext, mime };
    } catch {
      // unreachable storage / missing object: the caller decides
    }
  }
  return null;
}

/**
 * Read only the first `n` bytes of a file row: enough to identify a format
 * without paying for its content.
 *
 * `.xml` is why this exists. It is a container, so the extract cannot tell a
 * Project plan from any other document by extension, and it used to settle
 * that by loading the whole file and then discarding it for the ~99% of XML
 * that is not a plan. Under the 64 MB cap that is a 64 MB read to answer a
 * question the first 2 KB already answers.
 *
 * The same order as {@link readFileNodeBytes}, and null on the same
 * conditions, so a caller that falls back to the full read behaves the same.
 */
export async function loadFileHead(node: FileReadNode, n = 8192): Promise<Buffer | null> {
  const data = (node.data ?? {}) as Record<string, unknown>;
  if (typeof data.filename === 'string') {
    const diskPath = diskPathOf(node, data.filename);
    if (diskPath) {
      let handle: import('node:fs/promises').FileHandle | undefined;
      try {
        const { open } = await import('node:fs/promises');
        handle = await open(diskPath, 'r');
        const buf = Buffer.alloc(n);
        const { bytesRead } = await handle.read(buf, 0, n, 0);
        return buf.subarray(0, bytesRead);
      } catch {
        // fall through to object storage
      } finally {
        await handle?.close().catch(() => {});
      }
    }
  }
  if (typeof data.sha256 === 'string') {
    try {
      const { body } = await getContent(contentKey(data.sha256));
      const chunks: Buffer[] = [];
      let got = 0;
      for await (const chunk of body as AsyncIterable<Buffer | string>) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        chunks.push(b);
        got += b.length;
        // Stop pulling as soon as the head is covered; the stream is abandoned
        // rather than drained, which is the entire point of this helper.
        if (got >= n) break;
      }
      return Buffer.concat(chunks).subarray(0, n);
    } catch {
      // unreachable storage / missing object
    }
  }
  return null;
}
