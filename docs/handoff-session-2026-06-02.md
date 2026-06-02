# Session changelog — 2026-06-02 (integrity live view, UI batch, app-wide docks)

A long session: redesigned `/debug/integrity` and `/notes`, shipped a string of
fixes, then built the **app-wide "leave the page and keep working"** pattern
(background uploads + chat dock) and a files self-heal. 11 commits on `main`,
`984299f … b7ab202`, all deployed to the Contabo VPS. Companion: prior session
[`handoff-session-2026-06-01.md`](./handoff-session-2026-06-01.md).

---

## 1. Integrity — Active Probe → passive Live view (`984299f`)

The synthetic Active Probe (28 fixtures per run + scoped cleanup) left "stalled"
residue when you navigated away mid-run — a hazard on prod. **Removed entirely**
and replaced with a **passive, live, real-data view**: `/debug/integrity` →
**Live** tab lists the real content you add (notes, pages, todos, events,
contacts, secrets, files, email), newest-first, each with its brain footprint
(L5 summary · 768-dim embedding · tsv · L4 facts · graph), updating live over the
`node_ingested`/`node_indexed` realtime bridge, with a per-row delete. The
**Corpus Audit** tab is unchanged.

- New: `lib/integrity/{landed,evaluate-landed}.ts` + `evaluate-landed.test.ts`
  (10 tests) + `api/debug/integrity/landed{,/delete}`.
- Honest evaluation: green only on success + searchable layers present; a
  *correct* skip (no vision worker, etc.) reads neutral; red = real bugs
  (success-but-no-summary, dim drift, dup edges).
- **Deleted** the whole fixture harness: `lib/integrity/{fixtures,spec,runner,`
  `lifecycle,cleanup,assert,footprint}.ts` + `assert.test.ts` + `/run` + `/cleanup`
  routes + the `fixtures/files/` sample dir. (Updates [[project_integrity_probe]].)

## 2. Telegram idempotent insert + offset reset (`6da32e4`)

Two real bugs surfaced while splitting bots per environment. (a) The dup-swallow
in `persist()` was broken — a 23505 inside a txn aborts it, so the node-cleanup
catch could never run and the error escaped to the poll worker (and could wedge
the offset into a re-fetch/throw loop). Fixed with `onConflictDoNothing`. (b)
`setAgentTelegram()` now resets `last_update_offset` to 0 when the bot username
changes (per-bot update-id streams) — fixes "changed the token but it didn't
reflect". (See [[project_telegram_dev_prod_poller_conflict]].)

## 3. Notes — spacious, resizable, single-screen (`fd48195`)

Was a fixed 50/50 master-detail where editing meant a `max-w-3xl` boxed page +
a *second* Edit click. Now one resizable screen: draggable divider (persisted),
de-boxed read preview, **one-click in-pane full-height markdown editor** (⌘/Ctrl+S
save, Esc cancel, discard guard), a **Focus** toggle that collapses the list,
inline "New" (no modal). `/notes/[id]` redirects into the editor; old detail
client deleted. Still markdown (storage unchanged).

## 4. facts.superseded_by FK → SET NULL (migration `0065`, `8bdaea9`)

Deleting a node could fail: the kind-aware reaper (0059) hard-deletes a node's
episodic/factual facts, but the self-FK `facts_superseded_by_fkey` was `NO ACTION`
and blocked it whenever a reaped fact superseded an older fact from a *different*
still-present node (normal cross-source supersession). **0065** makes it
`ON DELETE SET NULL`. General fix (not just integrity fixtures). Applied on prod.

## 5. Pages — fold embedded image/file text into the index (`c0d08c5`)

A page references images/file chips as real `file` nodes (vision/OCR'd on their
own ingest), but `docToText` only surfaced the filename — the page was blind to
what's *inside* its images. `commitPage()` now appends referenced files'
`data.text` to `doc_text` (the extractor + FTS read it) via the pure, tested
`foldEmbeddedText` (4 KB/file, 16 KB total). Applies on commit going forward;
existing pages need a re-commit. No reactive re-extract (cost-safe).

## 6. The UI batch (`8389a36 → b7ab202`)

- **`8389a36` pages list refresh** — create navigated to the editor without
  invalidating the SSR list cache; `router.refresh()` after create.
