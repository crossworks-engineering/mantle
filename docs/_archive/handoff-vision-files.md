# Handoff — vision + files work (2026-05-20)

Resume point after a long session on image/vision + file persistence. Read
this first, then the "Open issue" is the active bug.

---

## 🟢 FIXED (2026-05-20) — `/assistant` image Q&A no longer hard-fails

**Fix shipped:** size-guard + catch-retry (handoff options 1 + 2), dep-free.

- `maxImageBytesFor(model)` added to `packages/tracing/src/model-context.ts`
  (anthropic/* + default → 4.5 MB, openai/* → 18 MB) and exported from the
  package. Unit-tested in `model-context.test.ts`.
- `runAssistantTurn` (`apps/web/lib/assistant.ts`) now only attaches the raw
  image when `base64Bytes(image) <= maxImageBytesFor(agent.model)`; oversized
  images route to the vision-worker transcript as text instead.
- Catch-retry: if the responder errors *with an image attached*, the turn
  retries once without it (transcript-grounded). The failed attempt stays its
  own `error` trace; the retry is a separate `success` trace flagged
  `image_retry_after_error` in trace `data`.

Net behaviour: oversized or otherwise-rejected image → Saskia answers from the
OpenAI mini's description (degraded but works) instead of a 500.

**Still worth doing later:** downscale with `sharp` (handoff option 3) so
Saskia sees the actual picture even when large — deferred (heavy native dep);
note `sharp@0.34.5` is already in the lockfile. Also surface a per-provider
"too large for <provider>" hint at upload time (the 15 MB cap vs Anthropic's
~5 MB mismatch).

**Original symptom (for reference):** Upload a photo to the web `/assistant`
and ask Saskia to identify it → `POST /api/assistant/turn 500` after ~33s,
console showed `[assistant/turn] Response validation failed`.

**What now WORKS (fixed this session):**
- The image **saves** — a `file` node is created and the bytes land on disk
  (e.g. node `1f576e3b`, `…camphoto_….jpeg`).
- The **mini vision worker** (OpenAI `gpt-4o-mini`, the "librarian") runs
  fine — extractor logs `→ content_index: summary (61c)`. OpenAI's 20 MB
  image limit handles the photo.

**What FAILS:** the **responder** vision call. Saskia is
`anthropic/claude-sonnet-4.6`; OpenRouter routes that to **Amazon Bedrock**,
which returns **`400 "Could not process image"`**. The `@openrouter/sdk`
masks this as `ResponseValidationError: Response validation failed` (it
validates the error body against the success schema and throws).

**How that was unmasked (reproduced via a throwaway script):**
```
BadRequestResponseError / "Provider returned error", code 400,
metadata.raw = {"message":"Could not process image"}, provider = Amazon Bedrock
```

**Isolation results (synthetic PNGs through the same SDK path):**
- 64×64 PNG → ✅ works (with `detail:auto`, via Bedrock). So the multimodal
  request **shape is correct** — `{type:'image_url', imageUrl:{url, detail}}`
  (camelCase, matches the SDK's `ChatContentImage`).
- 1×1 PNG → ❌ "Could not process image" (too small — red herring).
- Real `camphoto` (full-res phone photo) → ❌ same error, ~33s.

**Leading hypothesis: the photo exceeds Anthropic/Bedrock's ~5 MB
per-image limit.** Evidence: OpenAI's mini worker (20 MB) handled the same
image; Anthropic/Bedrock (~5 MB) is the strict one; the web upload sends the
full-res original. NOT yet 100%-confirmed because a real >5 MB image
couldn't be retrieved to test in isolation (see "couldn't retrieve" below).

**Proposed fix (NOT built yet — start here):**
1. **Size guard + graceful fallback (dep-free, recommended first):** in
   `runAssistantTurn` (`apps/web/lib/assistant.ts`), only attach the raw
   image when it's within the responder provider's limit; otherwise fall
   back to the mini-worker transcript (`imageTranscript`) as text. The
   plumbing already exists — `canSeeImage` just needs an
   `imageBytes <= maxImageBytesFor(model)` check. Add `maxImageBytesFor()`
   next to `modelSupportsVision()` in `packages/tracing/src/model-context.ts`
   (anthropic/* → ~4.5 MB, openai/* → ~18 MB, default ~4.5 MB).
2. **Catch-and-retry (most robust):** if the responder LLM call errors with
   an image attached, retry once WITHOUT the image using the transcript, so
   a turn never hard-fails on an image regardless of cause.
3. **Downscale (best UX, deferred):** resize images with `sharp` before
   sending so Saskia always sees the picture even when large — but `sharp`
   is a heavy native dep; defer.

Net intended behavior: oversized image → Saskia answers from the OpenAI
mini's description (degraded but works) instead of a 500.

---

## ⚠️ PENDING ACTION — restart the whole dev stack

Several merged fixes need a restart to go live (env + workspace-package
changes that `tsx --watch` won't reliably reload):
- `MANTLE_FILES_ROOT` env (now set in `apps/web/.env.local`) — **needs a
  full stack restart** (web + agent + workers), not just the agent.
- `@mantle/tools` changes (todo tools, `generate_image` folder fix),
  `@mantle/telegram` (photo MIME), `apps/agent` (digest-skip, extractor
  `data.text`, core-tool grant) — **need the agent restarted.**

The web app hot-reloads, so route-only fixes (the `/assistant` upload
folder path) are already live.

---

## Other open threads (from this session)

1. ✅ **FIXED — Telegram photo path now answers.** A photo on Telegram
   (`handleMessage` photo branch in `apps/agent/src/main.ts`) is saved as a
   real **file** node under `/files/telegram-uploads/<date>/`, transcribed by
   the vision worker (transcript persisted to the node's `data.text`), then
   the responder runs (no more short-circuit) so Saskia answers "what is
   this?". Transcript-default with the file node id surfaced for
   `extract_from_image`, mirroring the web /assistant. Shares the folder
   helper (`ensureDatedUploadFolder` in `@mantle/files`) and the text builder
   (`buildAttachmentContextText` in `@mantle/agent-runtime`) with web.
   **Needs the agent restarted to go live.**
2. **Could not retrieve a real failing image** to test the size hypothesis:
   Telegram photos become notes (no bytes); the web upload of the car photo
   wasn't persisted before the files-root fix; the one 4.6 MB image in the DB
   (`325 E Cocklin.png`) returns NoSuchKey from MinIO. Byte storage is split
   between MinIO (email attachments) and disk (`/files`) — worth a future
   audit.
3. **`maxImageBytesFor` / per-provider upload cap.** The app caps uploads at
   15 MB but Anthropic is ~5 MB — surface a clear "too large for <provider>"
   instead of a cryptic 500.

---

## What shipped this session (all on `main`, pushed)

Latest 6 commits (the vision/files arc):
- `f664809` fix(files): ltree path uses underscores for auto-created upload folders (assistant-uploads + generate_image had a dash-vs-underscore ltree bug → "parent folder not found")
- `b550ce5` fix(files): warn when `MANTLE_FILES_ROOT` unset; document it (was unset → each process used a cwd-relative `./data/files` → split-brain; files written by one process invisible to others)
- `284ec48` fix(telegram): detect image MIME on photo downloads (`mimeFromFilename` was audio-only → photos came through as `application/octet-stream` → vision rejected)
- `3ff1e23` tune(vision): describe-and-transcribe (was pure OCR → empty metadata for logos/photos)
- `b7d6d35` feat(assistant): Saskia sees images directly (multimodal `buildChatMessages` + `modelSupportsVision`)
- `9546c9c` feat(assistant): question-aware image vision + persist photo `data.text`

Earlier in the session (also on main): nav usage widget (spend + per-agent
context %); `update_persona` tool (scoped + soft-retire); office-doc
extraction (docx/xlsx/csv via mammoth + SheetJS); extractor JSON
trailing-prose recovery; todos `ORDER BY` null-ordering fix; todo CRUD
tools for the agent; conservative extractor prompt; conversation-digest
clobber fix + `regenerate-digests` script; extractor `data.text`
persistence for binary docs; `docs/data-flow-tracing.md` + `scripts/trace-node.sh`.

---

## Key files for the open issue

- `apps/web/lib/assistant.ts` — `runAssistantTurn` (the `canSeeImage` decision; where the size guard / catch-retry goes)
- `apps/web/app/api/assistant/turn/route.ts` — `processUploadedImage` (mini librarian) + the responder call
- `packages/agent-runtime/src/messages.ts` — `buildChatMessages` (`userImage` → multimodal)
- `packages/tracing/src/model-context.ts` — `modelSupportsVision` (+ add `maxImageBytesFor`)
- `apps/agent/src/main.ts` — Telegram `handleMessage` photo branch (thread #1)

## How to reproduce / verify

1. Restart the stack (see Pending). 2. Web `/assistant`: upload a >5 MB photo
+ "what is this?". 3. Expect the 500 today; after the fix, expect Saskia to
answer (from the mini transcript if oversized). 4. Trace with
`scripts/trace-node.sh <file-node-id>` to confirm the file saved + `data.text`
populated; check `/traces?kind=responder_turn` for the responder result.
