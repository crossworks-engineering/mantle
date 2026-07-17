# Session handover — /team search+pagination, landing composer, forum-uploads plan (2026-07-18)

**Part A is COMMITTED to `main` as `ce0ae113`** (18 files, on top of
`1ad0f238` v0.142.0), with the v0.143.0 changelog at
`docs/_changelog/0.143.0.md`. Two audits ran during the session; all
confirmed findings fixed. Typecheck + eslint clean; **full suite 2345/2345
green** before commit; detached-FE compile/probe green on every touched
route. **NOT pushed, NOT tagged/released** — Jason decides. Dev-brain running
log: task `4f39be51` (per-batch detail). The other active worktree is
`feat/ops-hardening` (different session — leave it alone).

**Part A** below is what's DONE (in the tree). **Part B** is the NEXT feature,
fully planned but NOT started: forum file uploads with owner review.

## Part A — delivered this session (uncommitted, ships together)

### A1. /team workspace sections: search + sort + pagination
All seven member sections (pages/notes/tables/apps/tasks/events/files) share
`TeamSection`, so one change covers all. URL-driven (`?q`/`?sort`/`?page`,
selection stays `?s`), debounced search, `newest|oldest|updated|title` sorts,
`<ListPager>`, PAGE_SIZE 30.
- `packages/content/src/team-hub.ts` — `pageTeamVisibleShares(...{query,sort,limit,offset})`
  → `{items,total}`; `TEAM_SHARE_SORTS`; search = ILIKE title OR `data->>'summary'`.
  Unpaged `listTeamVisibleShares` kept (shell folder chips use it).
- `apps/web/app/api/team/list/route.ts`, `components/team-workspace/team-section.tsx`.

### A2. Forum: topic search/sort/pagination + thread pagination + in-thread search
- `packages/content/src/forum.ts` — `listForumTopics` gains `{offset,query,sort}`
  (`FORUM_TOPIC_SORTS = activity|newest|oldest|title`, pinned always first);
  `countForumTopics`; `searchForumPosts` (per-topic body search, `status='complete'`
  only, snippet centred on hit). Pure snippet logic in NEW
  `forum-search.ts` (`matchSnippet`) + `forum-search.test.ts` (8 tests).
- `apps/web/app/api/team/forum/topics/route.ts` — GET `q/sort/page`, PAGE_SIZE 20.
- NEW `apps/web/app/api/team/forum/topics/[id]/search/route.ts` — in-thread
  search; visibility via `getForumTopic` (absent == forbidden, 404).
- `components/team-forum/topic-list-client.tsx` — search box + sort dropdown + pager.
- `components/team-forum/topic-view-client.tsx` — "Load earlier posts" keyset
  pagination on the existing `before` cursor; find box with jump-to-match
  (pages older until the match loads, scrolls, ring-highlights). Audit fixes
  live here: refetch FOLDS posts sliding out of the newest-50 window into the
  `earlier` buffer (transcript stays contiguous — jump relies on it); stale
  `jumpTargetRef` cleared when a match can't be located; a latent
  Rules-of-Hooks violation (useMemo after early returns) was found and fixed.

### A3. Owner team-admin forum list: search + pagination
- `apps/web/app/(app)/team-admin/page.tsx` — topics view parses `q/page`
  (PAGE_SIZE 30), calls list+count, links preserve context.
- `components/team-forum/admin-topic-controls.tsx` — `AdminTopicSearch` +
  `AdminTopicPager`. **Verified live under real owner auth** (detached FE →
  test box): renders + no runtime errors.

### A4. /team landing "start topic" composer (quick chat box)
Textarea + Private switch + "Start topic" on the /team overview. No title
field — server summarizes the message into the title, creates the topic,
member lands in `/team/forum/<id>` with the agent answer streaming (same
202+turnId flow as NewTopicDialog).
- NEW `apps/web/lib/forum-title.ts` — `titleForTopic`: default SUMMARIZER
  worker (`getDefaultWorker`+`getChatAdapter`, the summarize_text pattern),
  6s hard timeout, `maxRetries:0`, worker params respected,
  `bumpWorkerUsage` on success, `console.warn` on every fallback path.
- NEW `apps/web/lib/forum-title-text.ts` (pure: `clampTitle` code-point-safe,
  `heuristicTitle`, `sanitizeTitle`) + `forum-title-text.test.ts` (11 tests).
