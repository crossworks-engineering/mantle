# File ingestion

How a file/image/document enters Mantle, gets stored, indexed, and answered —
across every entry point. This is the canonical reference for the upload
subsystem; companion to [`ai-workers.md §5b`](./ai-workers.md) (vision/worker
detail) and [`architecture.md §9f`](./architecture.md) (the one-paragraph view).

---

## 1. The model — two responsibilities, cleanly separated

Every file triggers up to two distinct jobs:

1. **Durable indexing (universal, async).** `save → pg_notify('node_ingested')
   → the extractor`. The **extractor is the single producer** of durable,
   query-independent metadata — `data.text` + `data.summary` + `embedding` +
   facts — for *every* file however it arrived. Type-dispatched: images →
   neutral vision (describe+OCR), pdf/docx/xlsx → parsed, text → `data.content`.

2. **Live answer (conversational surfaces only, sync, ephemeral).** The web
   `/assistant` and Telegram run a **question-aware** read of the attachment
   for the immediate reply, via one shared helper. Never persisted — the
   conversation gets the specific answer; the index gets clean neutral metadata.

```
                       ┌──────────── save bytes ───────────┐
 entry point ──────────┤  upsertFile / syncFileFromDisk     │
   (5 of them)         └──────────────────┬─────────────────┘
                                          │ AFTER INSERT trigger (0018)
                                          │ or explicit notifyNodeIngested()
                                          ▼
                              pg_notify('node_ingested')
                                          │
                                          ▼
                    ┌──────────── extractor (apps/agent) ───────────┐
                    │  image → runVisionWorker (neutral)            │  DURABLE
                    │  pdf/docx/xlsx → parseDocumentBytes           │  INDEX
                    │  text → data.content                          │
                    │  → data.text + summary + embedding + facts    │
                    └───────────────────────────────────────────────┘

 conversational surfaces ALSO, before the reply (ephemeral):
   extractAttachmentForTurn() → question-aware text → folded into the turn
```

---

## 2. Flow of files from every source

| Source | Entry point | Accepts | Saved to | Inline extract (live answer) | Durable index | Runs responder? | Traces | Failure handling |
|---|---|---|---|---|---|---|---|---|
| **Files UI** | `apps/web/app/api/files/files/route.ts` | any type, ≤25 MB | target folder (`upsertFile`) | — | extractor (on insert) | no | `content_ingest` (save) → `extractor_run` (+`photo_ingest` for images) | 409 dup / 400 / 413 |
| **Web /assistant** | `apps/web/app/api/assistant/turn/route.ts` | images + docs¹, ≤25 MB | `/files/assistant-uploads/<date>/` | `extractAttachmentForTurn` (question-aware) | extractor (on insert) | **yes** | `content_ingest` (save) → `photo_ingest`/`content_ingest` (inline) → `responder_turn` → `extractor_run` | graceful note + 1× text-only retry; **idempotent** (Idempotency-Key) |
| **Telegram** | `apps/agent/src/main.ts` (`handleMessage`) | `photo` + `document` (voice → STT) | `/files/telegram-uploads/<date>/` | `extractAttachmentForTurn` (question-aware) | extractor (on insert) | **yes** | `photo_ingest`/`content_ingest` (inline) → `responder_turn` → `extractor_run` | graceful apology on download failure (M1); atomic claim prevents dup reply |
| **Disk-sync watcher** | `apps/web/workers/files-watch.ts` → `syncFileFromDisk` | `WATCHED_EXTS`² | (already on disk; DB only) | — | extractor (insert trigger; explicit notify on update) | no | `extractor_run` (+`photo_ingest`) | per-event try/catch; sha no-op |
| **MCP `file_upload`** | `apps/mcp/src/server.ts` | `content_text` / `content_base64`, ≤25 MB | parent folder (`upsertFile`) | — | extractor (on insert) | no | `extractor_run` (+`photo_ingest`) | `isError` on failure / oversize |

