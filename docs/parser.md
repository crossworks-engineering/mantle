# The parser service

One container, `mantle-parser` (`server/parser`), reads every untrusted file
the brain receives: documents (PDF, Office, OpenDocument, Visio, markup),
spreadsheets and plans as grids, CAD drawings (DWG, DXF, DGN, DWF), images for
thumbnails and vision, and the audio track of an uploaded video. The web,
api and worker processes never open such a file themselves. They send the
bytes to the parser through one client,
`packages/files/src/parser-client.ts`, and get back text, grids, pictures
or a typed error.

It replaced two sidecars: Apache Tika (the fallback text reader) and the
media sidecar (CAD renders, `yt-dlp`, ffmpeg). Both are gone, with every
setting that belonged to them.

## Why a container

A document can be built to hurt its reader: a zip that inflates to
gigabytes, a spreadsheet that declares a billion cells, a PDF with a
100,000 by 100,000 pixel image, a deck that loops a parser forever. Code
inside a process cannot reliably stop that, so the guarantee is the
operating system's:

- **Memory, one job at a time.** `mem_limit` (default `2g`,
  `PARSER_MEM_LIMIT`) with `memswap_limit` equal to it (no swap past it),
  and always one job at a time (there is no setting to raise it), so a job
  has the whole memory and a healthy file is never killed for its
  neighbour. A document that blows the limit is killed by the kernel
  inside the parser, never in a brain process.
- **CPU.** `cpus` (default `1`, `PARSER_CPUS`): every box can grant it, a
  1-vCPU box included. Raise it on a box with cores to spare.
