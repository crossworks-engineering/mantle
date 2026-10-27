# The parser service

One container, `mantle-parser` (`server/parser`), reads every untrusted file
the brain receives: documents (PDF, Office, OpenDocument, Visio, markup),
spreadsheets and plans as grids, CAD drawings (DWG, DXF, DWF), images for
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
  `server/parser/src/proc.ts` `jobEnv`), and neither tsx nor Node keeps a
  cache (`TSX_DISABLE_CACHE`, `NODE_DISABLE_COMPILE_CACHE`, set in the
  image), so the server itself writes nothing to `/tmp` but the empty job
  root.
- **Network.** The parser sits only on the compose network `parser`
  (`mantle_parser_net`, `internal: true`): no route out (no NAT), and
  `dns: 0.0.0.0`, so Docker's resolver forwards no name outside the stack.
  The app services that send it files (web, api and the workers that run
  turns or tools: telegram, events, runs, push) join that network as well
  as the default one. What the parser can reach is exactly those
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
   PID 1 (Docker's init, tini), the server's launcher chain (`pnpm`, then
   the server: `node` with tsx's loader), what those keep under them
   (tsx's `esbuild` service, pnpm's process-group helper `sh`), and a
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
  `packages/files/src/rasterize.ts`);
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
| `/dwg/render`      | `dwgRender`    | 240 s      | DWG/DXF registry, bones and a model-space PNG    |
| `/dwg/crop`        | `dwgCrop`      | 240 s      | DWG/DXF close-up crops                           |
| `/extract-audio`   | `extractAudio` | 600 s      | a video or audio file to mp3 (ffmpeg)            |
| `/image/thumbnail` | `thumbnail`    | 30 s       | an image to a bounded JPEG                       |
| `/image/vision`    | `visionImage`  | 60 s       | HEIC/HEIF to JPEG for a vision model             |

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
  DWG and DXF are the exception: their workbook, digest and picture come
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
  WebAssembly in a worker thread with no file system.
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

## Running it in development

`pnpm dev` starts the parser natively next to everything else, bound to
127.0.0.1:8095 (`pnpm dev:parser` runs it alone). The brain finds it at
`PARSER_URL` (`.env.example`: `http://127.0.0.1:8095`); a token is
optional. Documents, images and PDFs read with the Node packages alone. The
CAD and audio jobs start child programs: python3 with ezdxf, ezdwf, ezdwg
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
