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
 *
 * Raised 25 → 64 MB: a real 1094-task Microsoft Project MSPDI export came in at
 * 25.8 MB — 98.5% of the old cap — and that is not a large plan. Task rows cost
 * roughly 24 KB each in MSPDI (over half of it `TimephasedData` the importer
 * discards), so the old ceiling rejected anything past ~1100 tasks.
 *
 * Why 64 and not more: the reverse proxy caps a request body at 100 MB
 * (`request_body max_size` in infra/caddy/Caddyfile). MCP `file_upload` carries
 * bytes as base64, which inflates 4/3 — so 64 MB is ~85 MB on the wire, the
 * largest round number that still clears the proxy with room for multipart
 * overhead. Raise the proxy limit first if this ever needs to go higher.
 *
 * ⚠️ Coupled to Tika's JVM heap. `-Xmx1g` (docker-compose.yml) was sized against
 * the 25 MB ceiling, because Office formats unzip to many times their size as
 * XML and Tika holds that in heap. A 64 MB .pptx/.docx can now be accepted at
 * upload and still OOM the parse (the signal is `chars_out: 0` with a short
 * duration in the `parse_document` step). On an 8 GB+ box, -Xmx2g. This does not
 * affect the MSPDI path, which streams and never reaches Tika.
 */
export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024; // 64 MB
