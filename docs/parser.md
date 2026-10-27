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

- **Memory.** `mem_limit` (default `2g`, `PARSER_MEM_LIMIT`) and `cpus`
  (default `2`, `PARSER_CPUS`) in `docker-compose.yml`. A document that
  blows the limit is killed by the kernel inside the parser, never in a
  brain process.
- **No network.** The parser sits only on the compose network `parser`
  (`mantle_parser_net`, `internal: true`): no route out, no DNS beyond the
  stack. The app services join that network as well as the default one, so
  they reach `parser:8095` and the parser reaches nothing.
- **Little else.** `cap_drop: ALL`, `no-new-privileges`, `pids_limit: 512`,
  no mounted data, no secret but its bearer token. `init: true` (tini)
  reaps a job's children.
- **Restarts.** `restart: unless-stopped`, a `/healthz` healthcheck, and the
  `autoheal` label for a wedged process.

Inside, each job runs in its own process and process group
(`server/parser/src/job.ts`), and the server sends `SIGKILL` to the group at
the job's deadline. The kernel's OOM kill lands on that job process (the
largest), the server answers `crashed`, and the next job starts clean.

## Limits

| Setting                     | Default | What it bounds                                                         |
| --------------------------- | ------- | ---------------------------------------------------------------------- |
| `PARSER_MEM_LIMIT`          | `2g`    | the container's memory (compose)                                       |
| `PARSER_CPUS`               | `2`     | the container's CPU share (compose)                                    |
| `PARSER_MAX_JOBS`           | 2       | jobs at once, each its own process                                     |
| `PARSER_QUEUE_MAX`          | 16      | requests that may wait for a slot; one waits at most 30 s, then `busy` |
| `PARSER_MAX_UPLOAD_MB`      | 1024    | the largest body, enforced while it streams to disk                    |
| `PARSER_CLIENT_CONCURRENCY` | 2       | jobs one brain process sends at once                                   |
| `PARSER_TOKEN`              | none    | the bearer token on every route but `GET /healthz`                     |

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

A refusal is answered `too_large`.

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
ffmpeg, dwg2dxf). The client waits a job's limit plus the 30 s queue wait
plus 30 s for the transfer.

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

**Counted** codes count against the bytes in that job, in the brain process:
the first is retryable (a loaded box can be slow once, a restart can drop
one connection), the second is terminal, and a terminal job is refused at
once without asking the parser again. One bomb costs the parser at most two
jobs of each kind per brain process, and a restart in between gives it one
more try, never a loop. Counted per job, a document whose pictures run out
of time still has its text read.

What each caller does with them:

- **The extractor** (`server/api/src/agent/extract/load-body.ts`): a
  retryable failure fails the extract job, and pg-boss retries it. A
  terminal one records the `document_unreadable` skip
  (`data.extract_skipped`), so the drain does not pick it up again. `failed`
  and `unsupported` index the title, as before.
- **Side passes** (pictures, auto-table): only `busy` and `unavailable` fail
  the job; any other failure is logged and the text body is indexed anyway.
- **A PDF with a text layer, read natively by preference**: the text layer
  is kept whatever the parser answers.
- **The scanned-PDF OCR pass**: a first refusal or `busy` is the
  non-terminal `pdf_unreadable` skip the drain retries; `too_large` is the
  terminal `pdf_too_large`. The native model read of a PDF that found no
  text is remembered per bytes in the process, so a retry does not pay for
  it again (at most one extra read across a restart).
- **A chat turn** with an attachment says the file could not be read.

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
  the mail itself; an attachment's contents go to the parser like any file.
  An email's HTML body is turned into text by the parser (`/text`).
- **Writing**: exceljs and jszip build workbooks and app packages, and
  saxes sanitizes SVG the brain produced (`packages/content/src`). Those
  libraries never read an untrusted file in the brain.

The rule is enforced by lint: `eslint-rules/readers-in-parser.mjs` refuses
an import of a reader module (`@mantle/files/readers/*`, or a reader file
inside `packages/files`) or of a parsing library (pdfjs, mammoth, anydoc,
heic-convert) anywhere outside `server/parser`, the readers themselves and
tests. A new format means a new reader under `@mantle/files/readers` and a
parser route, never a reader in the brain.

## Gaps

- **Legacy Visio (`.vsd`)**: Tika read its text; nothing reads it now. The
  extractor asks for a `.vsdx` export. `.vsdx` reads in full.
- **Pictures in `.xls` and `.xlsb`**: the text and grids read, the embedded
  pictures do not.
- **`video_ingest` by link**: removed with `yt-dlp`. The tool takes an
  uploaded file only (`file_node_id`); for a video on the web, download it
  and upload the file.

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
