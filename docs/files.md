# Files — the host-mirrored filesystem

How Mantle stores user-managed files. Companion to
[`architecture.md`](./architecture.md) and [`memory.md`](./memory.md).

Status: **live.** Folder + file CRUD via the web UI, the API, and the
MCP server; markdown editor with preview; extractor picks up text
files automatically. PDFs upload + display but ingestion is wired
behind a parser hook that ships in a follow-up.

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

1. **The user owns the files.** `cat`, `vim`, `cp`, Syncthing — all
   work as expected. Nothing's trapped behind an API.
2. **External edits round-trip cleanly** once a rescan is wired in (not
   built yet — manual import via the UI for now).
3. **Backup is a folder copy.** No special tooling needed.

The tradeoff is that the DB and disk must stay paired. Every write
path funnels through `@mantle/files` so the pairing is atomic per
operation: disk write first (so a failure doesn't leave orphan DB
rows), then DB row. Deletes go the other way (DB first; an orphan
file on disk is recoverable, an orphan DB row pointing at a missing
file isn't).

---

## 3. The package layout

- [`packages/files`](../packages/files) — host fs ops + slug helpers
  + the high-level operations (`createFolder`, `upsertFile`,
  `deleteFolder`, `listFiles`, …). Pure logic, no HTTP, no UI.
- [`apps/web/lib/files.ts`](../apps/web/lib/files.ts) — thin re-export
  so the web's API routes can import from `@/lib/files` (convention).
- [`apps/web/app/api/files/**`](../apps/web/app/api/files/) — REST API.
- [`apps/web/app/(app)/files/`](../apps/web/app/(app)/files/) — UI.
- [`apps/mcp/src/server.ts`](../apps/mcp/src/server.ts) — MCP tools.
- [`apps/agent/src/extractor.ts`](../apps/agent/src/extractor.ts) —
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
tree. Skipped for the same reason `branch` paths are unique-indexed —
a rename would either break the index or require a transactional
rewrite of every descendant. Make a new folder + move files instead.

**Files are renameable**, basename only — the extension is preserved.

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
`readNodeBody` routes `.pdf` files through `@mantle/files/pdf`, a thin
wrapper around `pdf-parse` that returns the embedded text layer.
Scanned-image PDFs come back as '' (no OCR) and fall through the
20-char guard. Encrypted / corrupt PDFs throw and the extractor swallows
the error, falling back to the node title.

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

| Surface | Folder create | Folder describe | File upload | File edit | Delete |
|---|---|---|---|---|---|
| UI | New folder button | Inline edit on header | Drag-drop + Upload + New \* | Editor save | Toolbar buttons |
| REST | `POST /api/files/folders` | `PATCH /api/files/folders/[id]` | `POST /api/files/files` (multipart or JSON) | `PATCH /api/files/files/[id]` | `DELETE …` |
| MCP | `folder_create` | `folder_describe` | `file_upload` (`content_text` or `content_base64`) | `file_upload(overwrite=true)` | `folder_delete` · `file_delete` |

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
3. Skips silently when the body is too short (< 20 chars) — that's
   how binaries fall through.
4. Runs the summary + facts + entities pipeline as for any other node.

Set `agent.memory_config.extract_cost_cap_micro_usd` on the extractor
to bound spend per file (gap #1 from the previous round).

---

## 9. MCP tools

Wired in [`apps/mcp/src/server.ts`](../apps/mcp/src/server.ts):

| Tool | Purpose |
|---|---|
| `folder_list` | Children of a folder, or the whole tree |
| `folder_create` | Create folder + on-disk dir, optional description |
| `folder_describe` | Set/clear folder description |
| `folder_delete` | Delete an empty folder (root cannot be deleted) |
| `file_list` | Files in a folder |
| `file_upload` | Create/overwrite a file (`content_text` or `content_base64`) |
| `file_get` | File metadata only |
| `file_read` | File metadata + bytes (utf-8 for text, base64 for binary) |
| `file_delete` | Delete a file (both DB row and disk) |

Same auth model as the other MCP tools — every query is scoped to
`OWNER_ID = process.env.ALLOWED_USER_ID`.

---

## 10. External-edit watcher

A separate worker (`apps/web/workers/files-watch.ts`, runs as the
`files` lane in `pnpm dev`) uses [chokidar](https://github.com/paulmillr/chokidar)
to observe `MANTLE_FILES_ROOT` and reflect off-Mantle disk changes back
into the DB. So if you `vim` a markdown file on the host, or Syncthing
drops a new PDF into the folder, the row updates without any UI action.

**Three events**:

| chokidar event | What the watcher does                                         |
|----------------|---------------------------------------------------------------|
| `add`          | `syncFileFromDisk` — insert a `file` node (or no-op if same sha256). |
| `change`       | `syncFileFromDisk` — update node, clear embedding, re-fire `node_ingested`. |
| `unlink`       | `deleteFileByPath` — drop the DB row.                         |

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
- **Scanned PDFs return empty text.** No OCR — they fall through the
  20-char guard and get skipped.
- **Concurrent writes**: two simultaneous saves on the same file
  race at the disk layer. Single-user system, fine for now.