- **`6c6ab24` files inline preview** — non-text files now preview: images (incl.
  **SVG** via `<img>`, script-safe), PDFs (iframe), video, audio; else download
  card. Reuses the raw asset route (already `content-disposition: inline`).
- **`e903721` app-wide background uploads** — see §7.
- **`6bf332b` app-wide chat dock** — see §7.
- **`62fc900` dock stacking + /assistant sync** — both docks live in one
  bottom-right flex stack (no overlap); `/assistant` pulls newly-persisted
  messages on mount + when a foreign turn finishes (covers the router-cache /
  returned-mid-flight gaps) + a "working… (started elsewhere)" row.
- **`b7ab202` files self-heal** — see §8.

## 7. App-wide docks — "leave the page, keep working" (NEW pattern)

The key new architecture, in `apps/web/components/app-shell.tsx` (the persistent
client shell, survives client-side navigation):

- **`components/uploads/upload-provider.tsx`** — `UploadProvider` owns a
  concurrency-3, continue-on-error upload queue; `UploadDock` shows progress.
  `/files` `uploadFiles` now `enqueue()`s into it; the `useRealtime(['file'])`
  on `/files` refreshes the list as each lands. `beforeunload` guard (unsent
  bytes would be lost).
- **`components/assistant/assistant-dock.tsx`** — `AssistantDockProvider` owns
  the `/assistant` turn fetch (so it survives navigation); `AssistantDock` is a
  floating mini-chat (working state, markdown reply, reply box, Open chat). The
  725-line assistant client change was surgical: only the `fetch` became
  `runTurn(...)`. **No beforeunload needed** — the turn route already persists +
  caches by idempotency-key, so a reload doesn't lose it.
- Both docks render **inside the shell `<div>`** so they inherit `--activity-w`
  (sit left of the activity rail), in a shared `pointer-events-none` flex stack.

## 8. Files self-heal — orphaned-upload adoption (`b7ab202`)

`upsertFile` is disk-first then DB-insert. An interrupted upload (disk written,
node insert never ran) orphans a **disk file with no node** → re-upload fails
`'<name>' already exists` and there's nothing in the UI to delete. Fix: look up
the node *before* the disk write; only honor the collision when a real node owns
the name — a disk file with no node is orphan residue, so **adopt it** (overwrite
+ create node). Real duplicates still error.

**Prod data fix (this session):** found one such orphan on prod —
`church/sermons/the-tree-of-knowledge-god-s-design-for-dependence.md` (from
May 29) — via a disk-vs-DB reconciliation and removed it. **Reconciliation
method (reusable for future file debugging):**
```bash
# disk files relative to MANTLE_FILES_ROOT (/data/files on prod):
find $ROOT -type f | sed 's,^./,,' | sort
# DB host-mirrored file nodes → expected relative disk path:
SELECT CASE WHEN path::text='files' THEN data->>'filename'
            ELSE regexp_replace(replace(substring(path::text from 7),'.','/'),'_','-','g')
                 || '/' || (data->>'filename') END
FROM nodes WHERE type='file' AND (path::text='files' OR path::text LIKE 'files.%');
# comm -23 disk db  → orphans (on disk, no node)
```
**⚠ Near-miss lesson:** the first attempt used `$$`-quoted SQL through SSH → the
shell expanded `$$` to the PID → empty DB list → `comm` flagged ALL 102 real
files as "orphans". Caught because it was read-only + the result was absurd.
Always sanity-check a delete list and confirm `count=0` per file before acting.

---

## Deploy state

Prod live + healthy at `b7ab202` (https://jason.crossworks.network). Migration
`0065` applied (now **66** total). All UI/files/chat work deployed; nodes ≈1994.
Telegram poller still **stopped on prod** (dev owns the bots — the per-env bot
split is NOT done yet). Docker Hub `titanwest/mantle:latest` is **stale** (last
pushed at the integrity commit `0be4181…`); push if a registry pull is ever
needed. Pushed `main` to `origin` (`github.com:TitanKing/mantle`) at session end.

## Still open / next
- **Dev/prod Telegram bot split** — discussed (need a separate `@…dev` bot so
  both poll without 409); not implemented. See [[project_telegram_dev_prod_poller_conflict]].
- Pages embedded-text **backfill** (re-commit existing image-bearing pages) — offered, not built.
- `/files` page-embedded images still clutter the Files list (could hide under a
  page-assets area) — deferred.
- May backlog still parked: email-ingest polish, trace cost dashboard, etc.
