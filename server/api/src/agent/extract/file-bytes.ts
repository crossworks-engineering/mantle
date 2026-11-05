/**
 * Extractor: A file's bytes with a small LRU for the passes of one extract, and PDF password unlock.
 * The reads themselves are @mantle/files (file-read.ts), shared with the rebuild.
 *
 * Split out of extractor.ts on 2026-09-02 (audit, bloat B1) with behaviour
 * unchanged; the sequencer in ../extractor.ts calls into here.
 */

import { nodes } from '@mantle/db';
import { parserPdfUnlock, readFileNodeBytes, type LoadedFileBytes } from '@mantle/files';
import { step } from '@mantle/tracing';
import { getPdfPasswordCandidates, markPdfPasswordUsed } from '@mantle/content';
import { cleanText } from './text';

/** One ingest of a file runs three passes (auto-table, images, body text)
 *  and each used to re-read the bytes from disk/storage independently — for
 *  a 64 MB DWF that is three full reads and three live Buffers for the GC.
 *  A tiny FIFO memo keyed by node id + content sha collapses them to one
 *  read AND hands every pass the SAME Buffer, which is what lets dwf.ts's
 *  per-Buffer parse memo fire across passes. Four entries bounds it to the
 *  extract concurrency with headroom; a re-upload changes the sha and
 *  naturally misses. */
const fileBytesCache = new Map<string, Promise<LoadedFileBytes | null>>();

const FILE_BYTES_CACHE_MAX = 4;

export function loadFileBytes(node: typeof nodes.$inferSelect): Promise<LoadedFileBytes | null> {
  const sha = ((node.data ?? {}) as Record<string, unknown>).sha256;
  const key = `${node.id}:${typeof sha === 'string' ? sha : ''}`;
  const hit = fileBytesCache.get(key);
  if (hit) return hit;
  const load = readFileNodeBytes(node);
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

/** The head reader, for the passes that take their reads from here. */
export { loadFileHead } from '@mantle/files';

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
        const r = await parserPdfUnlock(loaded.bytes, c.password);
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