- `topics/route.ts` — POST `title` now optional (+ zod `.trim()` so
  whitespace-only 400s); NEW `components/team-forum/start-topic-composer.tsx`;
  mounted in `team-overview.tsx`.

### Shared debounce fix (audit)
All three search boxes use a `lastInputRef` guard: input edits push `?q=`;
external `?q=` changes (back/forward) are ADOPTED into the box, never
re-pushed. Pagers render `page` from the response snapshot (no "page 3/2").
`team-section` shows "Couldn't refresh — showing the last loaded results"
instead of going silently stale.

### Not verified / accepted follow-ups
- **Member-authed rendering** of A1/A2/A4 can't run on the workstation (no
  team session mintable) — logic mirrors the proven /pages + owner paths.
  **Post-deploy smoke on dev**: member search/sort/page each section, forum
  search + jump, quick-box → check the LLM title (needs summarizer worker).
- Accepted (logged, deliberate): ILIKE `%`/`_` unescaped (content-package
  house style; fix repo-wide with an escapeLike helper someday); per-row
  EXISTS ILIKE has no index (fine at team scale); IME-Enter + fresh
  idempotency-key-per-retry quirks (parity with pre-existing composers — fix
  all-or-none later); composer/NewTopicDialog fetch dedup; aria-labels;
  adapter-level abort (needs @mantle/voice API change).

## Part B — NEXT: forum file uploads with owner review (full plan, not started)

Member uploads files on a forum post → files are QUARANTINED (not in the
brain) → owner reviews in team-admin → per file: Download / Move to files /
Dismiss. "Move to files" lands in `files/review/<topic-name>/` and only THEN
ingests. This is the "Phase 4" the schema stubbed: `forum_posts.attachments`
(`ConversationAttachment[]`) already exists.

### Grounding facts (verified in-repo)
- `ConversationAttachment = {kind: image|audio|voice|document|video, mime?,
  caption?, nodeId?, fileId?, url?}` (`packages/db/src/schema/assistant-messages.ts`).
- File bytes live ON DISK (`packages/files`: `writeFile`/`diskPathForFile`),
  nodes in `nodes`; **creating a file node auto-ingests it** (migration 0018
  pg_notify trigger) → uploads must NOT create file nodes until approved.
- `MAX_UPLOAD_BYTES = 25MB` (`packages/files/src/limits.ts`); no extension
  allowlist on the owner surface; `sanitizeFilename`/`mimeForExt` exist.
- Serving pattern: `/s/[token]/a/[fileId]` route — `safeDownloadHeaders` +
  Range support (`apps/web/lib/safe-download.ts`).
- team-admin Requests tab exists (`packages/content/src/team-requests.ts`,
  tasks tagged `team-request`); uploads queue slots in beside it.
- `createFolder` (@mantle/files) for `files/review/<topic>` creation.
- Latest migration: `packages/db/migrations/0124_*` → this is **0125**.

### Data model — migration 0125 `forum_uploads`
```
forum_uploads (
  id uuid PK, owner_id uuid NOT NULL,
  topic_id uuid NOT NULL REFERENCES forum_topics ON DELETE CASCADE,
  post_id uuid NULL REFERENCES forum_posts ON DELETE CASCADE,  -- null while staged
  contact_id uuid NULL,            -- uploader; SET NULL on contact deletion
  filename text NOT NULL, mime text NOT NULL, size_bytes int NOT NULL,
  status text NOT NULL DEFAULT 'staged',  -- staged|pending|filed|dismissed
  node_id uuid NULL,               -- set when filed into the files tree
  created_at timestamptz NOT NULL DEFAULT now(), reviewed_at timestamptz NULL
)
-- index (owner_id, status), (post_id)
```
Bytes on disk at `data/forum-uploads/<ownerId>/<uploadId>` — a SIBLING of the
files root, outside the ltree, so nothing ingests. Add a `quarantineRoot`
path helper beside `filesRoot` in `packages/files/src/paths.ts`.

