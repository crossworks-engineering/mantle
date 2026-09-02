import { envInt } from '@mantle/config';

/**
 * Upload size caps. There are two, because there are two transports.
 *
 * `MAX_UPLOAD_BYTES` is the BUFFERED cap: every path that holds a whole file in
 * memory before writing it (MCP `file_upload` base64, chat attachments, forum
 * uploads, Drive sync). Fixed at 64 MB. It is a memory number: the web
 * container has a 1.5 GB limit, base64 inflates 4/3 on the wire, and Office
 * formats unzip many times over inside Tika (`-Xmx1g`, docker-compose.yml, was
 * sized for 25 MB; on an 8 GB+ box use -Xmx2g). A 64 MB .pptx can still OOM the
 * parse (the signal is `chars_out: 0` with a short `parse_document` step).
 *
 * `maxStreamedUploadBytes()` is the STREAMED cap: the web /files uploader
 * (POST /api/files/files multipart). That route spools the body to disk as it
 * arrives and hashes on the way (`spoolUpload` in disk.ts), so memory stays
 * flat whatever the size and the cap is a disk/patience number. Default
 * 512 MB, `MANTLE_MAX_UPLOAD_MB` overrides. It must stay under the reverse
 * proxy's body ceiling (`MANTLE_MAX_BODY_SIZE`, default 1GB, Caddyfile).
 *
 * This is the STORAGE/transfer cap. It is distinct from the per-provider
 * VISION limit (`maxImageBytesFor` in @mantle/tracing), which governs whether
 * an image's raw bytes are sent to a vision model and is handled separately by
 * the transcript-default fallback.
 *
 * Not re-checked by: Telegram (already bounded by the Bot API's ~20 MB getFile
 * limit) or the disk-sync watcher (it ingests local files the operator placed
 * intentionally).
 *
 * History: 25 → 64 MB after a real 1094-task Microsoft Project MSPDI export
 * came in at 25.8 MB (task rows cost ~24 KB each in MSPDI). 64 MB streamed →
 * 512 MB streamed on 2026-09-02, when a 250 MB SQL Server backup spun for half
 * an hour in the uploader with no error and no progress.
 */
export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024; // 64 MB

const DEFAULT_STREAMED_UPLOAD_MB = 512;

/** Cap for the streamed web uploader, read at call time so a box can tune it
 *  in .env without a rebuild. Never below the buffered cap: a client that
 *  learned the limit from /api/shell must not be refused a file the old
 *  buffered route would have taken. */
export function maxStreamedUploadBytes(): number {
  const mb = envInt('MANTLE_MAX_UPLOAD_MB', DEFAULT_STREAMED_UPLOAD_MB, 1);
  return Math.max(MAX_UPLOAD_BYTES, mb * 1024 * 1024);
}