- **Disk.** The root filesystem is read-only (`read_only: true`). The job
  user can write only to tmpfs mounts: the scratch space (`/tmp`, where a
  job's files live, `PARSER_TMP_SIZE`, default `1g`), `/dev/shm` and
  `/dev/mqueue`. A job cannot fill the host's disk or change the image's
  code. A tmpfs is memory: a job's files count in `mem_limit` while they
  sit there. A request takes the job slot before its body is read, so the
  scratch space only ever holds the files of the job that runs. A job's
  temp files, home, caches and matplotlib's font cache are inside its own
  directory (`TMPDIR`, `HOME`, `XDG_CACHE_HOME`, `MPLCONFIGDIR`,
  `server/parser/src/proc.ts` `jobEnv`), and Bun keeps no cache for the
  server or the healthcheck (`BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`, set in
  the image), so the server itself writes nothing to `/tmp` but the empty
  job root.
- **Network.** The parser sits only on the compose network `parser`
  (`mantle_parser_net`, `internal: true`): no route out (no NAT), and
  `dns: 0.0.0.0`, so Docker's resolver forwards no name outside the stack.
  The app services that send it files (web, api and the workers that run
  turns or tools: telegram, events, runs, push, and maintenance, which runs
  the app timers and asks the parser for its health for `box_status`) join
  that network as well as the default one. What the parser can reach is exactly those
  containers, on that network; not postgres, the object store or anything
  past the host. The other workers and migrate are not on it.

  What the parser can reach includes web's port 3000 directly, past Caddy.
  The web server takes the client address from X-Forwarded-For (the entry
  `MANTLE_TRUSTED_PROXIES` hops from the right) or X-Real-IP from any peer
  (`server/web/lib/rate-limit.ts`, `clientIpFromHeaders`), so a request
  sent from inside the parser (a reader broken out of its document) could
  claim any address: a fresh per-address rate-limit bucket on each request
  to sign-in and key presentation, and a made-up address in the audit log.
  It gains no access: every route still asks for a session or a key, and
  no route trusts an address for anything but those budgets and the log.
  The same holds today for any other container on the stack's networks and
  for a process on the host (web's debug port, `127.0.0.1:3000`). Trusting
  those headers only from Caddy is the fix; it is not a narrow change (the
  peer address is not passed to the limiter, and split or externally
  proxied boxes put a different peer in front), so it is its own piece of
  work.

- **Little else.** `cap_drop: ALL`, `no-new-privileges`, `pids_limit: 512`,
  no mounted data, no secret but its bearer token (a job's process does
  not get it; a reader's child program gets a minimal environment of its
  own). `init: true` (tini) reaps a job's children.
- **Restarts.** `restart: unless-stopped`, a `/healthz` healthcheck, and the
  `autoheal` label for a wedged process.

Inside, each job runs in its own process and process group
(`server/parser/src/job.ts`), and the server sends `SIGKILL` to the group at
the job's deadline, when the client goes away, and when the job ends. A
reader's child program (the Python CAD child, ffprobe, ffmpeg) starts in the
JOB's group (`runChild`), never one of its own, so that kill takes it and
whatever it started. The deadline is absolute: the server settles on the
job's exit, not on its output pipes closing, so a descendant that left the
group (`setsid`) cannot hold the slot. The kernel's OOM kill lands on the
job process (the largest), and the server answers `crashed`.

## Between jobs

The container is the boundary between one job and the next, not code. The
server does not hunt for what a job left and tidy it; it checks whether the
container is as clean as a fresh one and, if it is not, throws it away.

After every job, once its answer (or its error) is sent and before the slot
is given back, the server (`server/parser/src/main.ts` `afterJob`,
`server/parser/src/clean.ts`):

1. kills the job's process group again, and removes the job's directory;
2. checks the processes. Inside the container the only ones allowed are
   PID 1 (Docker's init, tini), the server (`bun`), and a
   process entered from outside the container (`docker exec`: the
   healthcheck, an operator), whose parent is outside it. Nothing of the job's group, nothing that
   descends from the job, and nothing that left it: a process that left the
   job's group (`setsid`, a double fork) is re-parented to PID 1 when the
   job dies, so it descends from neither the server nor `docker exec`. A
   zombie is dead already. The job's killed processes get 2 s to go;
3. checks the files. `/tmp` holds the job root (`/tmp/mantle-parser`) and
   nothing else, the job root is empty, `/dev/shm` and `/dev/mqueue` are
   empty, and no System V IPC object (shared memory, a semaphore, a message
   queue) exists. With the root filesystem read-only, these are every place
   the job user can write.

If a check fails, or the cleanup itself throws (a directory the job made
undeletable), the server logs one line saying why
(`[parser] RESTART: after <job>: <why>`), takes no more jobs, answers every
waiting request `unavailable` (the client retries it and never counts it
against the file), lets the requests in flight be answered (at most 20 s),
and exits 1. Docker restarts the container (`restart: unless-stopped`)
with a fresh tmpfs and a fresh process table. The check runs only after a
job, so a clean start never exits, and Docker's restart backoff resets
after 10 s of uptime. The job that left something behind got its answer
first.

A slot held longer than any job may legitimately hold it (the longest
job's limit, the body's and the answer's 60 s each, and a 30 s margin:
`parserSlotHoldMaxMs` in `packages/files/src/parser-wire.ts`) is a wedge:
`/healthz` answers 503, the healthcheck fails, and autoheal restarts the
container the same way. The answer itself can no longer wedge it: it is
streamed with a pipeline that settles when the connection closes, at any
point.

Outside the container (`pnpm dev`, the tests) only the job root is
checked: the host's processes and its `/tmp` are not the parser's.

## Limits

| Setting                     | Default | What it bounds                                                           |
| --------------------------- | ------- | ------------------------------------------------------------------------ |
| `PARSER_MEM_LIMIT`          | `2g`    | the container's memory, no swap past it (compose)                        |
| `PARSER_CPUS`               | `1`     | the container's CPU share (compose)                                      |
| `PARSER_TMP_SIZE`           | `1g`    | the scratch tmpfs, counted in the memory while full (compose)            |
| (jobs)                      | 1       | jobs at once, always; each its own process                               |
| `PARSER_QUEUE_MAX`          | 16      | requests that may wait for the slot; one waits at most 30 s, then `busy` |
| (interactive)               | 10 s    | a person-facing request's wait, at the head of the queue, then `busy`    |
| (transfer)                  | 60 s    | the body's arrival and the answer's, each, once the slot is taken        |
| `PARSER_MAX_UPLOAD_MB`      | 512     | the largest body (the brain's streamed upload cap), while it streams     |
| `PARSER_CLIENT_CONCURRENCY` | 2       | jobs one brain process sends at once                                     |
| `PARSER_TOKEN`              | none    | the bearer token on every route but `GET /healthz`                       |

An interactive request (a chat attachment, a thumbnail: the client sends
`X-Parser-Priority: interactive`) waits at the head of the queue, behind
earlier interactive ones only, and is answered `busy` after 10 s; it is not
turned away by a full background queue (each kind is capped at
`PARSER_QUEUE_MAX`). There is no second slot: it takes the slot when it
frees. A body that has not arrived 60 s after its slot was taken, or an
answer not read within 60 s, has its connection cut and the slot given back.

An answer is at most 96 MB (`PARSER_ANSWER_MAX_BYTES`,
`packages/files/src/parser-wire.ts`): the brain holds an answer in memory
while it reads it, so the parser refuses a larger one `too_large` rather
than send it, and the client refuses one past it. The pictures of one
answer (a document's images, a PDF's pages for OCR, a drawing's crops)
share a 64 MB budget: the pictures past it are left out and counted, never
an error. A PDF page whose PNG is past 12 MB is sent as JPEG, and at most
20 pages are rendered for one answer.

Without `PARSER_TOKEN` the parser serves without auth and logs that it does
(its network is internal to the stack). `scripts/install.sh` writes one, and
a roll provisions it when it is missing (`infra/updater/updater.sh`,
`ensure_parser_token`).

Inside the limits, the readers keep cheap early refusals, so a bomb is
usually turned away before it costs much:

- zip-based formats: each part inflated at most 128 MB, 512 MB in all,
  100,000 entries (`packages/files/src/zip-guard.ts`);
- legacy workbooks (`.xls`, `.xlsb`): converted only up to
  1,000,000 cells per sheet; a larger sheet is left out and named in the
  text (`packages/files/src/legacy-sheet.ts`);
- PDF: a file over 256 MB is refused, an image declaring more than 75
  million pixels is not decoded, pages are rendered one at a time at most
  4096 by 4096 pixels and cleaned up after each (`packages/files/src/pdf-open.ts`,
  `packages/files/src/rasterize.ts`). The JPX, CCITT and JBIG2 decoders are
  WebAssembly modules of pdfjs: every open names their directory in the
  installed package (`wasmUrl`), and they load from the disk of the image,
  with no network;
- images: at most 100 million pixels decoded (`packages/files/src/image-read.ts`).

A refusal is answered `too_large`, marked final (`"final": true` in the
error envelope): the same bytes fail the same way every time, so the client
makes it terminal at once. A full scratch space (`ENOSPC`) is `too_large`
but not final: the space can be full for other reasons, so the bytes get
their one retry.

## Routes

Every route is a `POST` whose body is the job's options as JSON
(`X-Parser-Opts-Length` bytes) followed by the file's raw bytes. The answer
is JSON, except the byte routes (audio, images for vision, thumbnails),
which answer the bytes with metadata in the `X-Parser-Meta` header. The
contract is `packages/files/src/parser-wire.ts`.

| Route              | Job            | Time limit | What it does                                     |
| ------------------ | -------------- | ---------- | ------------------------------------------------ |
| `/text`            | `text`         | 120 s      | document to plain text                           |
| `/images`          | `images`       | 180 s      | a document's embedded pictures, gated and capped |
| `/grid`            | `grid`         | 120 s      | workbook, MSPDI plan or DWF registry to grids    |
| `/pdf/rasterize`   | `pdfRasterize` | 180 s      | PDF pages to PNG for OCR                         |
| `/pdf/info`        | `pdfInfo`      | 60 s       | PDF page count                                   |
| `/pdf/unlock`      | `pdfUnlock`    | 60 s       | a locked PDF's text with one candidate password  |
| `/dwg/render`      | `dwgRender`    | 240 s      | DWG/DXF/DGN registry, bones and a sheet PNG      |
| `/dwg/crop`        | `dwgCrop`      | 240 s      | DWG/DXF/DGN close-ups and `view` pictures        |
| `/extract-audio`   | `extractAudio` | 600 s      | a video or audio file to mp3 (ffmpeg)            |
| `/image/thumbnail` | `thumbnail`    | 30 s       | an image to a bounded JPEG                       |
| `/image/vision`    | `visionImage`  | 60 s       | HEIC/HEIF to JPEG for a vision model             |

A DGN (MicroStation V8, or V7 2D) takes the same exchange. The extractor
sends a `.dgn` only when its bytes are a DGN: a V7 header, or a compound file
whose bytes hold the name of the DGN header stream (`Dgn~H`, in UTF-16; a
byte search, not a walk of the compound file's directory). (`dwg_render` and the crops send
the bytes as they are; the worker's ezdgn refuses a compound file with no DGN
streams, and the call fails with that reason.) The worker reads it with ezdgn (MIT) in
`server/parser/cad/dgn_read.py`, into the same in-memory ezdxf document a DWG
becomes (converter `ezdgn`). From there the registry, bones, circuits,
picture and crops are the DWG path. The reply's `dgn` key states what was read
and what was not, and the digest repeats it in words.

### What a DGN gives, and what it does not

- **Models.** The model with the most converted elements is the drawing, in
  model space (a tie goes to the first). The registry, the bones, the
  circuits and the picture read model space only. Every other model with
  elements is converted into a block of its own (`MODEL <n> <name>`), kept
  apart from the drawing and not read; `models` lists each model with its
  elements and texts, and the note says how many elements and texts are not
  read. An empty model is listed as `empty`. A model the DGN's model index
  names but whose content is not in the file (deleted, or kept in another
  file) is listed in `skipped_models` and stated.
- **Levels.** A level becomes a layer by its name; a V7 level, and a level
  with no name or a name of only spaces, by its number. Only the characters
  ezdxf refuses in a layer name (`" * / : ; < = > ? \` and backtick) become
  `_`. `levels_changed` lists each renamed level with its layer, and each
  level that shares a layer name with another level; the note gives both
  counts. A circuit on a renamed level is named after its layer, not its
  level. Two levels whose names differ only in case share one layer table
  entry, but each element keeps its own layer name, and the registry reads
  that.
- **Cells.** A cell is a block and an insert at the cell origin; the block
  holds the cell's parts less the origin, and the insert has no rotation or
  scale. Placements with one name and one geometry share a block; the same
  name with other geometry inserts `<name>#2` and so on, so the registry's
  `inserts` count by block name. `cells` gives the true count per cell name:
  `placements` in the drawing, `other_models` in the models kept apart,
  `variants` and the `blocks`; `cell_names` is how many names there are. A
  cell with no name is an anonymous block (`*U<n>`). The texts of a cell, and
  of cells inside it, are attributes of the top insert, so the registry reads
  them. A V8 cell's name comes from its name linkage (ezdgn 0.3.2 leaves it
  empty).
- **Shared cells** are not expanded: each instance is an insert of an empty
  block with the shared cell's name, at its origin. Counted in
  `shared_cells_not_expanded` and `shared_cell_names`.
- **3D.** A 3D model is drawn in plan: every point is projected to XY. A 3D
  arc or ellipse turns by its quaternion; one in the plan stays an arc or a
  circle, a tilted one is an ellipse with its true axes. `not_flat` (a Z range
  past 2 UOR) and `wild_z` (a Z past 1e9) are counted per model and in all,
  and the note states them when any model is 3D. A 3D text is drawn unturned
  (ezdgn 0.3.2 does not decode its turn) and counted in `text_turn_unknown`.
  A V7 3D file is refused with its reason.
- **Not converted, and counted** by kind and raw element type in
  `not_converted` (never dropped in silence): dimensions, tag elements,
  B-spline curves with their poles, knots and weights, raster frames, element
  types ezdgn does not decode, an arc with no turn, an element with a
  coordinate or size that is not finite or past 1e9, and a component under an
  element that has none of its own. Item-type data (for example a line-number
  label's values) is not read. `unreached` counts records under no drawn
  element; `repeated` counts references to a record already drawn (drawn
  once). `gap` compares the converter's count with ezdgn's records (a
  converter fault when not 0), and `reader_gap` compares ezdgn's records with
  the graphical objects its own scan found in the file; the note states any
  difference. A text width past 1e9 is drawn at the plain width.
- A V7 text is decoded as latin-1 (`text_encoding`).
- A DGN with a raster frame and at most 50 other elements is stated as a scan
  in a DGN wrapper (`raster_only`).
- A fault inside ezdgn, its Rust core's panic included, fails that file
  cleanly with `ezdgn:` and the error's name; it never takes the worker down.

A compound file that is not a DGN (an old Word or Excel file named `.dgn`) is
a sniff miss, as a mislabelled `.dwg` is: the parser is not asked, and the
file gets the free `no_parser` skip with the "renamed or mislabelled" hint.

### DGN files from before the reader

A DGN uploaded before the reader keeps its `no_parser` skip
(`data.extract_skipped`). Nothing reads it again by itself while the file is
unchanged: the drains, the sweep and the nightly maintenance pass all leave a
stamped file alone, and `extract-images-backfill` does not list `dgn`. A
change to the file (a rename, an edit, new bytes) moves `updated_at` and makes
the stamp stale: the boot drain or the periodic sweep (both look back 7 days)
then reads it in full, the digest, the picture and the database, then a
summary, embeddings and facts, with model spend, as for any changed file.

Until it has a database:

- The health screen counts it under "Table-type files with no database and no
  word" (`file_db_missing`). After the roll, a box with old DGN files shows
  them there.
- `circuit_trace` sorts a drawing with a current `no_parser` stamp after the
  others, so old DGN files cannot crowd DWG sheets out of its 200-drawing
  window. Each still gives its "gives no sheet" line when there is room, and
  `more` says when the window is full. The stamp stays after the database is
  built, so on a box with more than 200 drawings an old DGN can still be the
  one cut.

**The roll step (a person starts it).** The model-free rebuild builds the
read-only database of every table-type file that has none, old DGN files
included. On a box, from the integrator's machine:

```sh
scripts/box-maintain.sh <box> dwg-reindex --limit=1000                          # DRY RUN: lists each file it would read
scripts/box-maintain.sh --files-writable <box> dwg-reindex --apply --limit=1000 # build
scripts/box-maintain.sh --files-writable <box> dwg-reindex --apply --limit=1000 --after=<id>  # go on, as the last run printed
```

`--limit` counts the files a run would read, in the dry run too: with no
`--limit` a run stops at 100 (the most is 1000), and `--after=<id>` goes on.

What it changes: for each table-type file with no database and no word (any
table-type format, not DGN alone), it writes `<files>/.file-dbs/<id>.<sha>.sqlite`,
or a `.none` word when the file gives no rows, beside the bytes. Only the
parser is called: no model, no Table, no write to the file's row (so
`updated_at` does not move and the `no_parser` stamp stays). The file's
summary and search stay as they were; `file_sql` and `circuit_trace` read the
new database. A file is read in full, with model spend, only by
`process_extraction` with its `node_id`, a new upload, or a change to the file
(a rename, an edit, new bytes; see above): one file at a time.

The picture of a DWG, DXF or DGN frames the sheet, not model space
(`server/parser/cad/dwg_frame.py`). Model space has no paper, so a note parked
far off the sheet would otherwise hold the sheet in a corner of the picture.
The frame is the sheet's border when there is one: the largest closed polyline
whose box holds at least 90% of the geometry, text not counted. It loses to a
larger entity that holds it, to a second one of about its size beside it
(tiled sheets), and to more than 10% of all entities outside it, text included.
With no border, a group is left
out only when it is few (at most 10% of the entities), small (at most 25% of
the main group's span) and far (at least 25% of that span away), along one
axis. A drawing with nothing outside the frame draws as it always did.
What is left out is in the reply (`frame.off_sheet`, with each group's window)
and in the digest, and its text is in the workbook as before. `dwg_render`
asks for a `view` item of the crop job: the sheet, a window, or all of model
space, on the same page size, so strokes weigh the same.

`GET /healthz` answers the running and queued job counts and the reader
versions the image carries (pdfjs, anydoc, exceljs, mammoth, python, ezdxf,
ffmpeg, dwg2dxf); 503 while the slot is wedged or the parser is
restarting (above). The client waits the parser's worst legitimate time
for the job, never less: the queue wait (30 s, or 10 s for an interactive
request), the body's 60 s, the job's limit, the answer's 60 s and a 30 s
margin (`parserClientTimeoutMs`, built on the same function as the
parser's watchdog).

## Errors

Every failure is a typed `ParserError` with a `code`, and `retryable` and
`terminal` flags the callers act on.

| Code          | HTTP | Meaning                                                                    | What the brain does    |
| ------------- | ---- | -------------------------------------------------------------------------- | ---------------------- |
| `too_large`   | 413  | past a cap (body, zip part, cells, pixels, PDF size)                       | counted                |
| `timeout`     | 504  | the job ran past its limit and was killed, or the client's deadline passed | counted                |
| `crashed`     | 502  | the job process died (OOM kill, native crash), or the connection dropped   | counted                |
| `unsupported` | 415  | no reader takes the format                                                 | a verdict              |
| `busy`        | 429  | every slot stayed taken past the queue wait                                | retried, never counted |
| `failed`      | 422  | the reader refused the file: corrupt, encrypted, not what its name says    | a verdict              |
| `unavailable` | 503  | the parser could not be reached, or a wrong token                          | retried, never counted |
| `bad_request` | 400  | the request was malformed (a client bug)                                   | a verdict              |

**Counted** codes count against the bytes in that job: the first is
retryable (a loaded box can be slow once, a restart can drop one
connection), the second is terminal, and a terminal job is refused at once
without asking the parser again. A final refusal (a fixed cap, above) is
terminal the first time. The extractor keeps the count on the node
(`data.parser_failures`, keyed by the job and the bytes' sha256, written by
`server/api/src/agent/extract/parser-failures.ts`; migration 0339), so it
survives a restart or a roll: one bomb costs the parser at most two jobs of
each kind, whatever happens in between. A content change drops the key
with the other byte keys. Anything else (a chat turn, a thumbnail) counts
in its process's memory. Counted per job, a document whose pictures run
out of time still has its text read. Nothing re-drives a terminal file: it
waits for its bytes to change.

What each caller does with them:

- **The extractor** (`server/api/src/agent/extract/load-body.ts`): a
  retryable failure fails the extract job, and pg-boss retries it. A
  terminal one records the `document_unreadable` skip
  (`data.extract_skipped`), so the drain does not pick it up again. `failed`
  and `unsupported` index the title, as before.
- **Side passes** (pictures, auto-table): only `busy` and `unavailable` fail
  the job; any other failure is logged and the text body is indexed anyway.
  DWG, DXF and DGN are the exception: their workbook, digest and picture come
  from one exchange, so a retryable failure there fails the whole extract,
  and the failure is kept for the rest of that extract (no later pass asks
  again or counts it twice).
- **A PDF with a text layer, read natively by preference**: the text layer
  is kept whatever the parser answers.
- **The scanned-PDF OCR pass**: `busy`, `unavailable` and the first
  timeout or crash fail the extract and pg-boss retries it; the second
  counted failure is the terminal `document_unreadable`; `too_large` is the
  terminal `pdf_too_large`; a reader's `failed` is the non-terminal
  `pdf_unreadable`. The native model read of a PDF that found no text is
  kept on the node (`data.native_pdf = { empty_sha256 }`, written before
  the render runs), so a retry, or a redrive after a restart, does not pay
  for it again; new bytes drop the key.
- **HEIC for vision** (`packages/files/src/transcode.ts`): a retryable
  failure is thrown, never an unconverted HEIC sent on to a vision model.
- **A chat turn** with an attachment says the file could not be read.
  It runs interactive and uncapped
  (`withParserScope({ interactive: true, uncapped: true })`): it skips its
  process's client cap (`PARSER_CLIENT_CONCURRENCY`), waits at the head of
  the parser's queue for at most 10 s, and a `busy` after that is the
  answer, never retried: the turn says "try again in a moment". The
  background extract retries `busy` (2, 5 and 10 s). Thumbnails run
  interactive too (the head of the parser's queue, a busy parser shows the
  type icon and the next request tries again), but take their turn under
  the process's cap, so a gallery cannot starve the background extracts.
- **Health** (`parserHealth`): up means the parser answers `/healthz` AND
  takes this process's token. `/healthz` says whether the parser asks for a
  token and whether the caller's is right; a mismatch, or a parser that asks
  none while this process has one, reads as down.

## What stays in the brain

A few reads stay in-process, because they are not parsing untrusted
structure or the brain wrote the bytes itself:

- **Plain text** (`TEXT_EXTS` in `packages/files/src/slug.ts`: md, txt, csv,
  json, yaml): decoded as UTF-8. Reading a string is not parsing.
- **Delimited text to grids** (CSV and pasted tables,
  `packages/files/src/sheet-to-grid.ts`): a split over a string.
- **MSPDI sniffs** (`packages/files/src/mspdi-sniff.ts`): a look at the
  first bytes of an `.xml` to route it.
- **Image header sniffs** (`packages/files/src/image-probe.ts`): format and
  dimensions from a handful of header bytes, no decode.
- **Email MIME** (`mailparser` in `packages/email/src/providers/imap.ts`):
  the mail itself, at most 64 MB a message (the size is read before the
  source is fetched; a larger one lands with its headers and a note), with
  `skipHtmlToText`. An attachment's contents go to the parser like any
  file, and an HTML-only body is turned into text by the parser (`/text`,
  in the extractor and `email_get`).
- **`.mantleapp` imports** (`packages/content/src/app-package.ts`): jszip
  reads an app package, bounded before it is opened (entry count from the
  zip's end record, at most 16 entries, each file and the whole package
  capped).
- **Drawing SVGs** (`packages/content/src/svg-sanitize.ts`): a drawing's
  own snapshot, parsed by saxes and rebuilt from an allowlist, element
  count and depth capped, DOCTYPE refused, then rendered by resvg as
  WebAssembly in a process of its own with no file system.
- **Writing**: exceljs and jszip build workbooks and app packages. Past
  the two bounded reads above, those libraries never read an untrusted file
  in the brain.

The rule is enforced by lint: `eslint-rules/readers-in-parser.mjs` refuses
an import of a reader module (`@mantle/files/readers/*`, or a reader file
inside `packages/files`) or of a parsing library (pdfjs, mammoth, anydoc,
heic-convert) anywhere outside `server/parser`, the readers themselves and
tests. A new format means a new reader under `@mantle/files/readers` and a
parser route, never a reader in the brain.

## Gaps

- **Legacy Visio (`.vsd`)**: Tika read its text; nothing reads it now. The
  extractor asks for a `.vsdx` export. `.vsdx` reads in full.
- **Pictures in `.xlsb`**: the text and grids read, the embedded pictures
  do not (Tika's `/unpack` read them). `.xls` pictures were never read.
- **`video_ingest` by link**: removed with `yt-dlp`. The tool takes an
  uploaded file only: upload the file, then `video_ingest` with its file
  id (`file_node_id`).
- **The audio extract** is held to the duration limit (`-t`) and one byte
  past the size limit (`-fs`), and reads only local files (`-protocol_whitelist
file`) in the demuxers of the stored media formats (`-format_whitelist`:
  mp4/mov/m4a, matroska/webm, avi, mp3, wav, ogg, flac, aac). A recording
  whose length ffprobe cannot read is cut at the duration limit.

## Scans that drew blank before the decoders

Until `wasmUrl` was set (see Limits), pdfjs could not load its JPX, CCITT and
JBIG2 decoders. It dropped such an image with no error, so the page rendered
white. The old renderer (pdf-to-png-converter) set no `wasmUrl` either, so
treat every scan since the OCR path began (2026-05-25) as a candidate. The fix
does not change what is already stored. What a white page left behind:

- **A document read natively** by the document worker (`data.native_pdf` is
  `true`) is not touched: the provider read the PDF, no render ran.
- **A blank verdict**: the vision worker answered nothing, so the node has the
  terminal `data.extract_skipped.reason = 'no_text_layer'`, no text and no
  embedding.
- **A false document**: the default vision prompt asks for a description, so a
  white page can come back as a sentence that it is blank. Past 20 characters
  that sentence is indexed as the document (`data.ocr` is `true`), with a
  summary, an embedding and facts. A scan of mixed pages lost only the pages in
  these codecs.
- **A lost picture**: a PDF with a text layer keeps its text and loses the JPX
  pictures. The 1-bit images were never picked up as pictures (`toPngBytes`).

To find them, list the candidates, then look in their bytes. Neither step
calls a model. This SQL is read-only and prints ids:

```sql
select id, data->'extract_skipped'->>'reason' as skip, data->>'ocr' as ocr
  from public.nodes
 where type = 'file'
   and (lower(coalesce(data->>'filename', title)) like '%.pdf'
        or data->>'mimeType' = 'application/pdf')
   and (data->'extract_skipped'->>'reason' = 'no_text_layer'
        or data->>'ocr' = 'true');
```

For each id, read the file (`readFileById`, as `countPages` does in
`server/web/lib/maintenance/ocr-rescan.ts`) and look for `/JPXDecode`,
`/CCITTFaxDecode` or `/JBIG2Decode` in the raw bytes. An image's dictionary is
plain text in the file, also in an encrypted one. A hit is a document to read
again; a miss means the blank verdict came from something else. An inline image
can name its filter `/CCF` inside a compressed content stream, so this scan can
miss one.

Reading a document again spends model money (a vision call a page, then a
summary, an embedding and facts), so it needs the owner's word.
`pnpm maintain ocr-rescan` does not list these documents: its candidates are
another bug's.

`pnpm -C server/web blank:scans` (maintenance task `blank-scans`) does both
steps above and prints counts per codec, pages, the workers and an estimated
USD, with no model call. `--apply --before=<YYYY-MM-DD>`, the day the box got
v0.400.56 or later, clears and re-queues the hits read before that day (start
with `--limit=3`); a date after today is refused. An OCR'd hit with more than
200 characters a page (`--ocr-max-chars`) read its pages and is left alone:
its codec is a logo or a stamp. Each file it sends is stamped
`data.blank_scan_reread` in the same transaction, and that UPDATE checks the
file is still a candidate, so a second run, at once or later, never sends it
again. A file read after `--before` was read with the decoders and is left
alone.

## Running it in development

`pnpm dev` starts the parser natively next to everything else, bound to
127.0.0.1:8095 (`pnpm dev:parser` runs it alone). The brain finds it at
`PARSER_URL` (`.env.example`: `http://127.0.0.1:8095`); a token is
optional. Documents, images and PDFs read with the workspace's packages alone, on Bun. The
CAD and audio jobs start child programs: python3 with ezdxf, ezdwf, ezdwg, ezdgn
and matplotlib, `dwg2dxf`, and ffmpeg. Without them on the host those jobs
fail typed (`crashed`, "could not start") and everything else still reads.
`GET /healthz` lists what it found.

The CAD Python tests live in `server/parser/cad/tests`; they skip the
cases that need ezdxf when it is not installed.

## Building the images before a release

The release workflow (`.github/workflows/release.yml`) builds both images
for amd64 and arm64, probes them (the readers, then the parser service
booted with no network reading a document end to end) and only then moves
`:latest`. Building both architectures on a Linux build host BEFORE the
tag catches a broken arch an hour earlier. Once per machine (arm64 emulation
and a builder that can build for both):

```sh
docker run --privileged --rm tonistiigi/binfmt --install arm64
docker buildx create --name mantle-xarch --use
```

Then, from a clean checkout of the commit to tag:

```sh
docker buildx build --platform linux/amd64,linux/arm64 --target parser --output type=cacheonly .
docker buildx build --platform linux/amd64,linux/arm64 --target server --output type=cacheonly .
```

Both must finish without an error; nothing is pushed.