### Lifecycle
1. **Stage** — `POST /api/team/forum/uploads` (multipart, team-authed via
   `resolveTeamChatCaller`): ≤5 files/post, ≤25MB each (reuse
   `MAX_UPLOAD_BYTES`), rate-limited (reuse `forum-post` limiter family),
   counts toward a per-member daily byte budget (~100MB, own limiter).
   Writes blob rows `status='staged'` + bytes to quarantine. Returns
   `[{blobId, filename, mime, size, kind}]` (kind inferred from mime).
2. **Bind** — topic-create / reply POST accepts
   `attachments: [{kind, mime, caption: filename, fileId: blobId}]`; server
   validates each blob is the CALLER'S and `staged`, then binds
   (`post_id` set, `status='pending'`) in the same transaction as the post
   insert (`createForumTopic`/`appendForumPost` already accept attachments).
   Staged blobs older than 24h swept opportunistically on the upload route.
3. **Serve (member)** — `GET /api/team/forum/attachments/[blobId]`: resolve
   caller → load blob → topic visibility via `getForumTopic` → stream with
   `safeDownloadHeaders`. Works pre- and post-review; if `filed`, may stream
   from the file node instead. Post rows stay immutable — the blob row is the
   review state; clients join via `fileId`.
4. **Review (owner)** — Requests tab gains an **Uploads** section: pending
   blobs grouped by topic (title links to the topic view). Per file:
   - **Download** — stream quarantine bytes (owner-authed route).
   - **Move to files** — read quarantine → `upsertFile` into
     `files/review/<topic-slug>/` (folder lazily created via `createFolder`,
     name from topic title sanitized + de-duped) → normal ingestion fires →
     blob `filed` + `node_id` + `reviewed_at`; quarantine bytes deleted.
   - **Dismiss** — blob `dismissed` + `reviewed_at`, bytes deleted.
   Tab badge count includes pending uploads. A post is "reviewed" when it has
   no pending blobs.

### Member UI
Paperclip + multi-file picker on the topic REPLY composer
(`topic-view-client.tsx`) and the NEW TOPIC dialog (`topic-list-client.tsx`).
The /team landing quick box stays attachment-free (decision — keep it quick).
Attachment chips on posts (filename + size, download link, subtle "in
review" badge while pending; failed member posts still render null).

### Decisions locked with Jason (flag before changing)
- Attachments are member-visible/downloadable IMMEDIATELY in topics the
  viewer can see — review gates BRAIN INGESTION + owner triage, not
  member-to-member distribution (a member could paste the same content as
  text). Flip = hold the member serve route until `filed`.
- File types: parity with the owner surface (anything ≤25MB), always served
  with `safeDownloadHeaders`.
- Agent turn v1 sees FILENAMES only (`[attached: report.pdf, 2.1MB]` context
  line in the turn loader) — no vision/document reading yet.
- **Dismiss** action included (queue must be drainable).
- Private topics: uploads allowed; filing moves into the owner-only files
  tree, which is consistent with "visible to you and the brain owner".

### Build order
1. **Plumbing** — migration 0125 + `packages/db/src/schema/forum-uploads.ts`;
   `packages/content/src/forum-uploads.ts` store (stage/bind/list/file/
   dismiss/sweep; PURE helpers — kind-from-mime, topic-slug, name-dedupe — in
   a db-free module with vitest, the forum-search.ts pattern); quarantine
   disk helpers; upload + member-serve routes.
2. **Member UI** — composer attach widgets + chips + badges.
3. **Admin review** — Uploads section in the Requests tab, three actions,
   `Review/<topic>` folder creation, badge count.
4. **Verify** — vitest (pure helpers), typecheck/eslint, detached-FE probes
   (routes 401-not-500, pages compile); full upload→review→move E2E needs a
   member session on dev (same gate as the rest of Part A).

## How to resume
- Repo rules: feature work in a worktree (`scripts/new-worktree.sh`),
  integrator stays on `main`, never `next build` in a worktree, **no Claude
  commit attribution**. `pnpm --filter @mantle/web run typecheck` before
  commit. Detached FE: `pnpm dev:fe --port 3011` (backend = test box).
- Ship path: Part A committed (`ce0ae113`) + changelog ready — remaining:
  push → bump to 0.143.0 → tag (publish only on Jason's word). Part B goes
  in a worktree on top.
- Dev brain (bdcda805 / dev.crossworks.network): session log task `4f39be51`;
  working-memory page `79e7cebc` (commit or discard its editor draft — doc
  and draft are identical after the 07-17 cleanup).
