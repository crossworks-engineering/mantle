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
| `/pdf/drawing`     | `pdfDrawing`   | 240 s      | a PDF's page facts, its kind, its drawing rows   |
| `/pdf/pieces`      | `pdfPieces`    | 240 s      | scan pages cut into numbered pieces of text      |
| `/dwg/render`      | `dwgRender`    | 240 s      | DWG/DXF/DGN registry, bones, symbols, sheet PNG  |
| `/dwg/crop`        | `dwgCrop`      | 240 s      | DWG/DXF/DGN close-ups and `view` pictures        |
| `/extract-audio`   | `extractAudio` | 600 s      | a video or audio file to mp3 (ffmpeg)            |
| `/image/thumbnail` | `thumbnail`    | 30 s       | an image to a bounded JPEG                       |
| `/image/vision`    | `visionImage`  | 60 s       | HEIC/HEIF to JPEG for a vision model             |

A DWG is read by ezdwg's reader (MIT, clean room, Rust core) in
`server/parser/cad/dwg_read.py`, into an in-memory ezdxf document (converter
`ezdwg`), and from there the registry, bones, circuits, picture and crops
are the one ezdxf path. ezdwg's own DXF export is not used: it loses text
the reader has. There is one reader and no fallback: a DWG it cannot read is
refused (`no converter produced a parseable DXF (ezdwg: <reason>)`, the
parser's `failed`, counted per bytes by the client as any failure). The
reply's `dwg` key states what was read and what was not. The digest prints
two lines from it, each only when it has something to say: "Not converted: N
of M DWG objects (by type)", and "Partly read: ..." with each reason of
`dwg.partial` and its count, and the gap when it is not 0.

### What a DWG gives, and what it does not

- **Every object is counted.** Each entity object the file's object list
  names is converted, or counted in `dwg.not_converted` by type and reason
  (`not decoded by ezdwg`, `no converter`, a number that is not finite or
  past 1e12, an owner that is not known, an error's class). `gap` compares
  the total with the object list (0 on every file measured). A file whose
  object list cannot be read, or whose list names entity objects of which
  the reader decoded none, is refused: never an empty document.
- **What is lost below the entity is counted too**, in ONE list,
  `dwg.partial`, by short reason: a table that could not be read (units,
  linetype scale, linetypes, text styles, layouts, the INSERTs' block
  handles, the saved pictures), a linetype, text style, layer or block the
  document refused, a value that is not finite (a text style's value, an
  extrusion, a block's base point), and an entity drawn another way (a
  MULTILEADER with no saved picture, a hatch pattern ezdxf does not know, a
  DIMENSION with no drawn block). A block whose base point is not read is
  drawn from 0,0,0 and counted block by block, also when the reader gives
  no base point at all; the file is not refused. A block that holds no
  entity needs no base point and is not counted. A whole read has an empty
  list. Values inside one entity that fall back to a default are not
  counted (an unknown layer handle gives layer 0, an unknown linetype or
  style the default, a hatch path or polyface face that is too short is
  left out, vertex kinds that do not match the points are ignored): they
  change the picture only, and the text is kept.
- **Blocks stay blocks.** An INSERT names its block by handle, so two blocks
  with one stored name, or an anonymous block (the DWG stores `*U` with no
  number), each get a unique name and the right geometry. Nothing is
  expanded. A dynamic block keeps its anonymous name: its true name is in
  the block's extended data, which the reader does not return (the old
  converter showed the anonymous name too). A block that draws itself,
  directly or through others, by an INSERT or MINSERT, a DIMENSION's drawn
  block or a MULTILEADER's content or arrowhead block, is cut at the entity
  that closes the cycle, counted under its own type (with the ATTRIBs of a
  cut INSERT).
- **Attributes** sit on their INSERT (hidden ones stay hidden), so the
  registry's Blocks keep each tag with its value, as before.
- **MULTILEADER** is made from the reader's row and takes the saved picture
  (proxy graphic) of its record, which ezdxf draws, as it did from the old
  converter's DXF. All pictures of a file come from one reader call. A
  record with no picture is drawn by ezdxf's own engine and counted in
  `partial`. The
  label's text and a block label's attribute texts are in the registry's
  texts (the old road had the attribute texts in the picture only).
- **WIPEOUT** is a mask with its frame and boundary. A **DIMENSION** whose
  drawn block is not in the file is kept with no geometry (it draws
  nothing) and counted in `partial`.
- **Paper spaces** become layouts; the registry, bones and picture read
  model space only.
- **Not converted, counted by type:** VIEWPORT (paper space windows),
  REGION, 3DSOLID, MLINE, RAY, XLINE, TOLERANCE, SHAPE and IMAGE (the reader
  decodes them; there is no converter here yet), and ACAD_TABLE, MESH and
  PDFUNDERLAY (ezdwg does not decode them). R13 and R14 have no WIPEOUT or
  MULTILEADER decoder.
- **Not carried, as the reader rows do not give them** (no count, as the
  file does not say it has them): MTEXT column data (a text in columns is
  one column); a 2D polyline's own default width and elevation (each
  vertex's start and end width is carried); a gradient fill (a hatch draws
  as the solid fill or pattern the reader gives, or as ANSI31, counted in
  `partial`); `$PDMODE` and `$PDSIZE` (a POINT draws as a dot); the saved
  picture of a proxy or custom-class entity (counted as not converted);
  MTEXT `defined_height`, LEADER annotation fields, a POINT's angle, HATCH
  edge kinds (arcs come as polyline points) and associativity. On the
  1,279 private files: 8 2D polylines (4 with a vertex width), 0 hatches
  with a gradient name, 56,382 POINTs in 1,098 files.
- **The version** in the reply is the one the file was saved in; the
  document itself is made as R2010.
- **What bounds a hostile file:** ezdwg's own limits as it reads (each count
  is checked against the bits left in its record before memory is
  reserved), and one pass a table and one entity a row in the builder (its
  work is linear in what the reader returns). The picture and the bones are
  not linear: they draw nested blocks and a MINSERT's grid in full, so a
  crafted file can cost far more than its size. The real bound is the
  parser's: one job slot, 240 s, one retry, 2 GB. Each saved picture is
  bounded by its own record; records can overlap, so the pictures of a
  file together are not bounded by the file's size. No budget of its own.

