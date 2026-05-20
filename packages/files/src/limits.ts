/**
 * Maximum bytes for a single uploaded file, enforced at every user-facing
 * upload surface (web /files, web /assistant, MCP file_upload). Generous for
 * single-user / family scale.
 *
 * This is the STORAGE/transfer cap. It is distinct from the per-provider
 * VISION limit (`maxImageBytesFor` in @mantle/tracing), which governs whether
 * an image's raw bytes are sent to a vision model and is handled separately by
 * the transcript-default fallback.
 *
 * Not re-checked by: Telegram (already bounded by the Bot API's ~20 MB getFile
 * limit) or the disk-sync watcher (it ingests local files the operator placed
 * intentionally).
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB
