/**
 * Extractor: Reading file bytes (disk or object storage) with a small LRU, head reads, and PDF password unlock.
 *
 * Split out of extractor.ts on 2026-09-02 (audit, bloat B1) with behaviour
 * unchanged; the sequencer in ../extractor.ts calls into here.
 */

import { nodes } from '@mantle/db';
import { diskPathForFile, extOf, mimeForExt, extractPdfTextWithPassword } from '@mantle/files';
import { contentKey, getContent } from '@mantle/storage';
import { step } from '@mantle/tracing';
import { getPdfPasswordCandidates, markPdfPasswordUsed } from '@mantle/content';
import { cleanText } from './text';

/**
 * Read a file node's bytes, wherever they live. Uploads (web / MCP / disk-sync)
 * write to the local disk keyed by `data.filename`; EMAIL ATTACHMENTS write to
 * object storage, content-addressed by `data.sha256`, and carry no
 * `data.filename`. The extractor used to know only the disk path, so every
 * email attachment fell back to its title — indexed as a hollow filename-only
 * summary (the accountant-invoice bug). This tries disk first, then object
 * storage, so a PDF/image arriving by email extracts (and OCRs) exactly like an
 * uploaded one. Ext/mime derive from `data.filename` when present, else the
 * title (which IS the filename for attachment nodes) / `data.mimeType`.
 */
/** One ingest of a file runs three passes (auto-table, images, body text)
 *  and each used to re-read the bytes from disk/storage independently — for
 *  a 64 MB DWF that is three full reads and three live Buffers for the GC.
 *  A tiny FIFO memo keyed by node id + content sha collapses them to one
 *  read AND hands every pass the SAME Buffer, which is what lets dwf.ts's
 *  per-Buffer parse memo fire across passes. Four entries bounds it to the
 *  extract concurrency with headroom; a re-upload changes the sha and
 *  naturally misses. */
const fileBytesCache = new Map<
  string,
  Promise<{ bytes: Buffer; filename: string; ext: string; mime: string } | null>
>();

const FILE_BYTES_CACHE_MAX = 4;

export function loadFileBytes(
  node: typeof nodes.$inferSelect,
): Promise<{ bytes: Buffer; filename: string; ext: string; mime: string } | null> {
  const sha = ((node.data ?? {}) as Record<string, unknown>).sha256;
  const key = `${node.id}:${typeof sha === 'string' ? sha : ''}`;
  const hit = fileBytesCache.get(key);
  if (hit) return hit;
  const load = loadFileBytesUncached(node);
  fileBytesCache.set(key, load);
  // Never memoize a failed read — the bytes may land moments later.
  load
    .then((r) => {
      if (r === null) fileBytesCache.delete(key);
    })
    .catch(() => fileBytesCache.delete(key));
  if (fileBytesCache.size > FILE_BYTES_CACHE_MAX) {
    const oldest = fileBytesCache.keys().next().value;
    if (oldest !== undefined) fileBytesCache.delete(oldest);
  }
  return load;
}

async function loadFileBytesUncached(
  node: typeof nodes.$inferSelect,
): Promise<{ bytes: Buffer; filename: string; ext: string; mime: string } | null> {
  const data = (node.data ?? {}) as Record<string, unknown>;
  const nameForExt = typeof data.filename === 'string' ? data.filename : node.title;
  const ext = extOf(nameForExt);
  const mime = typeof data.mimeType === 'string' ? data.mimeType : mimeForExt(ext);
  // 1) Local disk — uploads, the disk-sync watcher, MCP file_upload.
  if (typeof data.filename === 'string') {
    const diskPath = diskPathForFile(node.path, data.filename);
    if (diskPath) {
      try {
        const { promises: fs } = await import('node:fs');
        return { bytes: await fs.readFile(diskPath), filename: data.filename, ext, mime };
      } catch {
        // fall through to object storage
      }
    }
  }
  // 2) Object storage — email attachments live here, content-addressed.
  if (typeof data.sha256 === 'string') {
    try {
      const { body } = await getContent(contentKey(data.sha256));
      const chunks: Buffer[] = [];
      for await (const chunk of body as AsyncIterable<Buffer | string>) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return { bytes: Buffer.concat(chunks), filename: nameForExt, ext, mime };
    } catch {
      // unreachable storage / missing object — caller falls back to the title
    }
  }
  return null;
}

/**
 * Read only the first `n` bytes of a file node — enough to identify a format
 * without paying for its content.
 *
 * `.xml` is why this exists. It is a container, so the auto-table pass can't
 * tell a Project plan from any other document by extension, and it used to
 * settle that by loading the whole file and then discarding it for the ~99% of
 * XML that isn't a plan. Under the 64 MB cap that is a 64 MB read to answer a
 * question the first 2 KB already answers.
 *
 * Mirrors {@link loadFileBytes}' resolution order — local disk first, then
 * content-addressed object storage — and returns null on the same conditions,
 * so a caller that falls back to the full read behaves identically.
 */
export async function loadFileHead(
  node: typeof nodes.$inferSelect,
  n = 8192,
): Promise<Buffer | null> {
  const data = (node.data ?? {}) as Record<string, unknown>;
  if (typeof data.filename === 'string') {
    const diskPath = diskPathForFile(node.path, data.filename);
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

/**
 * Last resort for a password-protected PDF: try each vaulted password
 * (most-recently-useful first) to open and read its text layer. Returns the
 * text on the first that works (marking that password used), else null. Covers
 * digital statements whose only barrier is the password; a scanned-AND-encrypted
 * PDF still falls through (render+OCR-with-password is a later enhancement).
 * Runs as an `unlock_pdf` step under the active extractor_run trace.
 */
export async function tryUnlockPdf(
  node: typeof nodes.$inferSelect,
  ownerId: string,
): Promise<string | null> {
  const loaded = await loadFileBytes(node);
  if (!loaded) return null;
  const candidates = await getPdfPasswordCandidates(ownerId);
  if (candidates.length === 0) return null;
  return step(
    { name: 'unlock_pdf', kind: 'compute', input: { candidates: candidates.length } },
    async (h) => {
      for (const c of candidates) {
        const r = await extractPdfTextWithPassword(loaded.bytes, c.password);
        if (r.ok && r.text.trim().length >= 20) {
          await markPdfPasswordUsed(c.id);
          h.setMeta({ unlocked: true, chars: r.text.length, password_id: c.id });
          return cleanText(r.text);
        }
      }
      h.setMeta({ unlocked: false, tried: candidates.length });
      return null;
    },
  );
}