**The ezdwg in the parser image.** The image holds our fork's build of ezdwg
(MIT, clean room: `github.com/crossworks-engineering/ezdwg`, branch
`feat/all-reader-fixes`, the commit in `EZDWG_COMMIT` at the top of the
`Dockerfile`): upstream's 0.19.2 reader plus the attributes it dropped, R2004
class names, WIPEOUT, MULTILEADER and the saved picture of an entity,
offered upstream and not yet released there. The `ezdwg-build` stage builds
its abi3 wheel from the fork's archive, pinned by the full commit id and a
checksum, with `--locked`. The wheel still calls itself ezdwg 0.19.2, so
`/healthz` says `ezdwg 0.19.2`; the commit is the image's label
`mantle.ezdwg.commit`, and `/healthz` says `ezdwg_reader ok`. Its licence
(MIT) is in the wheel's `dist-info/licenses` in `/opt/cad`. ONE rule says
the reader is there (`dwg_read.py`'s `reads_dwg`: `ezdwg.raw` has
`decode_entity_proxy_graphics`): with an ezdwg without it, every DWG is
refused and `/healthz` says `ezdwg_reader missing`. The way back to an
official release, once upstream ships these functions: build that release
(its sdist, pinned by checksum) in the stage or pin its wheel in the
`/opt/cad` install, and remove `EZDWG_COMMIT` and the label. No Python
change. CI tests the DWG builder on made-up reader rows with the official
ezdwg 0.19.2 (the self-hosted runner has no Rust to build the fork), and
that the official one is refused; the cases that read the public sample
(`server/parser/cad/tests/data/sample_AC1032.dwg`, ACadSharp's, MIT) run on
the bench and in the parser image. The release probe reads that sample
through `POST /dwg/render` on each arch and fails the release unless the
converter is `ezdwg`, every object is converted or counted, nothing is
read only in part (`partial` empty), its 15
MULTILEADERs have their saved pictures, `/healthz` says `ezdwg_reader ok`,
and no `dwg2dxf` binary is in the image.

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

**The ezdgn in the parser image.** The image holds our fork's build of ezdgn
(MIT, clean room: `github.com/crossworks-engineering/ezdgn`, the commit in
`EZDGN_COMMIT` at the top of the `Dockerfile`): upstream's 0.3.2 plus the V8
data reader (item data, tags, shared cell definitions), offered upstream and
not yet released there. The `ezdgn-build` stage builds its abi3 wheel from the
fork's archive, pinned by the full commit id and a checksum, the way the
`ezdwg-build` stage builds ezdwg. The wheel still calls itself ezdgn 0.3.2, so
`/healthz` says `ezdgn 0.3.2`; the commit is the image's label
`mantle.ezdgn.commit` (`docker inspect --format '{{index .Config.Labels
"mantle.ezdgn.commit"}}' <parser image>`). Its licence (MIT) and the GDAL
notice for its test data (`LICENSE.GDAL.txt`) are in the wheel's
`dist-info/licenses` in `/opt/cad`. The way back to an official release, once
upstream ships the data reader: remove the stage, its COPY, `EZDGN_COMMIT` and
the label, and pin the PyPI version in the `/opt/cad` install (the comment at
the stage says the same). The Python needs no change: `dgn_read.py`'s one
check (`reads_data`) finds what the installed ezdgn reads. CI tests the parser
CAD tier with ezdgn 0.3.2 from PyPI (the 0.3.2 path and the two-build
digests); the data path runs on stand-ins in the same tests, and on the real
build in the image. The release probe reads one small made-up DGN (the fork's
MIT test file, kept in `server/parser/cad/tests/data`) through the parser's
`POST /dwg/render` on each arch, and fails the release unless the reply has
`shared_cells` with an expanded instance and no `data_error`. The maturin
image of both wheel stages is pinned by its multi-arch index digest.

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
- **Shared cells** with ezdgn 0.3.2 are not expanded: each instance is an
  insert of an empty block with the shared cell's name, at its origin.
  Counted in `shared_cells_not_expanded` and `shared_cell_names`. With the
  data reader (below) they are expanded.
- **3D.** A 3D model is drawn in plan: every point is projected to XY. A 3D
  arc or ellipse turns by its quaternion; one in the plan stays an arc or a
  circle, a tilted one is an ellipse with its true axes. `not_flat` (a Z range
  past 2 UOR) and `wild_z` (a Z past 1e9) are counted per model and in all,
  and the note states them when any model is 3D. A 3D text turns by the
  quaternion it stores as the last four of its six orientation values (ezdgn
  0.3.2 gives them too); a text that is not in the plan (tilted, or seen from
  below), or has no orientation, is drawn unturned and counted in
  `text_turn_unknown`. The evidence, counts only, on the private bench: all
  1,875 3D texts hold a unit quaternion there, and for the 149 turned texts
  of three or more characters the turn agrees with the direction of the
  stored range for 142 (read by columns: 75). Not proven: why the 7 differ,
  and a text seen from below (none on the bench). This turn is
  the one change with ezdgn 0.3.2: a 2D file converts exactly as before the
  data reader, and a 3D file differs only in the rotation of its 3D texts. A
  V7 3D file is refused with its reason.
- **Not converted, and counted** by kind and raw element type in
  `not_converted` (never dropped in silence): dimensions, tag elements,
  B-spline curves with their poles, knots and weights, raster frames, element
  types ezdgn does not decode, an arc with no turn, an element with a
  coordinate or size that is not finite or past 1e9, and a component under an
  element that has none of its own. With ezdgn 0.3.2, tag elements and
  item-type data (for example a line-number label's values) are not read.
  `unreached` counts records under no drawn
  element; `repeated` counts references to a record already drawn (drawn
  once). `gap` compares the converter's count with ezdgn's records (a
  converter fault when not 0), and `reader_gap` compares ezdgn's records with
  the graphical objects its own scan found in the file; the note states any
  difference. A text width past 1e9 is drawn at the plain width.
- **The data reader.** An ezdgn build that reads shared cell definitions
  (the one check, `reads_data`) also gives item data and tag elements; with
  ezdgn 0.3.2 none of this is read and the document is as before. With it:
  - A shared cell instance finds its definition by name and range (a file
    can hold several definitions with one name). Every definition the
    drawing uses is built once, before the models, the ones it inserts
    first: one block, walked like a plain cell in its own space, with counts
    of its own (`components_converted`, `components_not_converted`,
    `components_unreached`), not as records of the model. The insert takes
    the instance's matrix as rotation and X and Y scale (a mirror is a
    negative Y scale). The matrix is read by rows: a definition point p
    lands at origin + M p. On the two private bench sets that rule gives
    the stored range of the instance for 2,358 of 2,376 line and shape
    definitions (ezdgn's own check). For the inserts this converter makes
    (texts left out), the box matches the stored range for 52 of 54
    instances turned by an angle that is not a multiple of 90 degrees, and
    lies inside it for 54 of 54 (read by columns: 24 of 54 match), and it
    matches for 126 of 126 mirrored ones. Its texts and tags are
    attributes of the top insert (the insert in the model), placed through
    the matrix.
  - A nested instance is an insert inside the block, at most 8 deep: a
    definition may not insert one that is 8 deep already
    (`nested_depth_limit`), and one that inserts itself, at any depth, is a
    counted cycle (`nested_cycle`), never a loop. The definitions are built
    depth first, each after the ones it inserts, so only the instance inside
    the cycle is counted: a definition that only inserts one of a cycle is
    built after it, whole. Each definition has a weight and a reach. The
    weight is the data of its drawing operations, counted one way for every
    kind: one an operation, one a point, one a character of a text, the
    same for each attribute it places, plus the weight of what it inserts.
    Each kind declares its shape in one table (`OP_SHAPES`), which the
    measure and the document writer both read, so no kind is drawn that the
    weight does not see. An instance in a model is expanded only while the
    file's total weight stays within 120,000 and its reach within 1e9
    master units (`too_large`); `weight` is the file's total. The cap is
    measured on made-up drawings, the whole parser child on one CPU, for
    every kind at its usual element size: circles and arcs cost the most a
    unit (at 125,100, 48 s and 0.77 GB; at 400,320, 156 s and 2.2 GB,
    past the parser's 2 GB); lines, ellipses, polylines, splines, texts,
    attributes and nested inserts cost less. One element far larger than
    usual costs more than its weight says, in ezdxf, with this reader or
    without it: a text of 16,000 characters takes 54 s, one polyline of
    100,000 points 85 s, one spline of 10,000 fit points 2.4 GB. The child's
    time and memory limit is the hard backstop for those, as for any
    drawing. The largest weight of a real file on the bench sets is 36,291
    (14,548 in the unit of fix round 2, which counted a text as 1). Not
    expanded, and counted by reason: no
    definition, a matrix that is not a turn, mirror or axis scale in the
    plan, a model with another unit scale than the first one (ezdgn gives
    the definitions in that scale), too large.
  - Item data on a shared cell instance in a model: each property with a
    value (0 and False are values) is a hidden attribute of its insert (tag
    = property name), at most 256 an element, so the registry's `blocks`
    pairs the values by name. `item_data` counts the instances, properties,
    entries ezdgn gives no data for (`no_data`: over its own limit, or a
    layout it does not know; no data, not an error), and the classes with
    their schema. Item data is decoded within the file's budget of 100,000
    values (each decoded instance takes at least one): once it is spent no
    entry is decoded any more, only counted (`not_read`); ezdgn still splits
    each auxiliary record into its entries to find them. Two
    properties of one name, or a tag of a property's name, give two
    attributes of one tag: `blocks` keeps the first, `texts` holds both,
    and `data_same_tag` counts them.
  - A tag takes its name from its tag set and its value from the element.
    On a shared cell instance, or inside a cell: a hidden attribute of that
    insert. With no host: a hidden text of the value at the tag origin; with
    no origin, a value ezdgn does not decode, or a host that is not drawn,
    it is counted only (`not_placed`). Hidden, as ezdgn does not decode a
    tag's size, angle or display flag: the registry reads the value, and the
    picture does not guess its look.
  - Tags and item data inside a definition are counted once, as
    `in_definitions` (the definition is built once and placed by each of
    its instances).
  - At most 100,000 attributes and texts a file come from this; past it they
    are dropped and counted (`data_dropped`). Tag sets and definitions are
    read once a file and found by key (tag sets through `tag_sets_by_id`
    when the ezdgn build has it). In the registry a DGN's hidden
    values come after its drawn texts, so they never push a drawn text past
    the 20,000 cap (a DWG's or DXF's registry is as it was).
  - One guard (`read_data`) holds the whole first load: ezdgn's open and
    reads, the data reads (a damaged tag set, item entry or definition) and
    the build of the document from them. If any part fails, the first
    attempt is dropped and the file is read and built again as ezdgn 0.3.2
    reads it, and `data_error` gives the error's type name, no text. The
    guard covers more than the data: a file ezdgn cannot open at all, and a
    V7 file (it has no data to read) whose build fails, are read twice
    before they fail, so they take twice the parser's time, within the
    job's limit. A file that converts with 0.3.2 converts with this build
    too, when the second read fits in the job's time the first one left.
    `dwg-reindex --dgn-data` skips such a file (`skipped: data-error`): its
    old database is as good.
  - One guard an entity and one an attribute when the document is made:
    what ezdxf refuses is left out and counted (`entities_refused`), and
    the rest of the file converts. ezdxf 1.4.5 took every character tried
    on the bench in a tag, a value and a text; control characters leave a
    tag anyway, and white space becomes `_`.
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

### Old DGN files get the DGN data (a person starts it)

A DGN read before the DGN data reader (item data, tags, shared cells; see
"What a DGN gives") has a database without that data. The box needs the
parser image with the data reader (our ezdgn build, see "The ezdgn in the
parser image"); on an image with ezdgn 0.3.2 the run stops at the first V8
file. Once the box runs it, a person gives each such file its data, with no
model, from the integrator's machine:

```sh
scripts/box-maintain.sh <box> dwg-reindex --dgn-data --limit=1000                          # DRY RUN: lists each DGN it would read
scripts/box-maintain.sh --files-writable <box> dwg-reindex --dgn-data --apply --limit=1000 # build again
scripts/box-maintain.sh --files-writable <box> dwg-reindex --dgn-data --apply --limit=1000 --after=<id>  # go on, as the last run printed
```

`--dgn-data` takes DGN files only, those with a database or a word too, and
builds each database again, one file at a time, in id order. It writes only
`<files>/.file-dbs/<id>.<first 16 of the sha256>.sqlite` (or the `.none` word),
through the same writer as a first build: a new file renamed over the old name,
so a reader never sees half of one. A word from a parse (no rows, or more rows
than the cap) removes a database of the same bytes; a word from a failure
(`unreadable`, the parser's `too_large`) leaves it, as the old rows may still
be right. The dry run reads no bytes, so it lists every DGN file as `would
read (if a V8 DGN; ...)`: a V7 file or bytes that are not a DGN are skipped
only when the `--apply` run reads them.
The path is the parser and the database writer only: no model call, no Table,
and no new row or job. `dwg-reindex-database.db.test.ts` checks that every
request of the run goes to the parser's drawing route, and that the file's row
(`data`, `updated_at`, its sha256) and the counts of nodes, runs and pg-boss
jobs are the same after the run. It costs parser time: the median parser
child on the bench (ezdgn build 93cfb3f) takes 8.5 seconds for a 2D DGN and
5.3 for a 3D one (the largest 26.5 seconds, 651 MB), so 1,000 DGN files take
about 2 to 3 hours.

### Old DWG files get the reader's result (a person starts it)

A DWG read before the ezdwg reader keeps the old converter's database, summary
and search; nothing reads it again by itself. What it misses is mainly the
MULTILEADER label texts (the old registry never read them). Once a box runs
the image with the reader, a person runs the same rebuild for DWG files once,
by hand, from the integrator's machine:

```sh
scripts/box-maintain.sh <box> dwg-reindex --dwg-reader --limit=1000                          # DRY RUN: lists each DWG it would read
scripts/box-maintain.sh --files-writable <box> dwg-reindex --dwg-reader --apply --limit=1000 # build again
scripts/box-maintain.sh --files-writable <box> dwg-reindex --dwg-reader --apply --limit=1000 --after=<id>  # go on, as the last run printed
```

It is `--dgn-data`'s path with the DWG guard (one `reader` option in
`dwg-reindex.ts`): `.dwg` files only, built or not, one at a time, in id order;
bytes that are not a DWG are skipped; the run stops at the first file whose
reply has no `dwg` record (the old converter), and `--after=<id>` goes past
it. It does not go with `--dgn-data` or another mode. The same proof holds: the
parser and the database writer only, no model call, no Table, no embedding, no
new row or job. Its cost is parser time: the parser child on the bench took a
median of about 6 seconds a DWG at 300 dpi on one core (95th percentile about
14 to 17 seconds, the largest 41 seconds, at most 1.3 GB), so 1,000 DWG files
take about 2 hours.
Nothing starts it by itself: the task is
terminal-only (`cliOnly`; the maintenance route refuses it), not schedulable,
and no agent tool runs maintenance tasks. It is refused with `--table`,
`--orphans` and `--count`.

What it does with each DGN, by the parser's reply, before it writes:

- a V8 file read with the data reader: built again;
- a V7 file (`skipped: v7`): V7 holds none of the data the reader adds;
- bytes that are not a DGN (`skipped: not-dgn`, no parser call);
- a V8 file whose data read failed (`skipped: data-error`): the image is new,
  but the reader read that file the 0.3.2 way, so the old database is as good;
- a V8 file read with the old reader (no `shared_cells`): the run stops there,
  writes nothing for it, prints `STOPPED:` with the counts of the run, names
  the file, and exits 1. On such an image every V8 file would give the same
  data again: roll the image with the data reader, then run again. To go past
  that one file, run again with the `--after=<id>` the stop line prints.

A failed parser call writes nothing for that file (the old database stays),
is counted, and the run goes on. No marker is kept: a second run builds the
same files again (parser time only), so use `--after` to go on from a run that
was cut.

What stays as it was, and why: the file's summary, search passages and facts,
and its picture. They were made when the file was read in full, with model
spend (a summary and embeddings; each kept picture is a vision call when it is
indexed), and this step spends nothing. So search finds an old DGN by its old
text, while `file_sql` and `circuit_trace` read the new data. A new picture
would mean a vision call on new pixels; writing new pixels under the old
description would leave a description that no longer matches. A person who
wants both for one file runs `process_extraction` on it (a full read, with
spend).

### A drawing's symbols

Each customer draws a P&ID with its own symbols. So the render keeps them, in
the file's own database (owner decision, plan of 2026-11-12: no shared library,
no link between databases). After the picture, `--dwg-render` reads every
INSERT in model space (`server/parser/cad/dwg_symbols.py`) and the reply gains
`symbols`, `placements`, `placements_capped`, `symbol_facts` and
`symbols_error`. The file database gets two tabs from them:

- **Symbols**: one row per EXACT key. The key is a hash of the block's own
  geometry: each entity as ezdxf writes it to DXF (every group code, so a
  polyline's widths, a mesh's vertices and an INSERT's ATTRIBs count),
  in block order, with handles and owners left out and numbers rounded to 4
  decimals; a nested INSERT by its own block's key; and the base point. A
  block of more than 5,000 entities (see the caps) is keyed by its name
  instead and has no Shape. It errs on the side of two keys for one shape
  (the same entities in another order, an entity it cannot write), never one
  key for two shapes. Names do not count: on the bench one file named two
  shapes alike and another named one shape twice. `Shape` is the turn-free key
  (the block's points centred on their mean, scaled by the farthest one or
  the largest circle's radius, whichever is larger; sorted distances, sorted segment lengths and the entity kinds): the same
  symbol at another turn, size or mirror has the same Shape. It only groups; a
  rebuild uses Key. `Name` is the block's name in the file, a label. `Kind` is
  `label` for a block that holds only ATTDEF, TEXT and MTEXT: it is not drawn.
  `SVG` is the block drawn once by ezdxf's SVG backend, in a temporary layout
  with one reference at 0,0 on a layer of its own (on, colour 7), on a clear
  ground (colour 7 black, as on the picture). It is drawn with the drawing's
  layer state, so a part on an off layer stays out, as on the picture; a block
  that draws nothing that way (its own layers are off or frozen) is drawn again
  with every layer on, with `Hidden` 1, so the symbol is kept even where this
  drawing hides it. The box is what was drawn, its short side padded to at
  least 1% of its long side (a lone line gets a height), on a page 100 mm on
  its long side. The viewBox (0 0 W H) maps to the box `X0 Y0 Width Height`
  in block units, the insertion point at 0,0: its top left is `X0`,
  `Y0 + Height`, y up in the block and down in the SVG. An SVG with nothing
  drawn on it is a draw error. `Tags` (JSON list) are the ATTDEF tags;
  `Placements` counts its INSERTs. The SVG is not in the file's search index
  (`CAD_FTS_SKIP_COLUMNS`): nobody searches it by its letters, and on the
  bench indexing it about doubled what the symbols add to the file.
- **Placements**: one row per INSERT in model space (an array INSERT gives one
  row per copy, under its handle): `Key`, where the insertion point lands
  (`X`, `Y`), `Rotation` in degrees, `Xscale` and `Yscale` (a mirror is a
  negative scale; an INSERT seen from below, extrusion -Z, is read from its
  matrix; a tilted extrusion, rare on a P&ID, can need a shear these do not
  hold), `Layer`, `Handle` (joins Inserts and Blocks) and `Tags` (a JSON
  object of its ATTRIB values by tag). Every placement has its symbol's row.

A rebuild draws each placement's SVG at X, Y, turned and scaled: the
`drawing_redraw` tool (below). A DGN cell is a block per distinct geometry with its
turn baked in (`dgn_read.py`), so its Key is still the shape a rebuild draws.
Not kept for a rebuild yet: the words of a TEXT-only block (a `label`), and
where an ATTRIB's text sits (only its value is in `Tags`).

Caps, each counted in `symbol_facts` (and said in the table description; it
also counts `hidden`): 40,000 placements (`placements_capped`; an INSERT past
it, an array's copies included, is counted and not keyed or walked, so
symbols are never more than the placements kept), a block of more than 5,000
entities with its nested blocks (an array once per copy; deeper than 8 counts
as past it): a drawing held in a block, keyed by its name (unique in its file)
with no Shape, its geometry never walked and never drawn, as one walk or draw
of it could pass the job's time or memory limit; 256 KB of SVG a symbol (both
`not_drawn.too_large`), 16 MB of SVG a file
(`not_drawn.total_cap`), and no INSERT is keyed and no SVG drawn once 150 s
have passed since the child started (`placements_capped`, `not_drawn.time`).
At 200 s a timer stops the pass wherever it is, whatever the drawing holds
(an array of millions, one polyline of millions of points): both lists are
empty and `symbols_error` says it was stopped, and the registry and the
picture still ship before the job's kill at 230 s. A block that fails to draw
keeps its row with no SVG (`draw_errors`); it never fails the file. An INSERT of a missing
or empty block has no key and no row (`unkeyed`). When the whole pass fails,
both lists are empty and `symbols_error` says why. The pass reaches no model,
and nothing runs it but a render. A drawing's Table (`dwg-reindex --table`)
gets neither tab.

Measured on the private bench (2026-11-12, numbers only, the parser's readers,
one core): 1,378 real drawings (1,288 DWG, 90 DGN), all read. 34,953 symbols
(a median of 16 a file, at most 650 in one DGN) and 119,741 placements; 33,447
SVGs drawn, 3,416 of them `Hidden`, 1,499 labels, 0 draw errors, 7 blocks past
the entity cap, no file at a cap or the time budget. 387 INSERTs had no key (an
empty or missing block). One SVG is at most 208 KB, a file's SVG a median of
99 KB. The symbols pass takes a median of 0.16 s a file (95th percentile
0.3 s, at most 1.8 s), on top of the read. The two tabs add a median of 220 KB
to a file's database (95th percentile 440 KB, at most 2.2 MB), about the size of
the drawing itself; with the SVG in the search index they would add a median of
528 KB and at most 6.7 MB.

### Old drawings get their symbols (a person starts it)

A drawing read before the symbols pass keeps its database without the two
tabs. Once a box runs the image with the pass, a person runs the same rebuild
as `--dwg-reader`, for every CAD file, once, by hand:

```sh
scripts/box-maintain.sh <box> dwg-reindex --symbols --limit=1000                          # DRY RUN: lists each DWG, DXF and DGN it would read
scripts/box-maintain.sh --files-writable <box> dwg-reindex --symbols --apply --limit=1000 # build again
scripts/box-maintain.sh --files-writable <box> dwg-reindex --symbols --apply --limit=1000 --after=<id>  # go on, as the last run printed
```

`.dwg`, `.dxf` and `.dgn` files only, built or not, one at a time, in id order;
bytes that are not the extension's format are skipped (`not-cad`); the run
stops at the first file whose reply has no `symbols` (an image before the pass)
and `--after=<id>` goes past it. It does not go with `--pdf`, `--dgn-data`,
`--dwg-reader` or another mode. The parser and the database writer only: no
model call, no Table, no embedding, no new row or job. The summary, search and
picture stay as they were, as for `--dwg-reader`.

### Redraw a drawing from its symbols (`drawing_redraw`)

`drawing_redraw` (`packages/tools/src/builtins-drawing-redraw.ts`, the pure
builder in `packages/tools/src/drawing-redraw/build.ts`) rebuilds one DWG, DXF
or DGN as a Present canvas from the file's own database. No model call and no
parser call: it reads the tabs read only (tabledb `readTabColumns`) and saves
through the same path as `present_create`, or, with `canvas_id`, as
`present_update` saves a whole source (owner decisions D5 to D7, 2026-11-12).

- Lines: every row of the Shapes tab (below), each LINE, CIRCLE, ARC,
  ELLIPSE, SPLINE and polyline exact, each SOLID and TRACE filled (an arrow
  head, a bar; one more path a layer), each LEADER as its line, and each
  Segments row whose entity (by its Handle) has no Shapes row (one the
  Shapes caps left out, drawn as its chords); one path a layer. All numbers are written from the shown area's
  corner. A database from before the Shapes tab draws every segment
  (polyline bulges and arcs as chords, no circles, ellipses or splines).
  Hatches, points, dimensions and a leader's arrow head are not drawn.
- Each placement is a `<use>` of its symbol's SVG inside a y-up group:
  `translate(X Y) rotate(Rotation) scale(Xscale Yscale) translate(X0, Y0+Height) scale(1 -1)`.
  The symbol is rebuilt from its shape elements (path, line, polyline,
  polygon, circle, ellipse, rect, g) and their geometry attributes only;
  styles, classes, text nodes and anything else are dropped, and the canvas
  draws every symbol in one colour. An outline has no fill. What the drawing
  fills is filled: the letters of a text in the symbol, a SOLID, a solid
  hatch, a wide polyline (the parser's SVG gives such a shape a class with
  no stroke; the builder reads only that from the style). A fill that shows
  nothing (a wipeout) is left out. A placement whose symbol has
  no SVG (a `label`, a draw error) is counted, not drawn.
- Texts are drawn the right way up, at `Height` (font size 1.4 times the
  height, the height of a capital) and turned by `Rotation`. Each is set
  from its own justification point: `Anchor X`, `Anchor Y` is the point on
  the baseline of its first line, and `Align` (left, center, right) the side
  it runs to from there. The browser's font is not the drawing's, so only
  that point is true for both: a centred tag set from its left end drifts by
  half the difference in length. An MTEXT is written line by line (`Text
lines`), `Line gap` apart. A text the drawing underlines (`%%u`) is
  underlined. The label font is Arial or a font cut to its sizes (Helvetica,
  Liberation Sans), so a length is the same on every desk.
  A text with no anchor (a database from before them) is set from `X`, `Y`
  as before, an MTEXT from its top-left corner. A text with no Height (a
  database from before the sizes) gets a size from the gap to its nearest
  text above or below; the answer says how many (`text_note`).
  A one-line text is squeezed or stretched to its `Length` (below): its
  width factor and its font's own width are in that. Not carried: a text's
  own font and oblique angle, an MTEXT's width factor, columns and format
  inside a line.
- The sheet (`sheetOf` in `build.ts`): the largest rectangle the drawing
  draws, as one block (a border and title block placed as a symbol) or as
  four lines whose corners meet (loose lines, a line in pieces, a closed
  polyline). Two tests, the same for both: nothing crosses its edge (a pipe
  crosses the box around a package; nothing crosses a sheet's border), and
  it holds at least half of the rest of the drawing, its own border aside.
  The answer gives it as `sheet` [x0, y0, x1, y1] in drawing units, so an
  app can tell inside from outside with one test; no `sheet` when the
  drawing draws none.
- The frame starts off (`frame: 'on'` starts it on). It is three things:
  the sheet's own border (the block, with its attribute texts by `Block
handle`, or the lines on the sheet's edge); what lies outside the sheet (a
  stream table under the border, a note parked beside it); and the frame
  layers. The first two are items, not layers: they carry one class and the
  canvas has one Frame switch for them (`counts.frame_items`). With the
  frame off the view opens on the sheet; `window` is still the whole area.
- Layers have a class each, by number, so a layer name is never markup. The
  frame layers: a layer whose lines span at least 90% of the sheet both ways
  (of all the line work, when there is no sheet), with a run of lines along
  an axis longer than half its width (pieces on one line that meet are one
  run, so a border split where the title block meets it counts), and no
  placement. `hide_layers` starts others off. Not solved: a title block
  drawn loose inside the border on layers of its own (its texts stay on).
  The canvas has switches for Lines,
  Symbols, Texts, Check boxes (the CAD reader's own insert boxes) and a
  Layers panel; wheel zooms (steps summed, drawn once a frame), drag moves
  the drawn picture and sets the view once on release. The controls set
  their own dark text on a light ground, whatever the frame's theme.
- Symbols are styled in `defs` (a `<use>` copy takes its style from its
  `<symbol>`): one colour, no fill, a stroke 1.5 px wide at any zoom; a
  filled shape (class `f`) has the colour as its fill and no stroke. The
  same is on the elements as attributes, for a renderer that does not carry
  the style into a `<use>` copy. The clear ground ezdxf lays under each
  symbol is dropped.
- Every text, layer name, title and file name is escaped.
- `window` [x0, y0, x1, y1] draws only that part.
- A canvas over the Present cap (1 MB) is refused, and the refusal names a
  window in the middle that fits (built to check). Nothing is cut.
- A database with no Symbols tab is refused with the line to run (below).

Rights: the caller may read the file (the read `file_sql` makes), and the
canvas lands where `present_create` puts it for the caller. Like
`present_create` it has no API key area, so a key limited to some areas
cannot call it. An agent may
redraw, as a person may by hand. The answer holds the canvas id and url, the
counts (symbols, placements, lines, texts, placements with no symbol drawing,
texts with their own height) and the layer list with which start off; no
picture unless `look`.

**Shapes** (a file database only, as Symbols): one row per model-space
LINE, CIRCLE, ARC, ELLIPSE, SPLINE and polyline (2D and 3D; no mesh), and
per SOLID and TRACE (the outline of what the drawing fills: an arrow head,
a bar; a redraw fills a row of these two kinds) and LEADER (the line
through its points; its arrow head is no entity and is not here). None of
the three is in Segments: the pipe network does not read them. `Kind`,
`Layer`, `Handle`, `Path` its exact outline as an SVG path in drawing units,
y up (ezdxf's path of the entity in WCS: arcs and splines as Bezier curves,
written as M, L, Q and C only), its box `Min X Min Y Max X Max Y` (of
the control points, so it holds the curve), and `Dash`: the dash pattern of
its line type, its own or its layer's (BYLAYER), as dash and gap lengths in
turn, in drawing units (the pattern times the drawing's and the entity's
line type scales), joined by a space; a dash of 0 is a dot; empty for a
continuous line, and for a line type with text or shapes in it (ezdxf reads
that as continuous). Bench: 90% of 1,378 drawings hold a dashed shape (every
PFD, 97% of the P&IDs), 7.6% of all shapes, 86% of them by their layer. A
DGN's line styles are not read. Segments has no dash: the pipe network does
not change. A splined POLYLINE runs through
its fit points, not its frame. Segments is the pipe network:
it keeps a bulge or an ARC as its chord and leaves out circles, ellipses,
splines and small closed polylines (a valve drawn loose), and holds nothing
when the network pass gives up on a large drawing (its work budget), so a
redraw that read it alone left pipe ends facing nothing, or lost every line
(bench: three drawings of 11,000 to 28,000 LINEs). Caps: 100,000 shapes and 8 MB of
paths a file (`shapes_capped`, TRUNCATED in the description), 50,000
characters one path (left out, counted in `shapes_left_out`). `Path` is not
in the search index (numbers only).

Texts get `Height`, `Rotation` (degrees counter-clockwise, as the text
reads) and `Width` (an MTEXT's box width, 0 for no wrap; empty for a one-line
text) from `dwg_registry` in `cad.py` for DWG, DXF and DGN, and where a
redraw sets each from (`text_layout` in `cad.py`):

- `Anchor X`, `Anchor Y`: the text's justification point moved onto the
  baseline of its first line, in world units, 4 decimals (`X`, `Y` stay the
  insert point at 1 decimal: on a drawing in metres that is many text
  heights). A TEXT or ATTRIB names one of 15 justifications: LEFT, CENTER
  and RIGHT are on the baseline; MIDDLE is half a height over it, TOP a
  height over it, BOTTOM a third of a height under it (the descender). FIT
  and ALIGNED are set from the middle of their two points. An MTEXT names
  one of 9 attachment points on a block that is one height plus a `Line gap`
  for each further line.
- `Align`: left, center or right of that point.
- `Text lines`: an MTEXT of more than one line, its lines joined by a
  newline: its own paragraph breaks, and a paragraph longer than the box
  `Width` cut at its spaces (measured with the font ezdxf finds for the
  style). Not in the search index (it is `Text` again). `Line gap`: from one
  baseline to the next (5/3 of the height times the line spacing factor).
- `Underline`: 1 for a text with `%%u`.
- `Block handle`: for an attribute, the `Handle` of its INSERT (Inserts,
  Placements); empty for any other text. A redraw switches a border block's
  title texts off with the block.
- `Length`: a TEXT's or an ATTRIB's length along its baseline, in drawing
  units (`text_length` in `cad.py`); empty for an MTEXT. From the file's own
  points where it has them: a FIT or ALIGNED text runs from one point to the
  other, and a text set from its right end or its middle keeps its left end
  too (63% of the one-line texts on the bench). Else an estimate: Arial's
  length of the text at its height, times its width factor, times 1.25 for
  a shape font (`.shx`, the usual CAD lettering: 1.22 to 1.28 times Arial's
  length on 172,899 real texts; a TrueType style runs as Arial, 1.00). A
  length from the points that is not within 3 times the estimate, each way,
  is not kept (a point that was never set). A redraw squeezes or stretches
  the text to it (`textLength`), so the far end of a narrow-style text lands
  where the drawing has it, and a canvas reads the same on every desk.
- A mirrored text (its normal points down, as an attribute of a mirrored
  block has it) is kept as a person reads it: `X`, `Y` and the anchor in
  world units, the turn the other way, the side swapped.
- `Text` is the text as it reads (`plain_line`): `%%u`, `%%o`, `%%k`,
  `%%d`, `%%c`, `%%p` and `%%nnn` codes and a `\U+XXXX` escape are their
  characters (never a control character), in Texts and in the Blocks tab. A
  caret stays a caret.
- Not carried: a text on a tilted plane (a normal that is not straight up or
  down) is set as if it were flat; a MULTILEADER's block attributes have no
  anchor.

A drawing read before them keeps its Texts tab without them, and has no
Shapes tab, until the symbols pass runs on it again (`dwg-reindex --symbols`,
above): it rebuilds every CAD file, so the same run gives old files their
symbols, their text sizes and anchors and their shapes.

The label bench (how the anchors were proved, 2026-11-13): for each text of
1,378 real drawings, a reference taken straight from the ezdxf entity
(justification point, side, turn, size, lines) against the box of the same
text read back from the built canvas with Arial's widths. Scores are in text
heights: the offset of the justification point, the box overlap, turn, size
and content errors, by drawing kind, format and cause class. The made-up
drawings of `server/parser/cad/tests/label_fixtures.py` (every
justification, every attachment point, turned, scaled and mirrored blocks
with attributes, a small PFD and a small P&ID) are the unit tests of both
sides: `test_label_layout.py` holds the parser to what a person works out on
paper, `packages/tools/src/drawing-redraw/labels.test.ts` holds the canvas
to the same rows.

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
ezdwg and `ezdwg_reader`, ffmpeg); 503 while the slot is wedged or the parser is
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

## The PDF page reader

`/pdf/drawing` reads each page with pdfjs alone, in the parser
(`packages/files/src/pdf-primitives.ts`): the drawn lines as segments (with
width, colour and dash), the images, the markups (with their author), and the
text. The text comes from the glyph positions in the page's operator list, not
from pdfjs's own text content: a word is a run of glyphs with no space
character and no gap wider than a space between them, so a tag that is drawn
as letter-spaced glyphs is one word (`Spaced`), and each word has its own box.
A space is a space by its character, never by its glyph code: a subset font
can put any glyph at code 32. Text drawn invisible is kept and flagged
(`Hidden`). Text that lies wholly outside the page is left out, and the page's
`Notes` says `text_outside_page`.

Limits of the glyph reader, stated: a font with a negative size, vertical
writing and a Type3 font are placed roughly (the box can be off the glyphs);
a word gap is judged by one fixed share of the font size, so narrow or
squeezed text can join two words, and bold made by drawing each glyph twice
can cut a line.

The reader counts its characters against pdfjs's text content of the same
page. When the two differ by more than the stated share, the page's `Notes`
says `text_readers_differ`. A page past its glyph budget has no text and its
`Why` says `text`. The words, tags, line numbers and markups of a page go to
the file's database as rows (`docs/file-ingestion.md`, 3b,
`packages/files/src/pdf-rows.ts`).

## The pieces of a scan page

`/pdf/pieces` cuts the text of scan pages into numbered pieces for a vision
model, with no model itself (`server/parser/cad/pdf_pieces.py`, called by
`pdfPagePieces` in `server/parser/src/cad.ts`; the reader of the answer is
`packages/files/src/pdf-sketch.ts`). The caller names the pages, 10 at most.

For each page the job draws one picture at 300 DPI, or less when that would
pass the render cap, in the child process it can kill (`pictures.ts`). The
cutter then:

- finds where the text is (the text areas of `pdf_eye.py`), grows each area
  by 1 mm and joins those that touch: a piece is a line or a small block;
- packs the pieces, in reading order, into at most 4 pictures of 1,568 by
  1,568 pixels, each piece in a thin frame with its number left of it;
- keeps every piece at its own size when they fit. When they do not, all are
  made smaller together, to half size at the least (a piece larger than a
  picture is made to fit by itself, whatever that takes); past that the last
  pieces are left out and listed (`notSent`), and so are pieces past 400 a
  page.

The answer holds, for each page asked for: its status (`ok`, `no_picture`,
`refused` for a white or too large picture or when the cutter had no time
left, `over_budget` when the pictures
before it used the answer's 64 MB), the resolution, each piece's box on the
page and the picture it is in, and the pictures. The client checks that every
piece names a picture of its own page before a model sees any of it.

## OpenCV: the picture reader

The CAD venv (`/opt/cad`) also holds `opencv-python-headless` 5.0.0.93
(OpenCV 5.0.0, Apache-2.0), for image steps on scan drawings with no model.
Its callers are `server/parser/cad/pdf_eye.py`, run by the `/pdf/drawing`
job on a picture of a raster page (`pdfEye` in `server/parser/src/cad.ts`),
and `server/parser/cad/pdf_pieces.py`, run by the `/pdf/pieces` job (above):
classic functions only, no `cv2.dnn`, no model file.

What it gives for one picture, in the page frame (origin top left, fractions
of the picture):

- **The axes of the long lines** (5 mm or longer on paper): the share of their
  length that is horizontal, vertical, on the two isometric axes (30 and 150
  degrees) and on any other direction, with the tilt of the page taken off
  first. The same rule judges a drawn page from its own vector lines
  (`axisShares` in `packages/files/src/pdf-kind.ts`), so a vector page and a
  scan are named by one rule.
- **The tilt** in degrees, from the lines 20 mm or longer; an estimate past 5
  degrees is taken as a drawing with no frame, not a tilt.
- A picture with no ink at all is refused (`empty`): it is a white page or
  a page whose image did not draw, and the two look the same.
- **The ink share** and a **count of text areas**; with `--areas` the boxes
  where text is (not what it says), and with `--segments` the straight lines.
  The job does not ask for these two yet.

The job looks at up to three raster pages of a file (the first, the middle
one and the last), each as one whole-page picture at 144 DPI or less (the
page render cap), with one thread. One render cannot be stopped from inside
its process (pdfjs draws a page in long steps), so the pictures are drawn in
a child process of the job (`server/parser/src/pictures.ts`): it gets the
time left of the read's 150 s, and it is killed then. The pictures it
finished are kept. The child and the look at each picture share one end: the
job's own 240 s, counted from the start of the job process as the server
counts it, less 20 s kept for the answer. A page that cannot
be drawn, a picture the reader refuses, a crash or no time left gives no
answer for that page, and a page that was asked about and got no answer stays
`unsure`. A raster page that was never looked at is named by its size or by
the file's other pictures, or it stays
`unsure`, and the `Kind from` column says which. The CAD tier
tests draw their own pictures (`server/parser/cad/tests/test_pdf_eye.py`).

Its wheel bundles
FFmpeg (LGPL-2.1), OpenSSL 1.1.1 (OpenSSL and SSLeay licences), libvpx
(BSD-3-Clause), libpng (libpng licence), libjpeg-turbo (BSD-3-Clause and
zlib), libwebp (BSD-3-Clause), OpenJPEG (BSD-2-Clause), FreeType (FreeType
licence) and zlib; the full list is in its `LICENSE-3RD-PARTY.txt`. It
installs with `--no-deps`, so installing it does not change the numpy that
matplotlib renders with (the image does not pin that numpy itself). A
private measure set the limits the reader keeps:

- **A pixel limit on every picture step.** A 1.13 G pixel image needed more
  than 9 GB in one step; an A0 sheet at 300 DPI (140 M pixels) needed about
  3.3 GB. The reader refuses a picture over 4096 by 4096 pixels (`too_large`),
  the page render cap, from the PNG header before any pixel is decoded, and
  never scales one down in silence. `renderPdfWindows` in `packages/files/src/rasterize.ts` can draw a window
  of a page as its own picture under the cap; the job draws whole pages
  only today.
- **The thread count** (`cv2.setNumThreads`) is the job's CPU share: one.
- **Lines by the LSD method** (`cv2.createLineSegmentDetector`), not Hough:
  Hough found far fewer of the true lines.

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
and matplotlib, and ffmpeg. Without them on the host those jobs fail typed
(`crashed`, "could not start") and everything else still reads. A DWG needs
our ezdwg build (see "The ezdwg in the parser image"; `pip install` the
fork's archive at `EZDWG_COMMIT`, which needs Rust): with the official
ezdwg every DWG is refused, and `/healthz` says `ezdwg_reader missing`.
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
