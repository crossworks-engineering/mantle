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
mode the extractor last ran. It is the MODE, stamped before the read: it is
not whether the read worked.

**Was the content read?** Every file row (`file_get`, `file_list`, the Files
routes) and `node_read` of a file carry `extraction`
(`packages/files/src/extraction-status.ts`), derived live from keys the
extractor already writes, so there is no new state:

| `state`     | When                                                                                                                                                             | Also                                                                               |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `indexed`   | the read ended (`extract_completed_at`)                                                                                                                          | `reason: local_only` for a file read with no model (no assistant in its workspace) |
| `partial`   | read in part (see "Read in part" below): a reader's cut (`data.read_cut`), a scan's `data.ocr = { pages_read, pages_total }`, or pictures kept below those found | `cuts`, `hint`; `pages`, `pictures`                                                |
| `failed`    | a terminal skip that is a read failure (`READ_FAILURE_SKIPS`: `document_unreadable`, `pdf_too_large`, `encrypted_pdf`, `bytes_unavailable`), or a parked write   | `reason`, `hint`                                                                   |
| `skipped`   | any other terminal skip (nothing to read: `body_too_short`, `no_parser`, ...)                                                                                    | `reason`, `hint`                                                                   |
| `pending`   | not read yet: queued, retrying, or waiting for the model provider (`FileStatus.job` `waiting`)                                                                   |                                                                                    |
| `name_only` | the indexing mode is name only                                                                                                                                   |                                                                                    |

`file_list` with `extraction: 'failed'` (or another state) lists the files in
that state in every folder, or under `parent_path`, newest first; the route
is `GET /api/files/files?extraction=failed[&under=]`. A new read failure
sends the box admins' devices a push that opens Files' Not read list
(`/files?unread=1`): the extractor notifies `file_read_failed`
(`FILE_READ_FAILED_CHANNEL`), and the push worker sends at most one in 30
minutes (`pushReadFailed`). A read in part sends its own push (below).

#### Read in part

The owner's rule (2026-11-19): everything uploaded is
consumed in full. Until each cap is gone, a cut is never silent: every reader
that takes only part of an input says so, one shape for every input type
(`packages/files/src/read-cut.ts`). A node keeps them in `data.read_cut`,
one entry per kind of cut by its key:

```json
{ "sheet_rows": { "what": "rows", "read": 5000, "total": 12000, "limit": 5000 } }
```

`read` of `total` (`atLeast`: the total is a lower bound) in the unit `what`,
and the cap (`limit`). A file with any entry is `partial`, and
`extraction.cuts` lists each with its sentence (the `hint` is them all):
"5,000 of 12,000 rows are in its text ...", "64 of 120 sheets ...". The
scan's pages and the pictures left out (`data.images`, by part) are entries
of the same list, said first (`ocr_pages`; `scan_pages`, a scanned drawing's
pages its sketch read did not read; `pictures`, the embedded part;
`page_pictures`, a book's pages left to vision with no page picture yet,
G1), so there is one model.

How a cut reaches the node: a reader calls `noteReadCut` in the sink of the
read (`read-cut-sink.ts`, async-local). The extractor opens one per node and
writes what was said with the stamp that ends the read (`read-cut-stamp.ts`:
merged onto the node's own, a key said again replacing its entry, so a read
from the stored text keeps the cuts of the read that made it). A parser job
opens its own and sends `cuts` with its answer, which the parser client says
again in the caller's sink; a Reader pipeline's write carries `readCuts`
(the step check checks them, the core says them where it takes the text).
`read_cut` is a byte key (migration 0387): new bytes drop it; a reindex or
an OCR rescan drops it too, unless it holds a cut the next read does not say
again (an Agent's, kept with that Agent's text; the picture gate's, as the
picture pass skips pictures it has) or the file is sketched (kept with its
text). Then the map stays
whole: a reindex runs in the caller's scope, where the edit check lets a write
clear a key only the brain sets, never change it. The next read says its
cuts again, each key replacing its entry.

