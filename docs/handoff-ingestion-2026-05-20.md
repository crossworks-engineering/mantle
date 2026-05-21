# Handoff — file ingestion arc (2026-05-20)

Resume point after a long session that fixed `/assistant` vision, unified
attachment ingestion across all surfaces, audited it for production, and
verified it live via DB tracing. **Canonical reference:**
[`file-ingestion.md`](./file-ingestion.md) (flow table + full audit). This doc
is the "what's done / what's left / how to resume" summary.

---

## TL;DR state

- The attachment pipeline (Files UI · /assistant · Telegram · disk-watcher ·
  MCP) is unified and **working end-to-end, verified against the live DB.**
- One **critical bug** (`B1`, dated-folder save silently failing) was found
  *during testing* and fixed via **migration `0032`** (already applied to the
  running DB).
- **3 small items remain open** (below). None block; two are cosmetic-ish.
- Grade: **A−** (see file-ingestion.md §4).

## Architecture (one line)
Two layers: the **extractor** is the single durable-metadata producer
(`data.text` + summary + embedding + facts) for every file; the conversational
surfaces (web /assistant, Telegram) add an **ephemeral question-aware** read
for the live reply via the shared `extractAttachmentForTurn`. Shared primitives:
`runVisionWorker`, `parseDocumentBytes`, `buildAttachmentContextText`,
`ensureDatedUploadFolder`, `transcodeImageForVision`, `notifyNodeIngested`,
`MAX_UPLOAD_BYTES`, `maxImageBytesFor`.

---

## ✅ Done + verified

- Vision-500 fix, transcript-default, Telegram photo **and document** parity,
  HEIC transcode, decoupling (neutral index vs specific chat answer), unified
  ingestion, standardized 25 MB cap, audit fixes M1/M2/L2/L3/L4/L5.
- **B1 (migration 0032)** — folder slugs were globally unique
  (`nodes_owner_slug_uq`), so a 2nd upload surface's same-day dated folder
  (`telegram-uploads/<date>` vs `assistant-uploads/<date>`) collided on slug,
  the INSERT was swallowed as a dup, and the file silently never saved.
  Migration scopes the index to `type <> 'branch'`. **Applied to the live DB**
  and verified: Telegram photo → file saved under `files.telegram_uploads.<date>`
  → `photo_ingest`(extractor) → `extractor_run` → text+summary+embedding+fact.

## ⚠️ Open — pick up here

1. **V1 — vision cost shows `$0`** (cost visibility). `runVisionWorker`
   (`packages/agent-runtime/src/attachments.ts`) sets token *metadata* but never
   feeds the trace cost. Fix: after `adapter.extract`, attribute via
   `currentStep()` + `fallbackCostMicroUsd(worker.model, {input,output})` (both
   from `@mantle/tracing`). Caveat: the vision worker's model must be in the
   pricing table (`packages/tracing/src/pricing.ts`) or cost still computes 0 —
   check coverage for the configured vision model.
2. **V2 — `data.vision_model` ends up empty** on indexed images (cosmetic). The
   `extractor_run` `update_index` step in `apps/agent/src/extractor.ts`
   overwrites the marker that `visionIngestImageNode`'s `persist_vision_text`
   set. Fix: make the final index write MERGE `data` (`||`) instead of
   replacing, or re-read `data` before it.
3. **heic-convert (web)** — `apps/web/package.json` has `heic-convert` added as
   a direct dep but it is **uncommitted in the worktree** and **not installed**.
   Needed because Next can't externalize a transitive (`@mantle/files`-only)
   package — without it, web HEIC uploads fail to transcode (degrade to no
   metadata; non-HEIC unaffected). To finish: commit it, `pnpm install`,
   restart. (Telegram/extractor HEIC already work — they're not bundled.)

## Deferred (by decision — see file-ingestion.md §4)
- L1 orphan-file-on-partial-save (watcher reconciles coincidentally).
- L6 HEIC doesn't render in the chat bubble (cosmetic).
- Telegram `audio`/`video` *file* attachments (voice notes work via STT).
- Whole-file in-memory buffering ≤25 MB (inherent).

## Git / deploy state
- `main` is at `7e06892` (migration 0032). **`origin/main` is 1 commit behind —
  not pushed yet.** Push when ready (`git push origin main`).
- Worktree `.claude/worktrees/admiring-lichterman-1a978d` has the uncommitted
  `apps/web/package.json` (heic-convert) — see open item 3.
- Workflow: work in the worktree, ff-merge to `main`, push only when asked.
- After the open fixes: needs `pnpm install` (heic) + a stack restart.

## Tests still worth running (not yet exercised live)
- Web `/assistant`: a **document** (PDF/docx/csv) attachment → answered + indexed.
- Web `/assistant`: a **real HEIC** upload (after the heic-convert install).
- **Idempotency** (L3): double-submit / retry → no duplicate turn.
- Telegram **document** (PDF) → saved + answered.

## How to trace (psql against the running DB)
```
docker exec mantle_pg psql -U postgres -d postgres -P pager=off -c "<sql>"
```
Useful queries:
- Recent uploaded file + enrichment:
  `SELECT path::text, data->>'filename', (data?'text') has_text, length(data->>'text'),
   (data?'summary') has_summary, data->>'vision_model', (embedding IS NOT NULL)
   FROM nodes WHERE type='file' AND path::text LIKE 'files.telegram_uploads%'
   ORDER BY created_at DESC LIMIT 1;`
- Trace chain for a node: `SELECT kind, status, data->>'source', duration_ms, cost_micro_usd
   FROM traces WHERE subject_id='<uuid>' ORDER BY created_at;`
- Steps in a trace: join `trace_steps` on `traces.id = trace_steps.trace_id`.
- Confirm a migration applied: `SELECT indexdef FROM pg_indexes WHERE indexname='<name>';`

## Key files
- `apps/agent/src/extractor.ts` — durable index; `visionIngestImageNode` (V2 here).
- `packages/agent-runtime/src/attachments.ts` — `runVisionWorker` (V1 here),
  `extractAttachmentForTurn`.
- `apps/web/app/api/assistant/turn/route.ts` — web upload + idempotency (L3).
- `apps/agent/src/main.ts` — Telegram `handleMessage` attachment branch.
- `packages/files/src/{ops,parse,transcode,limits,slug}.ts` — save + helpers.
- `packages/db/src/notify.ts` — `notifyNodeIngested`.