¹ Documents = `pdf, docx, xlsx, xls, csv, txt, md, json, yaml`. Other types → 415.
² `WATCHED_EXTS` = text exts + pdf/docx/xlsx + png/jpg/jpeg/gif/webp/svg.

**Images everywhere** are HEIC-transcoded before vision, and obey the
per-provider size guard (`maxImageBytesFor`) for the responder's raw-pixel
fallback — the durable index always goes through the vision worker regardless.

---

## 3. Shared primitives (the "no duplication" layer)

| Helper | Package | Used by | Purpose |
|---|---|---|---|
| `ensureDatedUploadFolder` | `@mantle/files` | web /assistant, Telegram | ensure `files.<slug>.<YYYY-MM-DD>` exists, return its ltree path |
| `upsertFile` / `syncFileFromDisk` | `@mantle/files` | all save paths | write bytes (disk first) + DB node; sanitise filename; sha dedup |
| `parseDocumentBytes(bytes, ext)` | `@mantle/files` | extractor, `extractAttachmentForTurn` | format→parser dispatch (pdf/docx/xlsx/text) |
| `transcodeImageForVision` | `@mantle/files` | `runVisionWorker` | HEIC/HEIF → JPEG (libheif WASM), passthrough otherwise |
| `runVisionWorker` | `@mantle/agent-runtime` | extractor (neutral), surfaces (question-aware) | resolve default vision worker + key + transcode + adapter; best-effort |
| `extractAttachmentForTurn` | `@mantle/agent-runtime` | web /assistant, Telegram | image→vision / doc→parse → text for the current turn (ephemeral) |
| `buildAttachmentContextText` | `@mantle/agent-runtime` | web /assistant, Telegram | fold extracted text into the turn + surface the node id (`extract_from_image` / `file_read`) |
| `notifyNodeIngested(nodeId)` | `@mantle/db` | all updates + the extractor | the one documented `node_ingested` notify; best-effort |
| `MAX_UPLOAD_BYTES` (25 MB) | `@mantle/files` | Files UI, /assistant, MCP | single storage cap (distinct from the vision limit) |
| `maxImageBytesFor(model)` | `@mantle/tracing` | responder routing | per-provider raw-image size limit |

**The `node_ingested` contract:** migration `0018`'s trigger is **AFTER
INSERT only**. A fresh insert notifies automatically; any code that *updates* a
node's content (or wants to force re-index) must call `notifyNodeIngested`.

---

## 4. Production audit

Graded as a single-user, self-hosted family system. **Grade: A−.** No critical
security or data-loss defects: path traversal is defended (`sanitizeFilename` +
`diskPathForFile` separator reject + `diskPathForLtree` containment guard), all
surfaces are auth-gated and size-capped, and enrichment is best-effort +
traced.

### Findings & status

