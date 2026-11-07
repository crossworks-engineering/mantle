# Files: the host-mirrored filesystem

How Mantle stores user-managed files. Companion to
[`architecture.md`](./architecture.md) and [`memory.md`](./memory.md).

Status: **live.** Folder + file CRUD via the web UI, the API, and the
MCP server; markdown editor with preview; extractor picks up text
files automatically. PDFs upload + display but ingestion is wired
behind a parser hook that ships in a follow-up.

A file can be shared read-only via a public link (`/s/[token]`), which serves
its bytes through a token-scoped asset route with a media-appropriate viewer,
see [`sharing.md`](./sharing.md). Pages reuse the same upload/serve pipeline for
embedded image/file nodes.

---

## 1. The shape

Mantle has always had a `nodes` tree (see [`architecture.md` §6](./architecture.md#6-the-nodes-table--mantles-central-abstraction)).
The `files` layer is a slice of that tree where every branch and file
node is also a **real folder or file on disk**.

```
DB (nodes ltree)                       Disk (MANTLE_FILES_ROOT)

files                       ←mirror→   ${ROOT}/
files.work                  ←mirror→   ${ROOT}/work/
files.work.lister-printer   ←mirror→   ${ROOT}/work/lister-printer/
files.work.lister-printer
  +  notes.md (file node)   ←mirror→   ${ROOT}/work/lister-printer/notes.md
```

Anything **not** under `files.*` (e.g. `inbox.email_jason.…`) is
DB-only. The Telegram, email, and digest branches don't touch disk.

---

## 2. Why mirror to disk?

Three reasons:

1. **The user owns the files.** `cat`, `vim`, `cp`, Syncthing, all
   work as expected. Nothing's trapped behind an API.
2. **External edits round-trip cleanly** once a rescan is wired in (not
   built yet, manual import via the UI for now).
3. **Backup is a folder copy.** No special tooling needed.

The tradeoff is that the DB and disk must stay paired. Every write
path funnels through `@mantle/files` so the pairing is atomic per
operation: disk write first (so a failure doesn't leave orphan DB
rows), then DB row. Deletes go the other way (DB first; an orphan
file on disk is recoverable, an orphan DB row pointing at a missing
file isn't).

---

## 3. The package layout

- [`packages/files`](../packages/files), host fs ops + slug helpers
  - the high-level operations (`createFolder`, `upsertFile`,
    `deleteFolder`, `listFiles`, …). Pure logic, no HTTP, no UI.
- [`server/web/lib/files.ts`](../server/web/lib/files.ts), thin re-export
  so the web's API routes can import from `@/lib/files` (convention).
- [`server/web/app/api/files/**`](../server/web/app/api/files/), REST API.
- [`jackdaw/app/(app)/files/`](<../jackdaw/app/(app)/files/>), UI.
- [`server/mcp/src/server.ts`](../server/mcp/src/server.ts), MCP tools.
- [`server/api/src/agent/extractor.ts`](../server/api/src/agent/extractor.ts),
  `readNodeBody` falls back to disk for `type='file'` nodes whose
  `data.content` wasn't cached.

---

## 4. Naming rules

Enforced at the API layer; the UI also runs the same sanitiser as a
client-side hint.

- **Folder slugs**: `[a-z0-9-]+`, 1–64 chars. Anything else is
  normalised by `slugifyFolder`. ltree label form is the slug with
  dashes replaced by underscores (ltree labels are `[A-Za-z0-9_]`).
- **File names**: lowercase, `[a-z0-9_-]` + a single `.ext` suffix,
  max 200 chars. Uploads with mixed-case names are silently
  lowercased. `My Doc.PDF` → `my-doc.pdf`.

**Folders are not renameable.** Renaming a folder would cascade ltree
path updates across every descendant node + reshuffle the on-disk
tree. Skipped for the same reason `branch` paths are unique-indexed,
a rename would either break the index or require a transactional
rewrite of every descendant. Make a new folder + move files instead.

**Files are renameable**, basename only; the extension is preserved.

**A file name is unique per folder, not per brain.** A file node's `slug`
is its filename, and the unique index on it is
`(owner_id, path, slug) where type = 'file'`
(`nodes_file_owner_path_slug_uq`, migrations 0184/0185), the same rule the
disk has. So `church/notes.md` and `church/sermons/notes.md` are two nodes.
Until 0185 the owner-wide `nodes_owner_slug_uq` covered files too, and the
watcher could not create a node for the second one (it stayed on disk,
invisible and unsearchable). Nothing looks a file up by slug: routes, shares
and links use the node id, and the file ops key a file by folder + filename.
Other non-folder node types keep the owner-wide slug rule.

---

## 5. Editable vs binary

`TEXT_EXTS` ∋ `{md, markdown, txt, json, yaml, yml}` are the files the
UI edits in place and the extractor ingests:

- On create/save, the content is written **both** to disk (canonical)
  and cached in `nodes.data.content` (≤ 1 MB) so the responder /
  extractor / editor don't need a disk round-trip.
- The editor offers an Edit / Split / Preview tri-toggle for `.md` and
  `.markdown`; other text formats get edit-only.

Everything else uploads fine, displays metadata, and serves bytes via
the raw download endpoint. The extractor returns the empty body for
binaries, so they fall through the 20-char minimum-body guard and get
skipped silently.

**PDFs are ingestable.** `INGESTABLE_EXTS` ∋ `pdf`, and the extractor's
`readNodeBody` sends `.pdf` files to the parser service
([parser.md](parser.md)), which reads the embedded text layer with
`pdf-parse`. Scanned-image PDFs come back as '' and take the OCR fallback
([file-ingestion.md](file-ingestion.md)). Encrypted or corrupt PDFs are
the parser's `failed`, and the extractor falls back to the node title.

---

## 6. Configuring `MANTLE_FILES_ROOT`

- **Dev default**: `./data/files` (gitignored). `pnpm dev` writes
  there directly.
- **Docker compose**: `mantle_files_data` volume mounted to
  `/data/files` in the `web` and `agent` containers, exposed via
  `MANTLE_FILES_ROOT: /data/files` on the shared env block.
- **Prod**: override via env. Mount whatever host directory you want
  to back up (Syncthing target, NAS mount, etc.).

The runtime resolves the env var to an absolute path on startup; the
files root directory is auto-created on first folder access via
`ensureFilesRootBranch` + `ensureRoot`.

---

## 7. Write paths

All three converge on the same `@mantle/files` ops:

| Surface | Folder create             | Folder describe                 | File upload                                        | File edit                     | Delete                          |
| ------- | ------------------------- | ------------------------------- | -------------------------------------------------- | ----------------------------- | ------------------------------- |
| UI      | New folder button         | Inline edit on header           | Drag-drop + Upload + New \*                        | Editor save                   | Toolbar buttons                 |
| REST    | `POST /api/files/folders` | `PATCH /api/files/folders/[id]` | `POST /api/files/files` (multipart or JSON)        | `PATCH /api/files/files/[id]` | `DELETE …`                      |
| MCP     | `folder_create`           | `folder_describe`               | `file_upload` (`content_text` or `content_base64`) | `file_upload(overwrite=true)` | `folder_delete` · `file_delete` |

A folder's PATCH also takes `{ look: { icon?, color? } }`: its face in the
Files tree, in the same vocabulary as an app's (an emoji or `lucide:<name>`,
and a tint key from `APP_TINTS`). Stored on `data.icon` / `data.color`; null
clears either back to the default folder tile.

---

## 8. Ingestion handoff

Every new `nodes` row of `type IN (note, file, …)` fires
`pg_notify('node_ingested', new.id::text)` via the trigger in
migration 0018. The extractor agent's listener calls `extractNode(id)`,
which:

1. Resolves the active extractor agent + checks the node's type is in
   `memory_config.extract_types` (default `['note', 'file']`).
2. Reads the body via `readNodeBody`. For files, it tries
   `data.content` first (the cached copy for editable text); if absent,
   falls back to reading the on-disk file by `INGESTABLE_EXTS`
   extension allowlist.
3. Skips silently when the body is too short (< 20 chars), that's
   how binaries fall through.
4. Runs the summary + facts + entities pipeline as for any other node.

Set `agent.memory_config.extract_cost_cap_micro_usd` on the extractor
to bound spend per file (gap #1 from the previous round).

### 8a. Metadata-only indexing — store it, share it, don't embed it

Some files belong in the workspace for its plumbing and not in the brain: a
photo gallery, temp files, the transcriber's audio clips. For those, flip
`indexing` to `metadata` on the file or any ancestor folder:

- The file stays fully stored, shareable, renameable — nothing about storage
  changes.
- It keeps a searchable **spine**: a deterministic summary + embedding built
  from its name, type, folder path and tags (`metadataSpineText` in
  `packages/files/src/indexing.ts`). "Find my December photos" still works.
- Its **content is never read**: no passages (`content_chunks`), no entity or
  fact extraction, no content-derived summary. `search_chunks` will not see
  inside it, and the spine says so in as many words, so an agent quoting it
  never presents a name-only index as if it had read the file.

The flag is `data.indexing: 'full' | 'metadata'` on file and folder nodes;
absent means inherit. Effective mode = own flag → nearest ancestor folder's
flag → `full`, resolved at **extract time**, so moving files or re-flagging
folders needs no stored denormalisation. `data.indexing_applied` records which
mode the extractor last ran, and is what listings badge.

Toggling has teeth in both directions:

- **full → metadata** reaps the file's existing `content_chunks` and replaces
  summary + embedding with the spine. No LLM call — flipping a thousand-file
  gallery costs local embeddings only.
- **metadata → full** clears the completion marker and re-queues real
  extraction through the ordinary pg-boss pipeline, one job per file, never a
  burst loop. This is real LLM spend in proportion to the file count — which
  is exactly what turning content indexing ON means.
- Flipping a flag to the value a file is already indexed under queues nothing.

Surfaces: `file_set_indexing` / `folder_set_indexing` (builtin tools, `files`
group), `indexing` param on the MCP `file_upload` / `folder_create`, and
`PATCH {indexing}` on the file/folder API routes. Known limit: facts extracted
BEFORE a flip to metadata stay in the graph until curation touches them — the
flip stops future extraction and removes passages, it does not rewrite fact
history.

### 8b. Move and copy

`moveFileById` / `moveFolderById` / `copyFileById` / `copyFolderById`
(`packages/files/src/move-copy.ts`) — the operations the two-pane manager
stands on. The invariants:

- **Disk and DB never diverge**: disk first (atomic rename within the tree),
  DB in a transaction, disk rolled back if the DB write fails — the
  `renameFolderById` discipline; folder moves reuse its ltree `CASE` rewrite.
- **A move follows the indexing rules of where it lands** (§8a): after every
  move, `reconcileFilesIndexing` re-queues any file whose effective mode
  changed — moving into a name-only gallery sheds the content index, moving
  out regains it.
- **A copy is a new file**: fresh node, fresh bytes, fresh extraction under
  the destination's mode. Nothing links to the original.
- **Folder copies cap at 200 files** and refuse loudly with the count —
  every copy re-extracts, so a big copy is a spend decision, not a default.
  Flagging the destination name-only first makes the whole copy LLM-free.

Surfaces: `file_move` / `file_copy` / `folder_move` / `folder_copy` builtins
(`files` group); `PATCH {move}` and `POST {copy_to}` on the file/folder API
routes; the two-pane view in the client.

---

## 9. MCP tools

Wired in [`server/mcp/src/server.ts`](../server/mcp/src/server.ts):

| Tool              | Purpose                                                      |
| ----------------- | ------------------------------------------------------------ |
| `folder_list`     | Children of a folder, or the whole tree                      |
| `folder_create`   | Create folder + on-disk dir, optional description            |
| `folder_describe` | Set/clear folder description                                 |
| `folder_delete`   | Delete an empty folder (root cannot be deleted)              |
| `file_list`       | Files in a folder                                            |
| `file_upload`     | Create/overwrite a file (`content_text` or `content_base64`) |
| `file_get`        | File metadata only                                           |
| `file_read`       | File metadata + bytes (utf-8 for text, base64 for binary)    |
| `file_delete`     | Delete a file (both DB row and disk)                         |
| `screenshots`     | The area screenshots it reads: a list, or one with its image |

Same auth model as the other MCP tools; every query is scoped to
`OWNER_ID = process.env.ALLOWED_USER_ID`.

### Screenshots

Every signed-in login (a member too) can drag a rectangle over the app and
save it as a PNG, as if it had taken the picture to Files and uploaded it:
`POST /api/screenshots` (`server/web/app/api/screenshots/route.ts`),
multipart with `file` (the PNG, refused unless both its declared type and
its bytes say PNG, the signature and the IHDR header; at most 10 MB, 413
above; at most 16384 pixels a side and 64 megapixels by its IHDR header,
413 above, since a PNG of one colour holds a huge picture in a few bytes;
an empty file 400) and `meta`, a JSON string checked against an allowlist
(`server/web/lib/screenshot-meta.ts`: `route`, `screen`, `itemId`,
`itemTitle`, `workspaceId`, `capturedAt`, `viewport`, `dpr`, `rect`,
`appVersion`, `shell`, `note`; unknown keys dropped, every string capped;
bad meta is a 400; a lone UTF-16 surrogate is replaced by U+FFFD and a NUL
removed, since Postgres refuses both in jsonb; a meta nested deeper than 32
is refused before it is parsed). The body is held to the file cap plus the
multipart framing (11 MB, `MULTIPART_CEILINGS` in
`server/web/lib/body-limit.ts`), a chunked body that declares no length
too, and each login may save 20 a minute (`screenshots`,
`server/web/lib/route-limits.ts`; an Admin user's count too).

It lands where that login's own upload to Files lands
(`saveScreenshotFile`, `packages/files/src/screenshots.ts`): a plain file at
the top of Files, in the create home a new item takes there, the workspace
the login is in (`?ws=`, the workspace switcher's, which the client sends as
every create does), else its own create home (a member's private
workspace; an Admin user's, the Files root's). It has that workspace's
rights and no other: everyone who reads the workspace reads it, nobody else
does, and it is no login's private row (no `login_id`). The upload's
visibility guard runs as for a new file there (never confirmed from here).
It is named `screenshot-<yyyy-mm-dd-hhmmss>.png` (UTC; the next free name
when taken, the top of Files being one folder for every workspace), tagged
`screenshot`, its metadata in `data.screenshot` (`capturedAt` the server's
time when the client sent none), and recorded in Activity (ingest source
`screenshot`). The reply is 201
`{ file: { id, filename, sizeBytes, mimeType }, landedIn }`. The client may
then attach it to an assistant chat by its file id. The meta is what the
client said (advisory): nothing trusts `itemId`, `workspaceId` or
`capturedAt` for rights. The brain's image model reads the picture, as it
reads any uploaded image, to make it searchable. The extractor's version
pass leaves a screenshot alone: one is never a version of another.

External agents read them with the MCP tool `screenshots`
(`packages/mcp-core/src/mcp-defs.ts`), a read in the Files key area (a key
without Files does not have it) and peer-risky (an API key or a linked
brain has it only when the owner named it on it; a login's own OAuth
connection has it): with no `id`, the newest first (`limit`, default 10, at
most 50) with `id`, `filename`, `capturedAt`, `route`, `screen`,
`itemTitle`, `note` and `sizeBytes`; with `id`, that one's metadata and the
picture as an MCP image block (refused above 5 MB, or when it is no
screenshot). Every read is in the calling login's scope (row security, as
file_list): the screenshots of the workspaces it reads. In-app agents have
no tool of their own for it: `extract_from_image` reads any image file.

### Per-login files

A file sent in a login's chat or over its Telegram carries that login
(`nodes.login_id`): only that login reads it, as its chat. Row security
holds it there, and the reads that run on the system pool say it
themselves:

- a linked peer brain never reads one by any grant (`peerPerLoginRow`,
  docs/federation.md), and no login may share one with it;
- the extractor feeds no entity or relation from one (`feedsEntityGraph`,
  `server/api/src/agent/extract/rules.ts`), since those are read across the
  Admin scope; its version pass groups a file only with files of its own
  login and home workspace (`supersede.ts`); its fact pass compares a new
  fact only with the facts readable in the node's own scope and changes
  only a fact of its own login that no workspace outside its own reads
  (`facts.ts`);
- the settings area's diagnostics (`/api/debug/*`: the landed view and its
  delete, facts, digests and topics, the context turns, the overview with
  its failures and errors, the dashboard's, the tool-validation telemetry,
  and the corpus audit's samples) show a per-login row (`nodes`, `facts`,
  `traces` or `assistant_messages` with `login_id` set) only to that login
  (`server/web/lib/login-rows.ts`); the dashboard's few-second cache is per
  login;
- a sandbox mount (`sandbox_create`'s `inbox_folder_id`) shows its folder's
  whole directory, so it is refused over a folder holding a file private to
  another login, at the create and again before every call that runs in the
  sandbox (docs/sandboxes.md).

---

## 10. External-edit watcher

A separate worker (`server/web/workers/files-watch.ts`, runs as the
`files` lane in `pnpm dev`) uses [chokidar](https://github.com/paulmillr/chokidar)
to observe `MANTLE_FILES_ROOT` and reflect off-Mantle disk changes back
into the DB. So if you `vim` a markdown file on the host, or Syncthing
drops a new PDF into the folder, the row updates without any UI action.

**Three events**:

| chokidar event | What the watcher does                                                      |
| -------------- | -------------------------------------------------------------------------- |
| `add`          | `syncFileFromDisk`, insert a `file` node (or no-op if same sha256).        |
| `change`       | `syncFileFromDisk`, update node, clear embedding, re-fire `node_ingested`. |
| `unlink`       | `deleteFileByPath`, drop the DB row.                                       |

**Loop prevention** is built in: `syncFileFromDisk` only ever reads the
disk, never writes back. So when the UI uploads a file, it updates the
DB row first (with the new sha256), then chokidar reports the change,
the watcher recomputes the same sha256, sees it matches, and no-ops.
No echo, no convergence races.

**What's ignored**: dotfiles, `~`-suffixed backups, `.swp` / `.swx` /
`.tmp` editor temps, plus anything whose extension isn't in the
watched set (TEXT_EXTS + ingestable + common image / csv / html
formats). `awaitWriteFinish` with a 400ms stability threshold means
multi-chunk editor writes don't get read half-saved.

**What's NOT done**: the watcher doesn't track folder add / unlink
events; lazy `ensureBranchChain` inside `syncFileFromDisk` creates any
missing branch nodes when a file lands under a new directory. Empty
folders left on disk are harmless. Folder renames at the OS level
will show up as a delete-all + re-add storm; the UI is still the
recommended path for renames.

---

## 11. Known sharp edges

- **No file move.** Move = delete + reupload. Adds folder-cascade
  complexity disproportionate to the value at this scale.
- **No file versioning.** Edits overwrite; the old content is gone.
  Git the folder if you care.
- **Scanned PDFs return empty text.** No OCR; they fall through the
  20-char guard and get skipped.
- **Concurrent writes**: two simultaneous saves on the same file
  race at the disk layer. Single-user system, fine for now.

## Upload limits

Two caps, because there are two transports (`packages/files/src/limits.ts`):

| path                                                           | cap                                           | why                                                                                                                                                                                             |
| -------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/files/files` multipart (the web uploader)           | **512 MB** by default, `MANTLE_MAX_UPLOAD_MB` | Streamed. The body spools to disk as it arrives (`spoolUpload`, hashed and counted per chunk), then is adopted into the folder by rename. Memory stays flat; the cap is a disk/patience number. |
| MCP `file_upload`, chat attachments, forum uploads, Drive sync | **64 MB**, fixed (`MAX_UPLOAD_BYTES`)         | Buffered. The whole file sits in memory (base64 inflates 4/3 on the wire) and Office formats are read in the parser container ([parser.md](parser.md)).                                         |

The reverse proxy has its own ceiling, `MANTLE_MAX_BODY_SIZE` (default `1GB`,
Caddyfile `request_body max_size`). It must stay above the streamed cap plus
multipart framing; raise both together. The app refuses an oversized file
itself: on the declared `Content-Length` before reading a byte where the client
sends one, otherwise at the cap mid-stream, either way with HTTP 413 and the
limit in the body (`maxUploadBytes`). `/api/shell` carries the same number so a
client can refuse the file before sending anything.

Half-written spool files (`<files root>/.upload-spool/*.part`) are residue from
a process that died mid-upload; the route sweeps anything older than two hours
on each upload, and the disk-sync watcher ignores dot-prefixed paths so a
`.part` never becomes a node.

History: the 100 MB proxy cap and the 64 MB buffered cap were the walls a
250 MB SQL Server backup hit on 2026-09-02, spinning for half an hour with no
error and no progress because the buffered route could only answer after the
last byte.
