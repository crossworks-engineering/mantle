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
                    │    └ textless PDF → rasterize → vision OCR     │
                    │  odt/ods/odp/pptx/ppt/doc/rtf/epub → Tika     │
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
| **Files UI** | `apps/web/app/api/files/files/route.ts` | any type, ≤64 MB | target folder (`upsertFile`) | — | extractor (on insert) | no | `content_ingest` (save) → `extractor_run` (+`photo_ingest` for images) | 409 dup / 400 / 413 |
| **Web /assistant** | `apps/web/app/api/assistant/turn/route.ts` | images + docs¹, ≤64 MB | `/files/assistant-uploads/<date>/` | `extractAttachmentForTurn` (question-aware) | extractor (on insert) | **yes** | `content_ingest` (save) → `photo_ingest`/`content_ingest` (inline) → `responder_turn` → `extractor_run` | graceful note + 1× text-only retry; **idempotent** (Idempotency-Key) |
| **Telegram** | `apps/agent/src/main.ts` (`handleMessage`) | `photo` + `document` (voice → STT) | `/files/telegram-uploads/<date>/` | `extractAttachmentForTurn` (question-aware) | extractor (on insert) | **yes** | `photo_ingest`/`content_ingest` (inline) → `responder_turn` → `extractor_run` | graceful apology on download failure (M1); atomic claim prevents dup reply |
| **Disk-sync watcher** | `apps/web/workers/files-watch.ts` → `syncFileFromDisk` | `WATCHED_EXTS`² | (already on disk; DB only) | — | extractor (insert trigger; explicit notify on update) | no | `extractor_run` (+`photo_ingest`) | per-event try/catch; sha no-op |
| **MCP `file_upload`** | `apps/mcp/src/server.ts` | `content_text` / `content_base64`, ≤64 MB | parent folder (`upsertFile`) | — | extractor (on insert) | no | `extractor_run` (+`photo_ingest`) | `isError` on failure / oversize |

¹ Documents = `pdf, docx, xlsx, xls, csv, txt, md, json, yaml`. Other types → 415.
² `WATCHED_EXTS` = text exts + pdf/docx/xlsx + png/jpg/jpeg/gif/webp/svg.

**Images everywhere** are HEIC-transcoded before vision, and obey the
per-provider size guard (`maxImageBytesFor`) for the responder's raw-pixel
fallback — the durable index always goes through the vision worker regardless.

**Spreadsheets everywhere** (`.xlsx` / `.xls` / `.csv`) are additionally turned
into typed Table(s) during the durable index pass (`maybeAutoTableSpreadsheet`):
one per non-empty sheet, paginated past `MAX_GRID_ROWS`, deduped by source file —
so a register reaches `/tables` regardless of which upload path it arrived on.
See [tables.md](tables.md) §3.

---

## 3. Shared primitives (the "no duplication" layer)