| # | Sev | Finding | Status |
|---|---|---|---|
| M1 | 🟠 | Telegram transient download failure silently dropped the message | ✅ Fixed — graceful apology, recorded on the trace |
| M2 | 🟠 | Web /assistant inline extraction was untraced | ✅ Fixed — wrapped in `photo_ingest`/`content_ingest` + step |
| L2 | 🟡 | Image base64 echoed back in the turn response | ✅ Fixed — metadata only; client keeps local preview |
| L3 | 🟡 | No idempotency on web double-submit | ✅ Fixed — `Idempotency-Key` replay (in-memory, 2-min TTL) |
| L4 | 🟡 | `node_ingested` notify scattered as raw SQL (implicit contract) | ✅ Fixed — `notifyNodeIngested` helper, 9 sites migrated |
| L5 | 🟡 | Two-pass image extraction (re-fire round-trip) | ✅ Fixed — single pass; `visionIngestImageNode` returns text |
| B1 | 🔴 | **Dated upload folders silently failed to save** for any second surface on the same day — `nodes_owner_slug_uq` made folder slugs globally unique, so e.g. `telegram-uploads/2026-05-20` collided with `assistant-uploads/2026-05-20` on slug `2026-05-20`; the INSERT was swallowed as a "duplicate" and the file never persisted (caught by **DB tracing during testing**) | ✅ **Fixed — migration `0032`** scopes the slug-unique index to `type <> 'branch'` (folders are path-unique). Verified live: Telegram photo → file saved + indexed. |
| V1 | 🟡 | **Vision LLM cost shows `$0`** — `runVisionWorker` sets token metadata but never calls `captureLlmUsage`, so vision spend is invisible in `/debug` (a `photo_ingest` trace shows a 3s `extract_vision` LLM call at cost 0) | ⚠️ **Open** — fix: attribute via `currentStep()` + `fallbackCostMicroUsd(model, tokens)` in `runVisionWorker`. Caveat: the vision worker's model must be in the pricing table or it still reads 0. |
| V2 | 🟡 | **`data.vision_model` ends up empty** on indexed images — the `extractor_run`'s `update_index` overwrites the marker that `persist_vision_text` set | ⚠️ **Open** — cosmetic; merge instead of replace, or re-read `data` before the final write. |
| L1 | 🟡 | **Orphan file on disk if the DB insert fails after the disk write** | ⚠️ **Deferred** — currently reconciled coincidentally by the disk-watcher (`syncFileFromDisk` re-creates the node). Acceptable; make the watcher the *designed* reconciler, or add cleanup-on-failure, if it ever bites. |
| L6 | 🟡 | **HEIC image doesn't render in the chat bubble** (echoed/optimistic bytes are HEIC, which browsers can't display) | ⚠️ **Deferred** — cosmetic only; metadata + answer work. Would need a browser-renderable (JPEG) preview, i.e. surface the transcoded copy to the client. |
| — | 🟡 | Telegram `audio`/`video` *file* attachments unhandled (voice notes work via STT) | ⚠️ Deferred — niche; out of scope by decision. |
| — | 🟡 | Whole-file in-memory buffering (≤25 MB) | Accepted — inherent without streaming; fine at single-user scale. |

### Verified live (DB tracing, 2026-05-20)
A Telegram photo now produces the full chain — `content_ingest` (save) →
`photo_ingest` source=extractor (`read_file · extract_vision · persist_vision_text`)
→ `extractor_run` (`llm_extract · embed_batch · update_index · reconcile_entities`)
— with `data.text` (neutral description), `summary`, `embedding`, **and a fact**
persisted. Decoupling (neutral index vs specific chat answer) and L5 single-pass
(one `photo_ingest`→`extractor_run`, no re-fire) confirmed against the live DB.

### What would reach a flat A
Close V1 (vision cost) + V2 (`vision_model`); make the orphan-file reconciliation
**deliberate** (L1) and add a renderable HEIC preview (L6); optionally stream
large uploads instead of buffering.

---

## 5. Changelog (this arc)

Newest first — all on `main`.

| Commit | What |
|---|---|
| `7e06892` | Scope slug-unique index to non-branch nodes — migration `0032` (B1) |
| `a7f08e3` | This doc — file-ingestion reference (flow table + audit) |
| `fba1b8a` | Idempotent /assistant turns (L3) |
| `766b7da` | `notifyNodeIngested` helper + single-pass image extraction (L4, L5) |
| `3daf2f6` | Harden surfaces — graceful Telegram failure, traced web extract, no base64 echo (M1, M2, L2) |
| `8c9dcf1` | One shared upload cap, `MAX_UPLOAD_BYTES` = 25 MB |
| `604ae4d` | Unified attachment ingestion across all surfaces (shared primitives) |
| `b13f06b` | Decouple inline answer from durable metadata (extractor owns `data.text`) |
| `dc2de18` | HEIC/HEIF → JPEG transcode before vision |
| `6df303d` | Symmetric attachments — vision on stored images + documents in chat |
| `d500bbd` | Transcript-default + Telegram photo→file responder parity |
| `55d7bda` | Vision turns never 500 — size-guard + catch-retry |