Two cuts are details only (the owner's call, 2026-11-19): `pictures_small`
and `pictures_tiny`, icons, bullets and small logos the size gate skipped.
They stay in a file's `cuts` with their sentence (file_get, node_read), but
alone they leave the file `indexed`, never count for the partial filter of
file_list or the stale list, and push nothing; a partial file's hint leaves
them out. Every other cut makes the file `partial`
(`DETAIL_ONLY_CUT_REASONS` in `read-cut.ts`, the SQL form
`readCutMakesPartialSql`).

The cuts said today, each with its key:

| Key                                                                                                                      | Where                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text_store`                                                                                                             | the stored text past 1,000,000 characters (file_read reads it; search passages cover all)                                                                                                               |
| `sheet_rows`, `sheet_columns`, `sheet_text`                                                                              | a workbook's text: 5,000 rows and 256 columns a sheet, 1,000,000 characters a workbook (`xlsx.ts`)                                                                                                      |
| `legacy_cells`                                                                                                           | `.xls`/`.xlsb` sheets past 1,000,000 cells (`read-document.ts`)                                                                                                                                         |
| `database_size`                                                                                                          | a file database read past `MANTLE_FILE_DB_CSV_MAX_MB` of cell text: the first rows go in, the rest are counted (the `sheet` Reader)                                                                     |
| `database_rows`                                                                                                          | sheets past `TABLE_IMPORT_MAX_ROWS`: the first rows go in (the `sheet` Reader, `writeRowsOrWord`); a cut read makes no Table                                                                            |
| `markup_bytes`                                                                                                           | HTML and XML whose text passes 32 M characters (`markup.ts`; the bytes are read in 32 MB windows)                                                                                                       |
| `cad_texts`, `cad_text_length`, `cad_layers`, `cad_blocks_cap`, `cad_geometry`, `cad_labels`, `cad_blocks`, `layer_list` | DWG/DXF/DGN: the CAD tier's 20,000 texts, 512 characters a text (and a DGN's attribute values), 1,000 layers, 20,000 blocks, the geometry lists' budgets, and the digest's budgets                      |
| `dwf_sheets`, `dwf_scan`, `dwf_labels`, `layer_list`                                                                     | DWF: 64 sheets, a stream past 16 MB or past a sheet's layer or label cap, the digest's label and layer budgets                                                                                          |
| `agent_text:<id>`                                                                                                        | an Agent's text past 64,000 characters (`agent-text.ts`; file_sql reads every row)                                                                                                                      |
| `vision_answer`                                                                                                          | a vision or document answer that used its whole token budget (where the provider counts the tokens)                                                                                                     |
| `pictures_small`, `pictures_metafile`, `pictures_unreadable`, `pictures_tiny`                                            | pictures the gate left out (`embedded-images.ts`, said by the picture pass once its read is whole; a duplicate is no cut). The cap and the parser's answer budget are `data.images` (`{ kept, found }`) |
| `pictures_large`                                                                                                         | Visio pictures past 32 MB, or past 256 MB a drawing (`vsdx.ts`)                                                                                                                                         |
| `description`                                                                                                            | a calendar event posted with `descriptionChars` past the description it holds (POST /api/sidecar/events, on the event node)                                                                             |

A calendar feed's own cuts (a series past 50,000 occurrences before the
horizon, an event past 16 MB of text, a description past 20,000
characters, a feed that ended early) are on the feed's status in the Sync
sidecar (`feeds.ts`, the status `note`), as the feed has no node.

`file_list` with `extraction: 'partial'` lists the files read in part;
`node_read` of another item read in part (an event) carries its `cuts`. A
read that ends with a cut notifies `file_read_partial`
(`FILE_READ_PARTIAL_CHANNEL`), and the push worker sends the box admins'
devices one notice in 30 minutes (`pushReadPartial`, opening
`/files?partial=1`), as for a failure.

A verdict holds while its key is there: new bytes drop it (it is a byte
key) and a good read removes it. A rename or a move keeps it, as they read
nothing. Known gap: the scanned-drawing read (`pdf-sketch.ts`) reads 10
pages too and still writes `ocr: true`, so a longer drawing set shows
`indexed`.

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

### 8c. Status and processing

What the brain did with a file, derived live (nothing new is stored):

- **Status** (`FileStatus`, `@mantle/client-types` `dto/file-status`): a
  compact `status` on every file row of `GET /api/files/files` (a folder,
  Recent, by read state), on `GET /api/files/files/:id`, and on a file's
  `TreeItem`. `ingest` (`done`, `partial`, `waiting`, `failed`, `none`)
  comes from the one read rule (`extractionOf`); `job` (`queued`,
  `running`, `waiting`) is an extract job in the queue now, ONE read of
  pg-boss for the whole list (`extractJobsFor`). `waiting`: the job is held
  by the model provider's "not now" (a rate limit, no credit, busy) or, for
  an Agent's run, by the day cap of paid asks, and is sent again by itself
  (docs/provider-http.md, "When the provider refuses for now"); the
  processing answer's `wait` (`for`, `reason`, `run`, `until`, `hint`) says
  why and until when (`extractJobWaitOf`); `db` is the state of the file's own
  database, for a file with a Data view, from ONE read of the folder of
  databases (a `.none` is opened for its word; no size on a row).
  `packages/files/src/file-status.ts` maps it; `withFileStatus`
  (`file-db-list.ts`) fills a list.
- **Processing** (`FileProcessing`): `GET /api/files/files/:id/processing`
  and the `file_processing` tool, one answer (`fileProcessing` in
  `@mantle/tools`): size, pages, whether it was embedded, the counts of
  chunks, facts and mentions, its database (state, size, the pipeline that
  read it and its tabs with their rows), the queue, the last error, and the
  items made from it (`data.sourceFileId`: extracted images, auto Tables,
  pages and notes). Its gate is the file's own: a file the caller does not
  read is a 404, and every count is read in the caller's scope. Facts and
  items are the current ones (a replaced fact or a superseded item is not
  counted). `mentions` is null outside an Admin scope (entity edges are
  read there only). A key limited to some areas sees the items of those
  areas only, and an app no Table (`derivedReachSql`).
- **Coverage** (the whole box, by file type): how fully each type is
  read, in numbers only (`server/web/lib/integrity/file-coverage.ts`). Per
  type: the files in each read state, the files with a file database where
  the type's Reader makes one, the files with a shortcut cut, and the files
  not read in full. A file is not read in full when its read failed, it was
  skipped for a reason other than an empty body, no reader takes its type
  (the default text; an archive is read as what it is, by design, so it is
  no shortfall), it holds a shortcut cut (a reader that read only the
  first part: `SHORTCUT_CUT_REASONS`; a safety cut such as `text_store` is
  counted but is no shortfall), or its type's Reader makes a database and
  its bytes have none (not a PDF, not a type a Reader takes only some files
  of). A file not read yet or indexed by name is counted, never "not full".
  Two ways in, one function: the corpus audit's line `file_coverage` (the
  popular types, the five with the most files not full) and
  `pnpm -C server/web files:coverage [--json]` (every type, with skip
  reasons and cuts by reason). Read only: one SELECT in a READ ONLY
  transaction, the listing of the database folder, and the one-word first
  line of the `.none` names of its files (a word of `unreadable` is no
  database). It prints types and
  counts, never a file name or text, so its numbers may leave a client box.

### 8d. Reindex and stale indexes

A file says what read it, so a better reader shows which files it would
read better, and a person reads them again. Nothing reads a file again by
itself (cost safety: no trigger, no timer).

- **The stamps** (`packages/files/src/read-stamp.ts`), on the file node's
  data, written by the brain only (derived keys, migration 0385):
  `read_by` `{ reader, v }` when a read of the text completes (the extract,
  and the local read with no model: `server/api/src/agent/extractor.ts`,
  `extract/gates.ts`); `reader` is the core reader of the type (the parser
  route: `pdf-parse`, `mammoth`, `exceljs`, `utf8`, ..., or `image` for a
  picture read by vision). `pipeline_read` `{ id, name, version }` when a
  Reader pipeline builds the file's database
  (`packages/content/src/file-database.ts`). New bytes drop both; the next
  read writes them again.
- **Versions.** `READER_VERSIONS` in `read-stamp.ts` is the one list of the
  core readers' versions (each starts at 1). Raise a number when a reader
  reads better: the files it read at a lower number become stale. A
  pipeline's version is its manifest's; an installed newer version makes
  the files its older version read stale. Never lower a number.
- **Stale** (`staleOf`): a stamp below the version in force. A file with no
  stamp (read before the stamps, or not read) is NOT stale, so a roll paints
  nothing stale. A pipeline's stamp decides nothing for a file homed in a
  workspace where that pipeline is off (no Reader run would follow a
  reindex there): the lists pass the off lists (`fileStatusPipelines` in
  `@mantle/content`). The row status carries `stale: true` (only when true) and
  `pipeline` (the name of the Reader pipeline that built its database);
  the row carries the stamps as `readBy` and `pipelineRead`. The processing
  answer has `stale` (true, false, or null for no stamp), `readBy` and
  `pipelineRead`, each with the version in force (`current`).
- **Reindex**: `POST /api/files/reindex` `{ ids }` (1 to 200 file ids) and
  the `file_reindex` tool, one function (`reindexFiles` in `@mantle/tools`).
  The tool is `mcpOnly` and `peerRisky`, as `pipeline_run`: a member runs it
  by hand or from their own MCP connection (a key or peer must have it
  named), and no tool group of an in-brain agent holds it.
  Each file is read again through the whole pipeline on the existing extract
  queue, under its caps. First the bytes of each are looked for (one small
  read): a file whose bytes could not be read now (gone, or the object
  store unreachable) keeps everything it has and is skipped
  `bytes-missing`. Then the keys the extractor derived from the
  bytes are dropped (the cached text, the summary, the reader's stamp, a
  skip or parked verdict) and `markContentChanged` asks for the whole pass
  (text, chunks, vector, facts, mentions). A scanned drawing whose database
  holds its sketch read (`Vision read`) keeps that read's text (`text`,
  `ocr`, `vision_model`): the read is paid for and runs one time for its
  bytes, so the pass chunks, embeds and reads facts from the kept text, and
  no whole-page OCR is paid on top. But for one whose sketch read left scan
  pages not read (`Scan pages not read` above 0): it drops its text as any
  file, so the sketch read is due again and reads the pages left, using the
  answers it kept (docs/file-ingestion.md, 3b). A PDF (the extension or the mimeType)
  whose database is there but whose File tab cannot be read now keeps it
  too (fail closed). So a sketch-read file keeps its text through a reader
  version bump: a reindex re-chunks and re-embeds it but does not re-read
  its text layer. The old chunks and facts stay
  until the new pass replaces them. A file with a database (or a word) for
  its bytes also gets one run of the box's Reader of its type, unless the
  Reader is off in its home workspace. The Reader asks no model; the
  `after` chain that follows it may ask one, as at upload, within the box's
  day cap. A file with none gets its database from the extract, as at
  upload. Two checks: the edit of each file (`itemWriteVerdicts`: whoever
  may change the file by hand), and the busy check of the queue (more than
  50 waiting: nothing is queued). The answer `{ queued, databases, skipped }`
  names every id not queued with its reason: `not-found`, `not-allowed`,
  `in-queue`, `busy`, `bytes-missing`. More than 200 ids is a 400 and
  queues nothing: send the rest in another call. A queue that cannot be
  read (`ReindexQueueUnreadError`) is a 503 in plain words, with nothing
  queued or dropped.
- **The list**: `GET /api/files/stale?state=stale|failed|partial&cursor=&limit=`
  and the `file_stale_list` tool (`fileStaleList` in `@mantle/tools`): one
  page of file rows with their status, newest first, in the caller's read
  scope, `next` for the next page and `total` (the page and the total use
  one predicate, so they agree). `failed` and `partial` are the read states
  of `extractionOf`. The stale cut is found in two partial
  indexes (migration 0385), not by a pass over every file's data.
- **MCP `file_list`** rows carry `status` too, as the HTTP list.

### 8e. Archives

An archive is an archive (the owner, 2026-11-19): a ZIP, TAR, gzip, 7z or
RAR upload is stored as it is and never unpacked or read on upload. Its
text is its name, type, size and entry names (`default-text.ts`,
docs/parser.md "A file no reader takes"; names only, at most 500), so it is
found by meaning search as what it is. Its status says so honestly: the
read stamps a detail cut `archive` (ZIP, TAR, gzip: `{ what: 'entries',
read: 0, total }`) or `archive_sealed` (7z, RAR), so the file is `indexed`
with `reason: 'archive'` and the sentence "its N entries are not read, only
their names are in search. Extract its contents to read them as files." A
detail cut never makes a file `partial` (`DETAIL_ONLY_CUT_REASONS`), so an
archive is never in the `partial` list just for being one.

**Extract contents.** Only a person asks, by hand or through an agent or
MCP client acting for them; no trigger, timer or sweep starts one:

- `POST /api/files/files/:id/extract` (body `{}` or none) and the tool
  `file_extract_archive { file_id }` (agents hold it through the `files`
  group; MCP too), one function (`extractArchive` in `@mantle/tools`,
  `startArchiveExtract` in `@mantle/files archive-extract.ts`).
  `GET /api/files/files/:id/extract` and the tool with `check: true` read
  the state and start nothing. The answer is an `ArchiveExtractAnswer`
  (`@mantle/client-types`): `extractable` (and `why` when not) and
  `extract`, the last extraction (`queued`, `running` with the files so far,
  `done`, `failed`), its folder, `files`, `folders`, `bytes`, `skipped`,
  `flattened`, the first 100 entries `refused` with their reason, and
  `refusedCount`.
- **Checks, in the caller's scope, before anything is written:** the file
  is one the caller reads (else 404), the caller may change it (the edit
  right, as a reindex asks; else 403), its name AND its first bytes say ZIP,
  TAR or gzip (`.zip`, `.tar`, `.tar.gz`, `.tgz`, `.gz`; a `.docx` is a ZIP
  and a document: 400; 7z and RAR: 400, no free reader runs here), no
  extraction of it is under way (409), and there is room for a folder
  beside it (an archive in a folder three levels deep: 400, move it up).
- **Where the files land:** a new folder beside the archive, named after it
  without its archive ending (`Report 2026.tar.gz` makes `Report 2026`;
  `-2`, `-3` when taken). The folder is made as the caller, so its create
  checks the caller may add to the archive's folder (else 403) and it lands
  by the caller's home rule (docs/workspaces.md). A folder beside the
  archive, not a child of it, because a file in the Files tree holds no
  items: the contents are ordinary files the person can move, share and
  delete, apart from the archive.
- **The job.** The archive is stamped `queued` (`data.archive_extract`, one
  atomic update, so two asks never both run) and the `archive_extract`
  notify sends one job on the extract queue's heavy lane (one at a time,
  tried once, never re-driven). It runs only for a queued stamp. It reads
  the archive from disk as a stream (an archive only in object storage is
  spooled to a temporary file first; no archive is held in memory), checks
  the whole archive's file count and bytes before writing anything, then
  writes each file through the upload path (`spoolUpload`, then
  `upsertFile`) into the new folder, as the system: each file and folder it
  makes takes the home of the folder it lands in. Each new file is an
  ordinary upload: the extract queue reads it as any other (and a nested
  archive gets the default text and its own "Extract contents"). Each file
  carries `data.from_archive { id, path }`; it is no derived item of the
  archive (deleting the archive leaves them). An archive private to one
  login makes files private to that login. The job asks no rights of its
  own: the ask checked them, and the job writes only into the folder the
  ask made (the precedent of a run on demand). Progress is written on the
  stamp every 50 files or 3 seconds. A stamp `queued` or `running` older
  than 3 hours is taken as dead (the agent was down when it was sent), so
  the person may ask again. The GET and the tool's `check` then read it as
  `failed`, with the sentence "The extraction stopped before it finished.
  Ask again to extract it." (`archiveExtractViewOf`); the stored stamp is
  not changed.
- **Folders inside** are kept while the tree has room (three folder levels
  below Files): past that, the deeper folder names go into the file's name
  (`a/b/c/d.txt` with room for one level lands in `a` as `b-c-d.txt`, its
  title `b/c/d.txt`), counted in `flattened`; never dropped. Names are
  cleaned as for any upload (`sanitizeFilename`, `folderSlugOf`); two names
  that clean to one (`A.txt`, `a.txt`, or the same name twice) are both
  kept as `a.txt`, `a-2.txt`. A folder named twice in two spellings is one
  folder.
- **Limits** (`archive-read.ts`): the ZIP guard's own caps (`zip-guard.ts`):
  an entry at most 128 MB (or the box's upload cap, if lower), all the
  files together at most 512 MB, at most 10,000 files and at most 10,000
  folders (of the two levels a new folder can hold). Past the total or a
  count the archive is refused whole (`failed`, nothing written); an entry
  past 128 MB is refused and the others are written. The walk that writes
  holds the total and the file count itself too, and the archive must be
  the same file (size, time, inode) as the one the plan read, so bytes
  changed between the two are held all the same. A ZIP entry is
  held to its declared size as it inflates and checked against its CRC; a
  TAR's every entry counts against the total (each is read to pass it); a
  lone gzip is held to the entry cap as it inflates.
- **Refused, and named in `refused`, never dropped in silence:** a path
  that climbs (`..` anywhere: `traversal`), an absolute path (`/x`, `C:\x`,
  `\\host`: `absolute`), a name with a NUL or a part over 255 characters
  (`bad-name`), a symbolic or hard link (`link`), a device, FIFO or socket
  (`device`), an encrypted entry (`encrypted`), a ZIP method other than
  stored or deflated (`method`), a TAR entry type this reader does not
  know (`unsupported`), an entry past the entry cap (`too-large`), bytes
  that do not match the archive's word (more than declared, another CRC, a
  short range: `damaged`), and a write that failed (`not-written`).
  Skipped and counted in `skipped`: the macOS and Windows folder files
  (`__MACOSX/`, `.DS_Store`, `._*`, `Thumbs.db`, `desktop.ini`). A folder
  entry that holds bytes is refused (`unsupported`). Names shown or kept
  (titles, folder names, `refused`, `from_archive.path`) lose control
  characters, the marks that turn text around and halves of character
  pairs. An unknown fault is said in a fixed sentence (the detail is in the
  log). No entry's path is ever used as a disk path: every file lands by its cleaned name
  through `upsertFile`, inside the new folder.

---

## 9. MCP tools

Wired in [`server/mcp/src/server.ts`](../server/mcp/src/server.ts):

| Tool                   | Purpose                                                             |
| ---------------------- | ------------------------------------------------------------------- |
| `folder_list`          | Children of a folder, or the whole tree                             |
| `folder_create`        | Create folder + on-disk dir, optional description                   |
| `folder_describe`      | Set/clear folder description                                        |
| `folder_delete`        | Delete an empty folder (root cannot be deleted)                     |
| `file_list`            | Files in a folder                                                   |
| `file_upload`          | Create/overwrite a file (`content_text` or `content_base64`)        |
| `file_get`             | File metadata only                                                  |
| `file_processing`      | What the brain did with a file, and the items made from it (§8c)    |
| `file_reindex`         | Read files again through the whole pipeline (§8d)                   |
| `file_stale_list`      | The files that need attention: stale, failed, partial (§8d)         |
| `file_extract_archive` | An archive's contents into a new folder beside it, on request (§8e) |
| `file_read`            | File metadata + bytes (utf-8 for text, base64 for binary)           |
| `file_delete`          | Delete a file (both DB row and disk)                                |
| `screenshots`          | The area screenshots it reads: a list, or one with its image        |

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
does, and it is no login's private row (no `login_id`). Like every new
file it asks no visibility confirm.
It is named `screenshot-<yyyy-mm-dd-hhmmss>.png` (UTC; the next free name
when taken, the top of Files being one folder for every workspace), tagged
`screenshot`, its metadata in `data.screenshot` (`capturedAt` the server's
time when the client sent none), and recorded in Activity (ingest source
`screenshot`). The reply is 201
`{ file: { id, filename, sizeBytes, mimeType }, landedIn }`. The client may
then attach it to an assistant chat by its file id. The meta is what the
client said (advisory): nothing trusts `itemId`, `workspaceId` or
`capturedAt` for rights. The brain's image model reads the picture, as it
reads any uploaded image, to make it searchable.

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
(`nodes.login_id`): row security keeps it to that login. Logins in a brain
are trusted, so nothing more is added for one login against another. What
leaves the brain is held: a linked peer brain never reads one by any grant
(`peerPerLoginRow`, docs/federation.md), and no login may share one with
it.

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

### 10a. File history

New bytes over a file keep the bytes they replace (owner's decisions,
2026-11-18; `packages/files/src/file-history.ts`, migration 0384).

This is the brain's only version mechanism. A file's version is new bytes
under the SAME name in the SAME folder (one node, its old bytes kept here).
Versions are never guessed from file names (owner, 2026-11-20): two files
whose names differ only in their numbers (`12-62-29-sht-1.dwg`,
`12-62-29-sht-2.dwg`, `report-2026-02.xlsx`, `report-2026-03.xlsx`) are
different files, and nothing demotes one under the other. The extractor's
name-based pass that did (it grouped a folder's files whose names differed
only in runs of digits and marked all but the newest superseded, reason
`version`) is removed. The marks it left are cleared by hand (never
automatically) with the maintenance task `name-versions-clear`
(`server/web/lib/maintenance/name-versions-clear.ts`): a dry run counts the
file nodes with reason `version` whose `superseded_by` is a file in the same
folder (the shape the pass wrote) or no node any more (it has no foreign
key): to clear; and the other `version` marks (to a live page or a live file
in another folder, set by hand through `content_supersede`): left; `--apply`
clears the first kind's `superseded_by` and `superseded_reason` and puts their salience
back to 1, keeping `updated_at`. A `version` mark a person set by hand
between two files in the same folder looks the same as the pass's and is
cleared too. A `corrected` or `migrated` mark is never touched. It prints
counts only. On a box:

```sh
ssh <box> docker exec mantle_web pnpm maintain name-versions-clear          # dry run
ssh <box> docker exec mantle_web pnpm maintain name-versions-clear --apply  # clear
```

(or `scripts/box-maintain.sh <box> name-versions-clear [--apply]`; one
maintain run at a time on a box). Locally: `pnpm maintain
name-versions-clear [--apply]`.

Every path that writes a file by name keeps one node per name and folder
(the unique index `nodes_file_owner_path_slug_uq`, section 4): the upload
route (`POST /api/files/files`, also `/api/v1/files`), MCP `file_upload` and
`file_create`, and every other `upsertFile` caller either replace the file
in place (with `replace=true` or `overwrite`, its old bytes kept as a
version) or refuse the taken name (the 409 below, or "Already here" for the
same bytes); none makes a second file. The watcher writes a changed disk
file over its own node (its old bytes are not kept, section 11). A Sync
drive's file is keyed by its drive item, not by name: new bytes of an item
make its new node and retire the old one. Chat and Telegram attachments,
exports, screenshots, task files and an archive's contents take a new name
by design (a time stamp, or the next free number), since each is a new
file, not a version.

- **Upload clash.** An upload to a name already in the folder (no
  `replace`): the same bytes (`data.sha256`) answer 200
  `{ skipped: true, reason: 'same-bytes', existing: { id, sha256 } }` and
  nothing is written ("Already here"); other bytes answer 409
  `{ error, reason: 'name-taken', existing: { id, sha256, sizeBytes, name } }`
  so the client can ask Override / Override all / Skip / Skip all. Override
  is the same upload with `replace=true`; with `replace=true` the same
  bytes are skipped too (a retry keeps no duplicate version). A name taken
  by a file the caller
  does not read stays the plain 409 (nothing about it is said).
- **Versions.** Every overwrite with new bytes (an upload with replace, an
  edit, an export saved again, a tool's overwrite) keeps the old bytes as a
  `replace` version: the overwrite's own hard link of them lands in
  `MANTLE_FILES_ROOT/.file-history/<owner>/<file>/<version>.bin` (every part
  a server-made uuid; a dot folder the watcher and the sweeps never enter)
  and its `node_snapshots` row (`node_kind` 'file') is written in the
  overwrite's own transaction. Whether the bytes are new, and the
  version's record, are read under the file row's lock from what the row
  names then (two overwrites at once each keep what they really replaced;
  the size is the kept file's own). Same bytes keep nothing. The file row and
  each tree item carry `versions` (a count, one read per list) for a badge,
  and the row `replacedAt`.
- **Limits.** The newest `FILE_HISTORY_KEEP` (10) versions stay per file,
  and the whole box keeps `FILE_HISTORY_MAX_MB` (2048) of them, a soft
  cap: it trims, oldest first, deleted files' history, then live files'
  older versions, and never the newest version of a live file (one big
  file never takes every other file's history; the box may stay over the
  cap by those). The prune runs after each overwrite and each delete that
  kept bytes, its files go at once, and it logs what it removed and why.
  A deleted file keeps its last bytes as a `pre_delete` version (linked
  under the row's lock before the delete), and its history goes 30 days
  after that delete, in the nightly `app-trash-purge`. A file gone from
  disk (the watcher's delete) gets a `pre_delete` marker with no bytes, so
  its clock starts there too. A version file no
  row names (a crash between its link and its commit, an overwrite that
  never landed) goes in the store sweep an hour on (`filesnap`). No new
  job, no model work.
- **Rights.** Listing and downloading a version: whoever reads the file.
  Restore and delete of a version: a Moderator of the file's home, a
  Moderator of a workspace that holds the file, or an Admin user
  (`mayModerateSql`); never a plain user with Write on, never a read-only
  login, a public link or a key without its rights.
- **Restore.** The version's bytes go back through the same overwrite (the
  same file id, every gate of a write; a file that took the name meanwhile
  is refused, 409, never written over), so the bytes they replace are kept
  as a `pre_restore` version: a restore is undone by restoring that one.
  The bytes are copied (never linked) and hashed; a hash that differs from
  the row's is logged, never a refusal (the bytes are the version).
- **Derived items.** New bytes (a replace or a restore) are read again as an
  upload is. Extracted images are never removed for new bytes (Pages embed
  them by id): images of older bytes are marked `olderVersion` (an image
  carries `sourceSha256`, the bytes it came from), and a new image pass
  runs only when a person put the new bytes there by hand
  (`replaced_by` 'person', set only by the upload with replace and the
  restore route). Any other save (an agent's, an app's or an MCP client's
  in a login's scope, an export's, the system's) starts no image pass and
  no vision work; its file keeps the older images, marked. An auto
  Table keeps its rows (people may have edited them); a Table made before
  its file's `replacedAt` is from an older version, which the client can
  show.
- **Routes and tools.** `GET /api/files/files/:id/history`,
  `GET .../history/:sid/download`, `POST .../history/:sid/restore`,
  `DELETE .../history/:sid`; MCP `file_history_list`,
  `file_history_restore`, `file_history_delete`.

## 11. Known sharp edges

- **Host edits keep no version.** A file changed on disk outside Mantle
  (section 10) is read again, but its old bytes are not kept: file
  history keeps what a write through Mantle replaced.
- **Reads in part.** A scanned PDF is read by OCR up to a page cap, and
  other readers have caps of their own (section 8a, "Read in part"); a file
  read in part shows `partial` with what was left out, and that part is not
  in search.
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