| Helper | Package | Used by | Purpose |
|---|---|---|---|
| `ensureDatedUploadFolder` | `@mantle/files` | web /assistant, Telegram | ensure `files.<slug>.<YYYY-MM-DD>` exists, return its ltree path |
| `upsertFile` / `syncFileFromDisk` | `@mantle/files` | all save paths | write bytes (disk first) + DB node; sanitise filename; sha dedup |
| `parseDocumentBytes(bytes, ext)` | `@mantle/files` | extractor, `extractAttachmentForTurn` | three-tier dispatch: in-process parsers (pdf-parse/mammoth/SheetJS) → Tika fallback → empty string. `.xml` is the one **content-sniffed** branch: a Project plan renders via `@mantle/files/mspdi`, anything else falls to Tika. **Spreadsheets are bounded** — see note below. |
| `parseMspdi(bytes)` / `parseMspdiToGrids` / `renderMspdiText` | `@mantle/files/mspdi` | `parseDocumentBytes` (xml branch), extractor auto-table | Microsoft Project **MSPDI** (`.xml`, File → Save As → XML) → `ParsedSheet[]` (Tasks / Resources / Assignments) + a text rendering. Routed by **content, not extension**: `sniffMspdi` needs a `Project` root AND (the MSPDI namespace OR a `<Tasks>` element), because `.xml` is a container and a false positive would push an unrelated document through a task-grid mapper. Streaming (`saxes`) — half a real plan's bytes are `<TimephasedData>` the importer discards. Never-throws: a file that sniffs as a plan but yields no rows falls through to Tika, so the worst case is a searchable document, never nothing. Traps handled: fractional-second durations, slack/lag in tenths of a minute, `Summary` roll-up rows (a naive total overstates ~5x on a 5-level outline), the `-65535` unassigned sentinel, and custom fields emitted only when a row populates them. |
| `rasterizePdfToPngs(bytes, {maxPages})` | `@mantle/files/rasterize` | extractor (`ocrIngestPdfNode`) | render a textless PDF's pages → PNG for the OCR fallback (lazy `pdf-to-png-converter`; pdfjs + `@napi-rs/canvas`) |
| `parseTikaBytes(bytes, {mimeType})` | `@mantle/files/tika` | `parseDocumentBytes` (tier 2) | PUT to `apache/tika:3.3.0.0` docker service → plain text. Never-throws: any failure (service down, timeout, unparseable) returns `''`. Handles .odt/.ods/.odp/.pptx/.ppt/.doc/.rtf/.epub. Tika's JVM heap is capped at **1 GB** (`JAVA_TOOL_OPTIONS=-Xmx1g`) — headroom for large Office files (a ~24 MB .pptx unzips to many× its size as XML); was 512m, which OOM'd big real decks to an empty parse. Raise to `-Xmx2g` on an 8 GB+ box with heavy deck workloads. Tika extracts **slide/document text only**; its embedded images come out through the separate `/unpack/all` endpoint (see §3a), not this one. Single-file ceiling is `MAX_UPLOAD_BYTES` (64 MB) — note that ceiling rose from 25 MB for Project/XML plans, so a 64 MB Office file can now be accepted at upload and still OOM a 1 GB heap. |
| `transcodeImageForVision` | `@mantle/files` | `runVisionWorker` | HEIC/HEIF → JPEG (libheif WASM), passthrough otherwise |
| `runVisionWorker` | `@mantle/agent-runtime` | extractor (neutral), surfaces (question-aware) | resolve default vision worker + key + transcode + adapter; best-effort |
| `extractAttachmentForTurn` | `@mantle/agent-runtime` | web /assistant, Telegram | image→vision / doc→parse → text for the current turn (ephemeral) |
| `buildAttachmentContextText` | `@mantle/agent-runtime` | web /assistant, Telegram | fold extracted text into the turn + surface the node id (`extract_from_image` / `file_read`) |
| `notifyNodeIngested(nodeId)` | `@mantle/db` | all updates + the extractor | the one documented `node_ingested` notify; best-effort |
| `MAX_UPLOAD_BYTES` (64 MB) | `@mantle/files` | Files UI, /assistant, MCP | single storage cap (distinct from the vision limit) |
| `maxImageBytesFor(model)` | `@mantle/tracing` | responder routing | per-provider raw-image size limit |

**Spreadsheets are bounded (`parseXlsx`).** xlsx/xls files routinely declare an
inflated used-range — stray formatting or a deleted-but-not-cleared block pushes
the sheet dimension out to row 1,048,576 / column XFD while the real data is a
handful of cells. SheetJS's `sheet_to_csv` walks the **whole** declared range, so
an unbounded parse iterates millions of phantom cells: minutes of synchronous,
event-loop-blocking work on the single extractor (head-of-line-blocking the whole
extract queue) ending in a multi-MB string. Two prod uploads (720 KB + 591 KB
sheets) hung past the **10-minute trace watchdog** that way — the trace was
opened but recorded **zero steps** (the stall is in the parse, *before* the first
`llm_extract` step) and was reaped as `abandoned`, even though the process never
crashed. [`packages/files/src/xlsx.ts`](../packages/files/src/xlsx.ts) now caps
rows at read time (`sheetRows`, 5 000), clamps each sheet's column span (256),
and caps total output (256 KB), appending a truncation marker when any limit
bites. For recall text this is lossless in practice; a pathological workbook is
truncated rather than stalling ingest.

**The `node_ingested` contract:** migration `0018`'s trigger is **AFTER
INSERT only**. A fresh insert notifies automatically; any code that *updates* a
node's content (or wants to force re-index) must call `notifyNodeIngested`.

---

## 3a. Embedded images — the pictures inside a document

Every parser above is text-only, so until v0.215 a diagram in a Word file or a
screenshot in a PDF manual was dropped on the floor: invisible to recall *and*
to display. Some answers can't be described, only shown — a screenshot of a
settings screen **is** the answer to "how do I configure this".

`extractEmbeddedImages(bytes, ext)` (`@mantle/files/embedded-images`) mirrors
`parseDocumentBytes`'s three-tier shape:

| Tier | Formats | How |
|---|---|---|
| 1 (in-process) | `docx` | mammoth's parsed document AST — the only entry point that honours `transformDocument` is `convertToHtml` (`extractRawText` silently ignores it) |
| 1 (in-process) | `pptx`, `xlsx`, `xlsm`, `odt`, `ods`, `odp` | `@mantle/files/ooxml-media` — zip + relationship walk |
| 1 (in-process) | `pdf` | pdfjs `paintImageXObject`, encoded to PNG via `@napi-rs/canvas` |
| 2 (Tika) | `doc`, `ppt`, `xls`, `xlsb`, `rtf`, `vsd` | `unpackTikaImages` → `PUT /unpack/all` (a capability the Tika container always had and we never called). Never-throws → `[]` |
| 3 | everything else | `[]` |

**Reading order is the product requirement.** A manual's screenshots are only
useful in sequence. Listing `word/media/` gives the wrong answer — part
numbering reflects when a picture was first *embedded*, and an image reused
twenty times appears once — so every extractor walks the document body and
resolves references to parts: slides in numeric order (`slide10` after
`slide2`), sheets in workbook order, pages in page order.

**Naming is deterministic and costs nothing.** The cascade is alt text →
caption → nearest heading → position, rejecting Office's default shape names
(`Picture 3`, `image1.png`) which would otherwise look named while saying
nothing. Titles carry meaning and the source document; **filenames stay
mechanical** (`007-apn-manual-p12.png`) so a lexical listing is reading order
and a reworded caption can't orphan bytes.

**The cost gate runs before any model does.** Pulling bytes out is free and
always happens; only survivors of the deterministic filters earn a vision call:

- container must be renderable (PNG/JPEG/GIF/WebP/BMP/**SVG**) — **EMF/WMF are
  dropped** (no browser renders them, so the node could never be shown)
- both edges ≥ 200 px — this is the real filter; icons and bullets die here.
  SVG is measured on its `width`/`height`, else its `viewBox`, so a vector icon
  is filtered on the same rule as a raster one
- SVG is safe on both display paths: `safeDownloadHeaders` serves it under a
  `sandbox`ed `default-src 'none'` CSP (inert even on direct navigation), and
  Pages + chat both embed via `<img>`, where SVG scripts never run. Office
  stores an inserted SVG behind a raster fallback (`<a:blip>` + an
  `<asvg:svgBlip>` extension), so the OOXML walk **prefers the svgBlip** —
  without that, an EMF fallback would be dropped and the diagram lost
- ≥ 1 KB. Deliberately LOW: flat line art compresses to ~2 KB, and an initial
  8 KB floor rejected exactly the diagrams this feature exists for
- sha256 dedupe collapses the logo repeated on every slide
- 30 per document (`MAX_EMBEDDED_IMAGES_PER_DOC`)

**Scanned PDFs are excluded by shape detection** (one image per page across the
document) — those belong to the rasterize + OCR path above; extracting them
would bury real figures under page scans. pdfjs 1-bit images are skipped rather
than risk a silently inverted picture.

### Where they land, and how they're found

`maybeExtractEmbeddedImages` (extractor) is shaped exactly like
`maybeAutoTableSpreadsheet`: best-effort, isolated, deduped by
`data.sourceFileId`, never able to block the text pass. Images are written to
`files/extracted-images/<document>/` as ordinary `file` nodes — which is what
keeps the feature small, since the extractor already indexes images (vision
describe + OCR reads the labels *inside* a screenshot) and Pages already embeds
a stored image by node id.

Retrieval needed one addition. A vision worker looking at a cropped screenshot
writes "a mobile settings screen with several input fields" — true, and useless
for finding it. Each image therefore stores `data.imageContext` (document,
position, section heading, caption, alt text), prepended to the vision text
before summary/embedding/chunking. Tagged `extracted-image` + `from:<slug>`;
tags also feed the summarizer prompt, so provenance improves the summary too.

### Showing one

- **Chat** — the `show_image` tool (`files` group) returns a
  `ToolArtifact{kind:'image'}`; Telegram gets an explicit `sendPhoto`.
- **Pages** — no tool: the agent writes `![alt](media:<file-id>)`.
- The `visual_answers` skill carries the judgment (show rather than narrate,
  step-by-step images in order, never invent a file id).

### Backfill

`pnpm -C server/web extract:images-backfill` (registry slug
`extract-images-backfill`). Dry-run by default. The parent documents are **free**
— the image pass sits ahead of the extractor's `already_extracted` guard, so no
text/summary/embedding work re-runs; spend is one vision call per image *kept*.

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
| V1 | 🟡 | **Vision LLM cost showed `$0`** — `runVisionWorker` set token metadata but never fed the trace cost, so vision spend was invisible in `/debug` (a `photo_ingest` trace showed a 3s `extract_vision` LLM call at cost 0) | ✅ **Fixed (`5ab55ed`)** — `runVisionWorker` now attributes tokens+cost to the active trace/step via the new `recordStepUsage` (`@mantle/tracing`), priced through `fallbackCostMicroUsd`. The pricing table gained the **bare** OpenAI ids (`gpt-4o-mini`/`gpt-4o`) the direct adapters pass — the slug caveat that would otherwise still read 0. Verified live: a 64×64 PNG → `photo_ingest` cost 1310µ$, `extract_vision` step carries model+cost. |
| V2 | 🟡 | **`data.vision_model` ended up empty** on indexed images — the `extractor_run`'s `update_index` overwrote the marker that `persist_vision_text` set | ✅ **Fixed (`a390b3a`)** — `update_index` now MERGEs the index fields onto the live row (jsonb `\|\|`) instead of replacing it from the stale in-memory snapshot, so `vision_model` (+ `text`) written in between survive. Verified live: indexed image retains `vision_model=gpt-4o-mini` alongside summary + embedding. |
| L1 | 🟡 | **Orphan file on disk if the DB insert fails after the disk write** | ⚠️ **Deferred** — currently reconciled coincidentally by the disk-watcher (`syncFileFromDisk` re-creates the node). Acceptable; make the watcher the *designed* reconciler, or add cleanup-on-failure, if it ever bites. |
| L6 | 🟡 | **HEIC image doesn't render in the chat bubble** (echoed/optimistic bytes are HEIC, which browsers can't display) | ⚠️ **Deferred** — cosmetic only; metadata + answer work. Would need a browser-renderable (JPEG) preview, i.e. surface the transcoded copy to the client. |
| — | 🟡 | Telegram `audio`/`video` *file* attachments unhandled (voice notes work via STT) | ⚠️ Deferred — niche; out of scope by decision. |
| — | 🟡 | Whole-file in-memory buffering (≤64 MB) | Accepted — inherent without streaming; fine at single-user scale. |
| T1 | 🟠 | **Tika JVM had no memory cap** — default in-container JVM auto-sizes to ~1/4 of host RAM (unbounded by Mantle's setup). A malicious or pathological doc could push it into OOM territory. | ✅ **Fixed** — `JAVA_OPTS=-Xmx512m -Xms128m` on the Tika service in both compose files. 512 MB max comfortably handles Mantle's 25 MB `MAX_UPLOAD_BYTES` ceiling; `parse_document` step's `chars_out: 0` + short duration is the signal that Tika OOM'd if it ever happens. |
| T8 | 🟡 | **Conversational attachment path (`extractAttachmentForTurn`) didn't trace its `parseDocumentBytes` call.** The durable extractor wrapped it in `parse_document` (`80b86c1`) but the live chat-turn path didn't — so a `.pptx` dropped in chat would have its Tika parse invisible in the `responder_turn` trace. | ✅ **Fixed** — same `parse_document` step now wraps the call in `packages/agent-runtime/src/attachments.ts`. Both paths use identical meta keys (`parser`, `chars_out`, `empty`), so filtering / aggregating works uniformly across surfaces. |
| T2 | 🟡 | **No request-concurrency limit** between Mantle and Tika. N concurrent uploads → N concurrent Tika requests; could OOM the JVM under load. | Accepted — single-user system, realistic concurrent ingests are 1–3 (Gmail All Mail bursts already-deduped). The 512 MB cap (T1) protects from runaway-doc OOM; concurrent OOM would need ~5+ huge docs at once. |
| T3 | 🟡 | **60s per-request Tika timeout** is tight on very large documents on slow hardware (worse since the cap rose to 64 MB). | Accepted — degrades to `no_text_layer` skip (clearly visible in `/traces`); user can re-upload smaller, or `TIKA_TIMEOUT_MS` could be exposed as an env var later. |
| T4 | 🟢 | **Mismatched extensions could mislead Tika.** We pass `Content-Type` via `mimeForExt(ext)`. A file renamed (e.g. .pdf → .ods) would get the wrong hint. | Tika's content-sniffing fallback handles most mismatches via magic bytes; `sanitizeFilename` keeps extensions stable through Mantle's path. Not actionable. |
| T5 | 🟢 | **Tika is occasionally a CVE target** (e.g. CVE-2022-33915 RCE via crafted documents). Self-hosting reduces the attack surface vs SaaS but doesn't eliminate it. | Mitigations in place: bound to internal docker network in prod (no host port); bytes come from authenticated uploads only; image pinned to `3.3.0.0` (bump on CVE — watch the Apache Tika security page). Not a current bug. |
| T6 | 🟢 | **No retry logic in Tika client.** A transient network blip → `''` → `no_text_layer` skip. | Accepted — retries happen at the surrounding level (pg-boss retries the whole email-attachment job; the extractor re-fires on `pg_notify('node_ingested', id)`). Adding a retry inside the client would double-count timeouts. |
| T7 | 🟢 | **Live conversational path inherits the 60 s Tika timeout** — could add visible latency to a chat turn if a big PPTX is attached. | Accepted — the Tika client accepts a per-call `timeoutMs`; callers can pass a shorter one (e.g. 15 s) for the inline path if it becomes a problem in practice. Not exercised yet. |
| E1 | 🟠 | **Large documents (hundreds of chunks) time out at `embed_batch`/`write_chunks` on a CPU-only embedder** — slow serial inference × many chunks, worsened by concurrent extractor jobs contending for cores. Surfaced bulk-reindexing a data analyst's `.xlsm` workbooks; the file ends up with only a title chunk and the job retry-loops. | ✅ **Mitigated** — `EXTRACT_CONCURRENCY`/`MANTLE_LOCAL_EMBED_BATCH`/`MANTLE_LOCAL_EMBED_TIMEOUT_MS` now pass through the compose anchor (`0870876`); drop concurrency to 1 + batch to 8 on a slow box (`docs/embeddings.md` → "Throughput on a CPU-only box"). The real fix is a faster/GPU/remote embedder. Verified: a 433 KB workbook went 0 → 295 chunks after tuning. |

### Verified live (DB tracing, 2026-05-20)
A Telegram photo now produces the full chain — `content_ingest` (save) →
`photo_ingest` source=extractor (`read_file · extract_vision · persist_vision_text`)
→ `extractor_run` (`llm_extract · embed_batch · update_index · reconcile_entities`)
— with `data.text` (neutral description), `summary`, `embedding`, **and a fact**
persisted. Decoupling (neutral index vs specific chat answer) and L5 single-pass
(one `photo_ingest`→`extractor_run`, no re-fire) confirmed against the live DB.

### What would reach a flat A
V1 (vision cost) + V2 (`vision_model`) are now closed. Remaining: make the
orphan-file reconciliation **deliberate** (L1) and add a renderable HEIC
preview (L6); optionally stream large uploads instead of buffering.

---

## 5. Changelog (this arc)

Newest first — all on `main`.

| Commit | What |
|---|---|
| _(this change)_ | **`needs_export` disposition.** A format we can NAME but can't read — Microsoft Project (`.mpp`/`.mpt`) today — now records `skipped: needs_export` with the export that fixes it, instead of falling through the parser ladder to an empty body and indexing as a filename-only *apparent success*. That silent-success case is the real bug: the user believes the plan is in the brain and nothing contradicts them. `EXPORT_REQUIRED_EXTS` (`@mantle/files`) maps the extension to its recovery move; the check sits ahead of the whole ladder in `loadExtractableBody`. Native `.mpp` reading would mean MPXJ (Java, a JVM sidecar) — deferred, and an export is required either way, so an MSPDI-XML → Tables importer is the intended route. |
| _(this change)_ | **Durable, concurrency-capped extract queue.** The `node_ingested` handler was an in-memory 2s debounce that, when the window closed, launched `extractNode` for **every** queued node at once — no concurrency cap, no retry, errors swallowed by a bare `.catch`. A burst of 20–30 file inserts (each a fan-out of summary + embedding + fact + per-fact-classifier LLM calls) overwhelmed the provider rate limit; the failures were logged and dropped, so those files silently never got a summary/embedding/facts. Replaced with a durable **`mantle.extract` pg-boss queue** (`apps/agent/src/extract-queue.ts`, schema `pgboss`, shared with the email/telegram workers): N `batchSize:1` workers cap concurrency (`EXTRACT_CONCURRENCY`, default 2); queue `retryLimit=5` + `retryBackoff` spreads rate-limit retries over minutes; exhausted jobs dead-letter to `mantle.extract.dead`; per-node coalescing comes from the queue's **`policy: 'short'`** (the partial unique index on `(name, singleton_key) WHERE state='created'` — `singletonKey` alone is a NO-OP on a `standard` queue, the 2026-06-10 fix) plus an in-process per-node promise chain for the queued-during-active case; the dead-letter queue is re-driven on every agent start and surfaced by `/debug/integrity`; the boot drain (`drainUnextractedNodes`) and graceful SIGINT/SIGTERM stop round out durability. |
| `45f6873` | **`bytes_unavailable` disposition.** A file node indexed by metadata (sha256) whose bytes were never persisted to object storage (e.g. an email attachment from a header-scanned-but-unfetched sender) now records `skipped: bytes_unavailable` (with the sha256 + a re-fetch hint) instead of the misleading `no_text_layer`. `ocrIngestPdfNode` returns `bytesMissing` when `loadFileBytes` finds nothing. |
| `a9bb143` | **PDF password vault (C).** Password-protected PDFs (financial statements) auto-unlock: the extractor tries each vaulted password via `extractPdfTextWithPassword` (pdfjs — the only parser that takes a password) to read the text layer. `pdf_passwords` table (sealed AES-256-GCM, migration 0054); `/settings/pdf-passwords` UI; `tryUnlockPdf` in the `encrypted_pdf` branch. |
| `1d4d5b8` | **NUL sanitize (A) + `encrypted_pdf` disposition (B).** `cleanText` strips NUL bytes that Postgres text/jsonb can't store (a document read perfectly was being lost on the persist step). Password-protected PDFs now record `encrypted_pdf` (locked → supply a password), not the misleading `no_text_layer`. |
| `9370527` | **Read attachment bytes from object storage.** The extractor only read bytes from local disk (via `data.filename`); email attachments store bytes in object storage by `data.sha256` with no filename, so **every** email attachment fell through to a hollow filename-only summary. New `loadFileBytes(node)` tries disk → then object storage (`contentKey(sha256)`); the vision/OCR/PDF trigger guards no longer require `data.filename`. Recovered the entire email-attachment corpus (invoices, statements, contracts). |
| _(this change)_ | **Tika audit follow-ups** — capped JVM heap at 512 MB (`JAVA_OPTS=-Xmx512m -Xms128m`) so a pathological doc can't OOM the container (T1); wrapped the live conversational `parseDocumentBytes` call in the same `parse_document` step the durable extractor uses so chat-attachment Tika parses are visible in `responder_turn` traces (T8). T2–T7 documented in the audit table above. |
| _(previous)_ | **Apache Tika fallback** (3rd tier in `parseDocumentBytes`) for formats the in-process parsers don't handle: `.odt`/`.ods`/`.odp` (LibreOffice), `.pptx`/`.ppt` (PowerPoint), `.doc` (legacy Word), `.rtf`, `.epub`. New `apache/tika:3.3.0.0` sibling docker service (`mantle_tika`, port 9998); `@mantle/files/tika` is a never-throws wrapper that PUTs bytes and returns plain text (or `''` on any failure → honest `no_text_layer` skip). `INGESTABLE_EXTS` grew to include the new types. Self-hosted; bytes never leave the VPS. Every binary parse now writes a **`parse_document` trace step** inside `extractor_run` with `parser: pdf-parse \| mammoth \| sheetjs \| utf8 \| tika`, `bytes_in`, `chars_out`, `empty`, so "Tika is down" vs "the doc really has no text" vs "pdf-parse silently gave nothing" are distinguishable from `/traces` instead of indistinguishable. |
| _(previous)_ | **OCR fallback for scanned/image-only PDFs.** A textless PDF (`parseDocumentBytes` → nothing, body falls back to the filename) is rasterized → run through the neutral vision worker page-by-page (`ocrIngestPdfNode`, `photo_ingest` `mode=pdf_ocr`, capped at `MAX_OCR_PAGES`). If OCR also yields nothing it records `skipped: no_text_layer` instead of a filename-only false `success`. New dep `pdf-to-png-converter` behind `@mantle/files/rasterize`. |
| `91cf43f` | Add `heic-convert` as a direct web dep so Next externalizes it |
| `a390b3a` | Preserve `data.vision_model` — merge the index write (V2) |
| `5ab55ed` | Attribute vision-worker cost to the trace (V1) |
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
