/**
 * Streamed multipart upload for POST /api/files/files.
 *
 * `req.formData()` buffers the whole body, which is why a 250 MB upload used to
 * be a memory event before it was a "too large" error. This reads the body as
 * it arrives: fields are collected, the one `file` part is spooled to disk by
 * `spoolUpload` (hashed and counted per chunk, refused at the cap), and the
 * caller adopts the spool by rename. Field order does not matter: the spool
 * has no folder until the caller reads `parentPath` after parsing completes.
 */
import busboy from 'busboy';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import {
  discardSpooled,
  spoolUpload,
  UploadTooLargeError,
  type SpooledUpload,
} from '@mantle/files';

export type ParsedUpload = {
  fields: Record<string, string>;
  file: { filename: string; spooled: SpooledUpload } | null;
};

/** Multipart framing we tolerate above the file cap before refusing on the
 *  declared Content-Length alone (the boundary lines and field parts). */
const FRAMING_SLACK_BYTES = 2 * 1024 * 1024;

/** True when the declared body length already exceeds the cap: refuse before
 *  reading a byte, so the client hears "too large" at once instead of after
 *  streaming the whole file to be told at the end. */
export function declaredTooLarge(headers: Headers, maxBytes: number): boolean {
  const declared = Number(headers.get('content-length') ?? 0);
  return Number.isFinite(declared) && declared > maxBytes + FRAMING_SLACK_BYTES;
}

export async function readMultipartUpload(
  req: Request,
  opts: { maxBytes: number },
): Promise<ParsedUpload> {
  if (declaredTooLarge(req.headers, opts.maxBytes)) throw new UploadTooLargeError(opts.maxBytes);
  if (!req.body) throw new Error('empty body');
  const contentType = req.headers.get('content-type') ?? '';

  return new Promise<ParsedUpload>((resolve, reject) => {
    const fields: Record<string, string> = {};
    let filePromise: Promise<{ filename: string; spooled: SpooledUpload }> | null = null;
    let activeFile: Readable | null = null;
    let settled = false;
    const source = Readable.fromWeb(req.body as NodeReadableStream);
    const bb = busboy({
      headers: { 'content-type': contentType },
      // Browsers send multipart part headers as UTF-8, but RFC 7578 leaves the
      // charset unstated and busboy therefore defaults to latin1 — so an
      // accented or non-Latin filename arrived mojibake'd ("Kruger" as
      // "KrÃ¼ger") and was stored that way. (2026-09-03 audit.)
      defParamCharset: 'utf8',
      limits: { files: 1, fields: 32, fieldSize: 64 * 1024 },
    });

    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      source.destroy();
      // A client that cancelled mid-body leaves busboy's file stream open and
      // the spool pipeline waiting on it forever, .part and all. Destroying
      // the part stream is what makes spoolUpload's own cleanup run.
      activeFile?.destroy(err instanceof Error ? err : new Error(String(err)));
      // Whatever was spooled so far is garbage now.
      const pending = filePromise;
      void (async () => {
        try {
          const f = await pending;
          if (f) await discardSpooled(f.spooled);
        } catch {
          /* the spool already cleaned up after itself */
        }
      })();
      reject(err);
    };

    bb.on('field', (name, value) => {
      fields[name] = value;
    });
    bb.on('file', (name, stream, info) => {
      if (name !== 'file' || filePromise) {
        stream.resume(); // not ours: drain so the parser can move on
        return;
      }
      activeFile = stream;
      filePromise = spoolUpload(stream, { maxBytes: opts.maxBytes })
        .then((spooled) => ({ filename: info.filename, spooled }))
        .catch((err: unknown) => {
          if (err instanceof UploadTooLargeError) err.filename = info.filename;
          throw err;
        });
      filePromise.catch(fail);
    });
    bb.on('error', fail);
    source.on('error', fail);
    bb.on('close', () => {
      void (async () => {
        try {
          const file = filePromise ? await filePromise : null;
          if (settled) {
            if (file) await discardSpooled(file.spooled);
            return;
          }
          settled = true;
          resolve({ fields, file });
        } catch (err) {
          fail(err);
        }
      })();
    });
    source.pipe(bb);
  });
}
