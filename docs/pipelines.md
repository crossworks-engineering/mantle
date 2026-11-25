# Pipelines

A pipeline reads a file and writes the file's database: the read-only SQLite
that `file_sql` reads (`packages/content/src/file-database.ts`). In phase 1
the only pipelines are the readers built into the core. Their code did not
move. New are one lookup that picks the reader, and a stamp in every
database that says which reader wrote it.

The same bytes give the same tabs as before the registry.

## The contract

A pipeline has one of four roles. A Router names the kind of a file, so
the right Reader gets it. A Reader reads the file and writes its database.
A Transformer reads tabs of the database and adds its own tabs; it asks no
model. An Agent asks a model about a file and adds one tab with the
answers; one is built, `iso-title-block` (see "Agents" below). In the code
and in the data a Transformer is `after`: the manifest
field `match.after`, the stamp key `pipelines_after`, the word
`kind: 'after'`. One function gives the role of a manifest, `roleOf`
(`packages/files/src/pipelines/builtin.ts`): there is no `role` field.

`packages/files/src/pipelines/contract.ts` holds the types: the manifest, a
step's request and result, the calls a step may ask for, and the stamp. They
are pure types and constants, so a later phase (own code, steps in the
parser, calls through the tool gate) adds code and breaks nothing.

A built-in reader is one step with one call, `file_tabs_write`. In phase 1
that call is done in this process by `writeRowsOrWord`. Its input is the
parse result of today. A result of `sheets` or `none` is a step with status
`ok`; `not-plan` and `not-drawing` are `not_mine`, with no call. A thrown
error stays a throw, and the extract retries it.

## The built-ins

`packages/files/src/pipelines/builtin.ts` lists them. A pipeline is built in
because it is in this list. Each extension has exactly one reader. The list
is the input of the registry (see "The registry" below), the one place that
gives the pipelines of a box, the reader of a file's database among them.
The file types that get a database (the registry's `dbExts`) are the union
of the readers' extensions. The list also holds
two Transformers, `site-tags` and `links` (see "Transformers" below): each
reads a reader's database, and is no reader. And it holds one router, `pdf-router`
(see "The router" below): it names the kind of a PDF, and is no reader
either. And it holds one Agent, `iso-title-block` (see "Agents" below): it
is no reader of its extensions, so it adds nothing to `dbExts`. Their
reader is `drawing-raster`.

| id                | Extensions                     | Weight | Shapes it promises         | Runs             |
| ----------------- | ------------------------------ | ------ | -------------------------- | ---------------- |
| `sheet`           | xlsx, xls, csv                 | light  | none                       | package          |
| `plan-mspdi`      | xml                            | light  | none                       | package          |
| `pdf-router`      | pdf (a router)                 | light  | none                       | package          |
| `drawing-pdf`     | pdf                            | light  | `pdf-file-v1`              | package          |
| `plot-dwf`        | dwf                            | heavy  | none                       | package          |
| `drawing-cad`     | dwg, dxf, dgn                  | heavy  | `drawing-v1`, `circuit-v1` | package          |
| `drawing-raster`  | tif, tiff, smf, 000            | light  | none                       | package (Python) |
| `mail`            | eml, msg, mbox                 | light  | none                       | package          |
| `site-tags`       | after a reader                 | light  | none                       | package          |
| `links`           | pdf, after a reader            | light  | none                       | package          |
| `iso-title-block` | tif, tiff, smf, 000 (an Agent) | heavy  | none                       | package          |

Each built-in has a `description` (`PipelineManifest.description`): one or
two plain sentences on what it reads and what it writes, 1 to 300
characters (`PIPELINE_DESCRIPTION_MAX`; `builtin.test.ts` holds it). It is
not in the version pin: it says nothing about the rows, as an option's
`help` does not. The router `pdf-router` uses the same field. The rule for
phase 3: a pipeline or a router added through MCP with no description is
refused.

Each one runs at upload. The Agent runs as a job of its own, after the
Reader's build of an upload, and on demand. Since MV5
and MV6 every built-in is a package; a
`core` one (`runtime: 'core'`) would run in the core, and none is left.
A package (`runtime: 'bun'`) is a folder in the image that the parser runs
(see "The runner of packaged pipelines" below): `plan-mspdi` is one since
the move-over step MV1, `plot-dwf` since MV4, `sheet` since MV3,
`drawing-cad` since MV6, `pdf-router` and `drawing-pdf` since MV5. The
special cases stay where they were: the cap on delimited text before any
read, the XML plan check (on the file's head in `auto-table.ts` and
`dwg-reindex.ts`, and on the bytes in hand in `parseFileSheets`, for every
caller), the CAD sniff (on the bytes in hand in `parseFileSheets`), a PDF
that is a document, and a PDF in the data files list only when asked.

## The registry

`boxPipelines(ownerId)` (`packages/content/src/pipeline-registry.ts`) is the
one place that gives the pipelines of a box. Every consumer asks it: the
upload's read (`auto-table.ts`), the build and the patch
(`file-database.ts`), the list and the set, `pipeline_test`,
`pipeline_run`, `pipeline_reread`, the sketch read, `file_sql` and the Data
view, and the tasks `pipeline-reread`, `pipeline-compare` and `dwg-reindex`
(whose scripts ask it for the brain's own account and give it to the task).
A consumer with no owner in hand gets the answer, or the part it needs
(`dbExts`, `readerFor`), from its caller as a parameter. It has no second
way to the list.

The answer holds the list (`all`: the built-ins in their order), `byId`,
`readerFor(ext, kind)`, `routerFor(ext)`, the Transformers (`after`), the
ids a person acts on (`acted`: all but the routers), the file types that
get a database (`dbExts`), and `problems`: the pipelines that do not run,
with a sentence (empty while the list is the built-ins). It is built on
every call, with no cache. The helpers of `builtin.ts` (`readerFor`,
`routerFor`, `dbExtsOf`, `readersByExt`) take a list; the registry gives
them its own.

The list is the built-ins, then the own pipelines of the box by id
(section "Own pipelines"). The registry reads only `pipeline.json` of each
own row (`ownManifests`, `packages/content/src/pipeline-state.ts`) and runs
the one manifest check on it each time. Only that text crosses the wire;
Postgres still reads the whole stored package of each own row to take it
out, a cost accepted under the 5 MB cap (no column of its own). A built-in always wins an id or an
extension. An own row that fails the check, clashes, or sits on a curated
box is in `problems` with its sentence: it is in `all` and `byId`, so the
list shows it and the Admin can remove it, and in nothing that runs
(`readerFor`, `dbExts`, `acted`). A row whose id a built-in took is in
`problems` only: its id is the built-in's.

**Not consumers, on purpose.** The parser: its index is the image's
(`server/parser/src/pipeline-index.ts`). The CAD run (`cadRun`,
`packages/files/src/dwg.ts`) takes the id and version of its job from the
built-in `drawing-cad`: a built-in always wins its id and its extensions,
and its run also serves the text pass of a drawing, which has no box in
hand. The
input schema of `pipeline_test` takes the id form of `pipeline_set`, so an
own id and a draft's id pass it.

**The one manifest check.** `checkManifest(manifest, source)`
(`packages/files/src/pipelines/manifest-check.ts`) holds the rules of a
manifest for a built-in and an own pipeline alike, and gives a plain
sentence for the first rule broken. `builtin.test.ts` runs it on every
built-in, so a release holds it; nothing checks a built-in again at run
time. The common rules: the id form of `pipeline_set`, a name, a plain
description of 1 to 300 characters, an `x.y.z` version, this contract's
`api`, a `kit` no newer than this one, 1 to 10 lower-case extensions,
option specs the option check can use (a default its own spec keeps), and
`needs.timeMs` from 1 to 240,000. An own pipeline in phase 3 is also a
Reader (no router, no claimed kinds, no `match.after`), at upload, on Bun or
Python, with no `needs.workers`, no tool but `file_tabs_write` and no
`produces.shapes`. `needs.memoryMb`, `needs.weight` (beyond its two words)
and `match.magic` are taken and do nothing. The entry of an own pipeline is a
plain path inside the package (the one path rule, `badNewPath` in
`@mantle/std`), a `.ts` or `.js` file on Bun and a `.py` file on Python.

## Shapes

`packages/files/src/pipelines/shapes.ts` lists the known tab shapes: the
tabs and columns a tool reads. A tab or column is needed only when its tool
fails without it today; the rest is read when it is there. Not so for the
Inserts and Texts tabs of `circuit-v1`: `circuit_trace` selects their
columns by name, so with one column missing it leaves that whole tab out of
its trace. `shapesOf` names the shapes a list of tabs carries.

The body of a Transformer (`afterBodyOf`) holds each tab of its shape that
the file has, needed or not, with the shape's columns. A shape with
`listedIn` also sends every tab named in that column of that tab, each with
all its columns: `pages-v1` names `Tables` and `Tab`, so a book's table
tabs, which the Reader names itself, reach Links. A tab the pipeline writes
is never sent. The body is read in one open of the file (`withTabScanner`
in `packages/tabledb`), so a file of thousands of tabs reads its schema
once.

## The stamp

Every file database gets four `_meta` keys when it is written:

| Key                | Value                                                                     |
| ------------------ | ------------------------------------------------------------------------- |
| `pipeline_id`      | the built-in's id, for example `drawing-cad`                              |
| `pipeline_version` | its version, for example `1.0.0`                                          |
| `pipeline_api`     | the contract version, as text                                             |
| `shapes`           | the shapes it promises that the tabs carry, joined by `,`; empty for none |

The stamp is written inside `writeRowsOrWord`, so every caller of
`buildFileDatabase` (the extract, the sketch read, the rebuild) gets it.
`readFileDbStamp(fileId, sha256)` reads it back.

- A word file (`.none`) has no stamp. Its format is one word, and it stays so.
- A database built before stamps has none. `readFileDbStamp` gives null for
  it, and every reader of the stamp takes null as "read before stamps".

## When to raise a version

Raise a built-in's version when the rows its reader writes change: a new tab
or column, a changed value, a fix that reads more of a file. Raise it too
when its `match` or `produces` changes, or a needed tab or column of a shape
it promises. Older files then show as read by an older version, and a person
can re-read them.

A new claim (`match.kind`) is in the pin, but it changes no row. The router
step put the kinds `drawing-pdf` reads in its `match.kind` and kept its
version: a new version would make every PDF database older, and the re-read
of a PDF drawing is refused, so that count could not go down. The pin of
`drawing-pdf@1.0.0` was made again.

An optional tab or column added to a shape does not need a new version: a
tool that starts to read one more column reads it when it is there. The rows
did not change, so no file needs a new read.

The version pin, `packages/files/src/pipelines/builtin.pins.json`, holds one
line for each `id@version`: a hash of what the version promises. That is the
manifest's `match` and `produces`, and for each promised shape its id, its
needed tabs and their needed columns. Its test fails when one of them
changes and the version did not. Raise the version and add a line; keep the
old lines. The pin cannot see a change deep in a reader's code: a fix that
changes rows but not the manifest needs a person to raise the version.

## The list: the route and the tool

`GET /api/pipelines` gives the Settings screen its list, and the MCP tool
`pipeline_list` gives the same list: both call `listPipelines`
(`packages/tools/src/pipelines.ts`). The answer is a `PipelineList`
(`@mantle/client-types`, `dto/pipelines.ts`): the contract version, one
row for each pipeline of the box (the registry), and `countsPartial`.
A row's `problem` is why the pipeline does not run on this box, in one
plain sentence, or null: always null for a built-in. A server before the
registry sends no `problem`; a client reads a missing one as null.

A row says what the pipeline reads and promises, its `description`, and
two counts: `files`,
the files with a database it read, and `older`, those that are not current
with the options in force: read at an older version, before stamps, or with
other options (`readerIsCurrent`). For a Transformer, `files` are the
databases with its entry in `pipelines_after`, and `older` those whose entry
is not current (`afterIsCurrent`). The counts come from the stamp only: no
tab is read for a count. No reader promises `texts-v1`, so a drawing that
Site tags never patched is not counted for it. The counts come from one
look at the folder of databases. They are the whole box's, as `box_status` and `brain_capacity`
count: the file rows are read on the system pool after the settings area
check (`areaSystem`), so a file in a workspace the caller is not in counts
too. Each stamp is read from its database's `_meta`. A file counts when its database at its
own bytes is there; a database built before stamps counts for the built-in
of its extension. The look stops at 5,000 files and then sets
`countsPartial`. One look is kept for 30 seconds, as `box_status` keeps
its answer, so many calls make it work no harder. The look keeps what it
saw of each stamp, not the counts: the compare with the options in force
runs on every call, so the count follows a set at once. With no files mount in
the process, the counts are null.
The answer holds numbers only: no file name, no id, and never a tab.

`versions` gives `files` by the version in their stamp, highest first, and
`null` last for the files read before versions were recorded (a database
with no stamp). For a Transformer they are the versions of its entries
in `pipelines_after`. They come from the same look as `files` and `older`,
with the same cap and `countsPartial`.

One function decides "older": `pipelineReadOf`
(`packages/files/src/pipelines/stamp.ts`). From the stamp a look saw of one
file (`seenOf`, `packages/tools/src/pipeline-look.ts`) and the options in
force, it says whether a pipeline read the file, at which version, and
whether it is older (`readerIsCurrent`, `afterIsCurrent`). The counts and
the re-read of the older files both call it, so the number on the screen is
the number the button takes.

A row's `kind` is the role: `reader`, `after`, `router` or `agent`, from
`roleOf`. `asks` is the most asks of each AI worker for one file, from the
manifest's `needs.workers`; it is empty for a pipeline that asks nothing.
An Agent's row also has `asksToday`, the paid asks of all Agents of the box
in the last 24 hours, and `dayCap`, the most the box allows; both are null
on every other row. The list reads the count one time for all rows
(`pipelineAsksToday`), and only on a box with an Agent. An Agent's `files`
and `older` are counted as a Transformer's: by its entry in
`pipelines_after`.

`runs` and `lastRunAt` are the runs of the pipeline on this box (see "The
runs of a pipeline"). They are read with the state on every call, never from
the 30 seconds of the counts.

Only an Admin with the settings area sees it. The route's policy (area
`settings`) is the check, and the tool's scope is the same area. The tool
is MCP only: no tool group holds it in phase 1. It is not `systemWhole`:
it runs in the caller's scope, and only its count of the file rows goes to
the system pool, as `brain_capacity`. An API key
reaches the tool only with every area and a login that has the settings
area; no key reaches the route, as keys reach only `/api/v1` and
`/api/mcp`.

## The router

A router names the kind of a file. Then the reader that claims the kind
reads the file. A router writes no tabs. It has no database and no options
of its own: it gets the read's options (the reader's), and the PDF router
uses only the title block box among them.
It is never run by itself: it runs only inside the read of a file, and its
runs are counted there (see "The runs" below).

In this step there is one router, `pdf-router`, built in. Its manifest has
`router: true` and `match.ext` pdf. Its rules are the PDF kind rules of
`packages/files/src/pdf-kind.ts` (`PDF_KIND_RULES_VERSION`, in the File tab
as `Rules version`).

**The kind rules 2 (P3, 2026-11-17, `pdf-router` 1.0.1).** Three rules
changed, each with no model, each with a made-up fixture:

- A slanted line in a fill (a 10 mm square of paper with 8 lines or more:
  hatching, a solid logo drawn as strokes) does not count in the axes. A CAD
  isometric plotted as strokes with a hatched logo was `other_drawing`; it
  is `isometric` now. Lines on the axes always count.
- A file read whole, with no drawing page, whose pages are typed pages but
  for a few (`DOCUMENT_MIN_SHARE`, 3 of 4) is a `document`: a report or a
  slide deck with a chart page was `unsure`.
- A file whose pages all read as blank, and that holds an image too large
  to open, is a `scan` (the sheet is one large picture); it was `unsure`. A
  file with a typed page beside it stays as before: the image may be on any
  page. No renderer of the box draws that image either
  (`PDF_MAX_IMAGE_PIXELS`), so neither the sketch read nor a picture Agent
  sees it.

On the 20 PDFs of the P0 score of one site: kind right 14 of 20 before, 16
of 20 after. Still wrong, by cause: a born-digital chart with a full-page
picture behind it reads as a scan (a scan with a drawn overlay looks the
same, so the rule stays); two pages of business diagrams on a tabloid sheet
stay `unsure` (an equipment drawing has the same counts; the decider's
question); a flow diagram drawn as strokes is `other_drawing` (`pfd` and
`pid` need text, or the decider); the image too large to open is now a
`scan` where the list says `isometric`.

**The kinds.** The router can name ten kinds (`produces.kinds`, the list
`PDF_KINDS`). The rules name six: `pid`, `isometric`, `scan`,
`other_drawing`, `document` and `unsure`. For an unsure file the decider may
also answer `pfd`, `equipment_drawing`, `datasheet` and `table`. Those four
carry the flag `decider`: only the decider's answer names them.

**The ask.** An unsure PDF asks the decider at most once, at upload, as
before: its step gives one call at most, and the core asks one a file
(`routePdf`). The manifest's `needs.workers` is `{ decider: 10000 }`
(PIPELINE_ASK_PAGE_MAX) since 1.3.0: the cap of the page asks of part 2
(see "Page types" below).

**The answer: more of a drawing, never less.** In `live` mode, at or over
the use's floor, the decider's answer is the kind of an unsure file, by the
one rule `decidedKind` (`packages/files/src/pdf-drawing-sheets.ts`, used by
the router's step 2 and by the File tab). The answer can only make an
unsure file more of a drawing: `pfd`, `pid`, `datasheet` and the others.
Its `document` is never used: the file stays `unsure` and keeps the
database it has with the decider off. No answer (the use is off, the call
failed or timed out, too little text) keeps it too. So turning the decider
on can add structure and never removes a database. The answer is still
recorded: the File tab holds `Decider answer`, `Decider confidence`,
`Decider mode` and `Decider model` beside `Kind`, and the upload's trace
holds the `decide_pdf_kind` step and its cost. A PDF the rules name never
asks. No setting turns this off.

**The claim.** A reader claims kinds with `match.kind`. `drawing-pdf`
claims nine: every kind but `document`. An unsure PDF gets its database, as
before.

**The lookup.** `readerFor(ext, kind)`
(`packages/files/src/pipelines/builtin.ts`):

- A file type with a router: the router names the kind, then the reader
  that claims it reads the file.
- No reader claims the kind: the readers that claim no kind, in the list's
  order. For a PDF there is none, so a document gets no database.
- No router, or no kind named: the ranked list, the reader of the
  extension.

**Two jobs, one read.** The router and the reader are packages since MV5
(see "The PDF set" below): the router's job reads the page facts and names
the kind, then the job of the reader that claims it makes the rows
(`readRouted`, `packages/content/src/file-database.ts`). The router gives
its page facts back (`facts` in its result, at most
`PIPELINE_FACTS_MAX_BYTES`, 32 MB as JSON), read with the title block box of
the read's options, and the core sends them as the body of the reader's
job, with `facts: true` in the reader's first state. The reader then builds
its tabs from them and does not open the file. So a PDF is read one time, a
drawing and a document alike. The facts go only to a reader that claims the
kind (`match.kind`; an own Reader claims none). Facts past the cap are left
out, and the reader reads the file itself, as before. A read again with the
stored kind runs no router, so its reader reads the file. Only the rules
name a document. It gets no database and no name, so the next extract
reads it again, which costs no model.

**The runs.** The router counts a run where it names the kind in a real
read: an upload, `dwg-reindex --pdf`, and a run on demand or a re-read of a
PDF with no database of its bytes. A document counts too. A read again of a
PDF that has a database keeps its stored kind, so the router does not run
and counts none; but a stored kind from older rules (and not the
decider's) is named again by the router, with no ask, and that run counts
(see "The PDF set as packages"). A test counts none: it passes no `count` to
`parseFileSheets`. The sketch read counts none: it is the reader's run. The count is the `runs` and `last_run_at`
of the router's `pipeline_state` row, by `countPipelineRun`, as for a
pipeline. No new column. A failed count is logged and never fails the read.

**Page types (part 2, M3 and M4 of plan page c607711a).** At an
upload, after the Reader's run (before it on a live box, below), the core asks the type of every page
(`pdfPageKindsOf`, `packages/content/src/pdf-read.ts`): in page windows of
25 pages (`PDF_PAGE_WINDOW`, cut by qpdf), one parser job of the router's
step a window. A request with `pageFrom` is such a window: the step reads
its page facts with no model, draws each page as a grey JPEG of 1,024 px
long side in the parser's pdfjs child (large images too, as the Agents
draw them), and gives one `decider` call a page that is not blank with the
8 fields of the page ask; its `state` names
each page with its rules kind and why a page has no ask (`blank`, `not
drawn`). The core checks each ask (`pdfPageAskOf`, the one check of what
leaves the box), asks 4 at once, and puts the answers in the Reader's tab
`Pages` by `Page` (`withPageKinds`, `packages/files/src/pdf-page-kinds.ts`,
which also adds `PAGE_KINDS_NOTE` to the description, on every path),
for both Readers: `Kind` (the rules' kind of the page; the drawing reader
writes its own), `Kind from`, `Decider kind` and `Decider confidence` (the
summed chance of the answer's route, docs/decisions.md `pdf_kind`). In
shadow the route of the file does not change.

- **Where.** At an upload's extract (the file database pass, where its
  bytes have no database), and at a person's run of one file (below), for a file that may have model work, on a box
  whose decider params hold `uses.pdf_kind.pages: true` (an operator's key
  that the manifest never ships) with `pdf_kind` on (`pdfPageDeciderOf`,
  `server/api/src/agent/extract/pdf-kind.ts`; docs/decisions.md `pdf_kind`
  has the operator step). A client
  box asks none: no window is cut, no picture drawn, and its rows are as
  before (no new column). A read again (`pipeline_reread`, a Reader's
  `pipeline_run` of a folder, `file_reindex`, the `after` chain's run) and
  the sketch read ask none: they read the page types of the tab `Pages`
  back and put them in again (`pdfReadAgainOf`, `storedPageKindsOf`), fail
  closed.
- **A person's run of one file (Jason's Q2).** `pipeline_run` of a Reader
  with the `file_id` of a PDF (the tool, or the Run button of one file) sends its
  notify with the page mark (`<pipeline>:<node>:pages`, notifyPipelineRun's
  `pages`; the job's field `pages`). Nothing else sends it. That job, and
  only it, gives the read again of a PDF the page asks, behind the same two
  checks (`pdfPageDeciderOf`). The read asks only the pages with a row and
  no stored answer (`pdfPageKindsOver`): a page with `Decider kind`, or
  `rules: blank`, is never asked again, and its stored row stands over the
  new read. So the pages of an older file get their types, and a second
  run asks nothing. The same caps hold (the file's cap, the day cap, the
  3-in-a-row stop, the breaker), each ending in the rules; kept answers are
  free. The read's write is the read again's: one conditional write, not
  when the read is poorer (`pdfReadPoorer`) or the database changed, and
  every Reader and Agent row stays. A write so refused keeps the paid
  answers in the answer cache, so the next run takes them free.
- **`Kind from`.** `decider` (live: a used answer, at or over the floor;
  `Kind` is then its kind, over the Reader's own), `rules: shadow` (in
  shadow, every answer: only recorded), `rules: low confidence` (live: an
  answer under the floor), `rules: no answer`
  (asked, none came: a failure, the breaker, the use off), `rules: cap`
  (past the file's cap, the router's `needs.workers.decider`), `rules: day
cap` (past the box's day cap of paid asks), `rules: not drawn` (no picture:
  the page could not be read, drawn or cut, or is under the decider's
  smallest picture, or its picture is white though an image covers it: a
  scan that did not draw) and `rules: blank` (a white picture of a page no
  image covers: free). Which answers are used is worked out at every read
  with a decider (`pageKindsAt`), from the stored sum, so an answer of a
  shadow week is used once the box is live, with no ask. A page of a Reader
  that had no part 2 keeps its own word (the drawing reader's `rules`,
  `picture`, `other_pages`).
- **Caps end in the rules, never in a wait.** Past the file's cap, the day
  cap or a stop, no window more is cut and the pages left keep their rules
  kind, with the word. Nothing asks them again by itself. A window the
  parser cannot cut or read is `rules: not drawn`; a busy parser fails the
  extract as every job (it is tried again, and the answer cache holds the
  answers paid); any other failure ends part 2 with what it has.
- **One ask a page, once for these bytes.** The answers are in the database
  of the file's id and bytes, so a read again never asks; inside the
  extract each answer is kept in the answer cache too (its key holds the
  question, `PDF_PAGE_QUESTIONS`: its text and options, not the router's
  version, so a release between the tries keeps them). An extract tried
  again takes the kept answers first, free: only a real call takes day-cap
  room and a place in the file's cap. The day cap stops the run only after
  a window that turned a page away, so a retry with the day cap full still
  takes every kept answer.
- **Only pages with a row.** In shadow part 2 runs after the Reader's run,
  so it asks only the pages that have a row in the tab `Pages`; a window
  with no such page is not cut. A live read asks before the Reader, over
  every page (or the stored pages, on a person's run): a page with no row
  after the Reader, or a read that fails after its asks, keeps its answer
  in the answer cache only, and a try again takes it free.
- **Live (M4).** On a box whose `uses.pdf_kind.mode` is `live` (the
  operator's, box by box; the manifest ships `shadow`) the page asks come
  before the Reader, and the lanes of the pages name it
  (`pdfFrameKindOf`, Jason's Q4): pages with ink vote by the route of
  their `Kind` (a used answer's, else the rules kind: document, table,
  datasheet office; the drawing options and `scan` drawing; `unsure`,
  `none` and blank pages no vote). Office wins or ties: the book. Drawing
  wins: the kind stays when it is a drawing kind or `book` (the book reader
  reads in page windows, the drawing reader cannot; a book's drawing pages
  go to the sheet read by lane), else `unsure`; a drawing kind is never the
  frame's own pick, so a raster set the rules left `unsure` keeps the
  readers of `unsure`. With no used answer the kind is
  as named before. Only a read with the page decider (an upload, a person's run of one PDF) asks or works out
  which answers are used; a read again with no ask names the frame again by
  the stored used answers (`decider` rows), so it keeps a live read's frame,
  a reroute by newer rules too. A read again whose File
  tab names another Kind (a new frame) is poorer only with more pages not
  read whole (`poorerThan`).
- **The Agents by lane (M4).** The lane of a page is the route of its used
  answer, else its file's lane (a book: office; else drawing), so with no
  used answer every Agent reads as before (`pageLanesOf`,
  `packages/content/src/book-pages.ts`). PDF page read (`pdf-page-read`,
  1.3.0) reads the office-lane pages that need a paid read: a book's marked
  pages but those of the drawing lane, and a drawing's office pages with no
  text layer (Class `scan`, `raster_with_text`, for the Scan reader). PDF
  sheet read (`pdf-sheet-read`, 1.2.0) reads the pages the core names
  (`state.drawingPages`), the first 10: a book's drawing-lane pages, and in
  a drawing file every page but those the Scan reader reads. A file with
  no page of an Agent's lane runs no job for it, nor a PDF past the size
  pdfjs opens for an Agent with no windows. The page text PDF page read
  reads in a drawing file goes to the file's text as any Agent's (its
  Reader gives no pages for passages by page).
- **Pictures kept (M4, Jason 2026-11-23).** A graph, a chart, a sketch
  chart or a cover page stays in the office lane, and its picture is kept
  so an LLM can look at it at question time: on a live box, a page whose
  route sum is under `PDF_PAGE_PICTURE_BELOW` (0.75), a typed page too, is
  read by PDF page read with vision and its picture is saved with that
  text, as a scanned book page. Its text layer stays: an Agent's page text
  stands over the Reader's only on a page the Reader left to vision
  (`Method` `vision`); on any other page (a kept picture, a drawing page of
  a book) the Agent's text comes after the Reader's (`filePagesOf`), so the
  file's text and passages keep both.
- **An older paid vision read (Jason 2026-11-23).** A PDF whose File tab
  says `Vision read` (the sketch read) is skipped by every read again, a
  person's run of one file too (`pdfReadAgainOf`, `sketch`), so its paid
  read stays as it is. To give it page types and the M4 lanes, a person
  uploads it again (same name, same folder): the old version goes to file
  history with its paid read, and the new bytes get the page asks.
- **Limits.** Room is read once a window, so files read at the same time
  can pass the day cap by up to 25 asks each (the cap paces, it does not
  lock). Each page ask is one trace step (`decide_pdf_kind`): a 1,000-page
  upload has 1,000 steps in its trace.

**The list row.** `kind` is `router`. `reads` gives the file types, `names`
the kinds with their flag, and `description` and `workers` the ask. `runs`
and `lastRunAt` are its runs. `files`, `older` and `versions` are not
counted (null, null, `[]`): it has no database of its own. A reader's row
gives `claims`: its `match.kind`, or `[]` for a reader that takes its files
by extension alone.

**The refusals.** A router has no options, no workspace list, no run and no
re-read. `pipeline_set`, `pipeline_run`, `pipeline_reread` and
`pipeline_test`, and their routes, refuse it with one sentence
(`ROUTER_REFUSED`). There is one check in each, on the manifest
(`isRouter`). A refusal is a 400. A router is never a choice of a dry run.

**Not in this step.** An own router and a new kind by an Admin (phase 3), a
router for another file type, a count of files for each kind, and a test of
the router by itself.

## The Data view

The files routes (`GET /api/files/files` and `GET /api/files/files/:id`)
give each file row `dataView`: whether this kind of file has a Data view.
The view itself gives the answer or the refusal. `withDataView`
(`packages/files/src/file-data.ts`) decides it: a table type with a valid
sha256; an XML only with a name at its bytes; a PDF only with a database.
So a PDF drawing has a Data view and a PDF document has none, and the
client holds no list of its own. The other refusals of `file_sql` (a
private file, an email attachment seen below Admin, a quiet copy) are not
asked here: the view asks `file_sql`, and it gives them.

The Data view's first answer (`POST /api/files/files/:id/database` with no
`sql`) carries `readBy`: the pipeline's id and version from the stamp, or
null for a database built before stamps.

## Options and the state of a pipeline

Pipelines phase 2. A pipeline can have options. Its manifest declares them. A
box keeps only what an Admin changed, in one table. A box that never sets
anything behaves as before: no row means the defaults of the code.

### Options

`PipelineManifest.options` (`packages/files/src/pipelines/contract.ts`) names
each option and its spec. A name is lower case, `a-z`, `0-9` and `_`, and
starts with a letter. There are three types:

| Type     | Value           | Its bounds                                             |
| -------- | --------------- | ------------------------------------------------------ |
| `number` | a number        | `min` to `max`                                         |
| `bool`   | yes or no       | none                                                   |
| `words`  | a list of words | at most `maxItems` (200), each at most `maxChars` (16) |

A word is upper case, 1 to `maxChars` characters of `A-Z`, `0-9`, `.`, `_`,
`/` and `-`, and starts with a letter or a digit. The check makes a word upper
case, removes doubles and sorts the list, so the same words in two orders are
one value. A default list is kept the same way.

There is no pattern type, by choice. JavaScript cannot stop a slow pattern,
and the built-ins run in the web and api processes. A word list steers a
grammar we have. A site that needs its own patterns needs its own code in the
parser (phase 3).

`packages/files/src/pipelines/options.ts` holds three pure functions:

- `checkOptions(manifest, input)`: the one check of a write. It refuses a
  name the manifest does not declare, a wrong type, a number out of range and
  a word list past its bounds. The refusal is a plain sentence.
- `effectiveOptions(manifest, stored)`: the values in force. The defaults,
  with each stored value that still passes its spec. A value that no longer
  passes gives the default. It never throws.
- `optionsHash(manifest, values)`: `''` when every value is the default. Else
  the first 8 hex of the sha256 of the values as JSON with sorted keys.

The version pin hashes the options only when a manifest declares some: each
option's name, type, default and bounds. So a new default, or a narrower
bound, needs a new version.

### The title block box: the options of `drawing-pdf`

The PDF drawing reader has two options: `title_block_width_mm` (default 190,
50 to 420) and `title_block_height_mm` (default 70, 20 to 300). A word whose
centre is in that corner of the sheet, measured from the lower right on
paper, has the region `title_block`. The defaults are the box of before
(`TITLE_BLOCK_MM`, `packages/files/src/pdf-rows.ts`), so with them no row
changes and the version stays `1.0.0`.

- Its three users take the box from one value, passed in (`titleBlockOf` of
  the options in force): the rows of a text page (`pageRows`, in the parser),
  and the words of a sketch read (`sketchPageRows`, in the api).
- The reader's job gets the options in force in its request, as every
  package does (`request.options`); its step reads the box with
  `titleBlockOf`. The router's step gets the same options, for the box of
  the page facts it hands the reader; the box does not change a kind.
- A caller that parses before the build passes the options too. The
  extract (`server/api/src/agent/extract/auto-table.ts`) takes them from its
  one read of the reader's state, the read of the off test. The rebuild
  `dwg-reindex --pdf` (`server/web/lib/maintenance/dwg-reindex.ts`) reads
  them by `readerOptionsOf` (`packages/content/src/file-database.ts`, which
  asks for no state for a reader with no options). The sketch read
  (`server/api/src/agent/extract/pdf-sketch.ts`) reads the state itself. Their
  stamp carries the hash.
- The kind of a file does not change with the box: the corner text the
  kind's sample reads has its own fixed corner (`kindSample`,
  `packages/files/src/pdf-kind.ts`).
- The option works for every new upload. A PDF read before keeps its rows
  until it is read again (`pipeline_reread`, a run on demand): the read again
  keeps its stored kind and asks no model (see "The PDF set" below).

### The stamp keys of phase 2

The stamp keeps the four keys of phase 1. Two more are written only when they
are not empty:

| Key                | Value                                                     |
| ------------------ | --------------------------------------------------------- |
| `pipeline_options` | the options hash of the reader, when not all are defaults |
| `pipelines_after`  | the Transformers that wrote tabs, `id@version#hash`, `,`  |

So a box with the defaults writes the phase 1 stamp, key for key. An older
image reads a database with the new keys with no error: it asks for its four
keys by name.

### The state of a pipeline

The table `pipeline_state` (migration `0373_pipeline_state`, the column
renamed by `0375_pipeline_state_off_in`, schema
`packages/db/src/schema/pipeline-state.ts`) has one row per pipeline a box
changed or that ran: its options, its off list (`off_in`), who set it last,
and its count of runs. `NULL` in `off_in` is the default of the code.

The defaults of the code are `defaultState` in
`packages/files/src/pipelines/builtin.ts`: one default for every pipeline,
an empty off list. So every pipeline is on in every workspace.

`packages/content/src/pipeline-state.ts` is the one reader and the one writer
of the table. Nothing else reads it.

- `pipelineStateOf(ownerId, manifest)` gives `offIn`, `options` and
  `optionsHash`: the row over the defaults, with `effectiveOptions`. A
  router always gives an empty `offIn`.
- `pipelineOffHere(state, home)` is the one test of the off list: whether
  the pipeline is off for a file whose home workspace is `home`.
- `setPipelineState(ownerId, loginId, manifest, change)` checks the options
  with `checkOptions`, then writes one upsert. The options merge into the
  stored ones, so a change of one keeps the others. It refuses `offIn` for
  a router, and a workspace that is not a workspace of this brain or is
  archived. Ids are kept lower case.

### Where a pipeline runs

A pipeline is on in every workspace. A System user can switch it off in a
workspace (the settings area). A router has no switch: it is used wherever its readers are.

- A new workspace starts with every pipeline on. A file with no home
  workspace: the pipeline is on.
- Off means: the pipeline does not run by itself for a file whose home
  workspace is in its off list, and `pipeline_run` does not take such a
  file (the word `not-attached`). Everything that starts by itself honours
  off: the upload's read, the `after` chain and the paid sketch read of a
  scan. Three things are a person's own pick and do not read the list:
  Test on one file, and the operator's shell tasks `dwg-reindex` and
  `pipeline-reread`.
- A reader that is off: a new file of its type in that workspace gets no
  database of that reader and no word, and no parser job and no model call
  is spent on it. The test is in the upload's read
  (`server/api/src/agent/extract/auto-table.ts`), the one automatic read of
  a file's database, before the bytes, any parser job and the PDF router: a
  PDF the rules leave unsure asks the decider nothing. On a box that still
  makes Tables, the file gets no Table either: a Table is made of the same
  read. The text and the pictures of the file are not its database: they
  come as before (for a CAD drawing from the same parser job, which still
  runs for them). A reader that is off also makes no automatic Table.
- The sketch read of a scan (`server/api/src/agent/extract/pdf-sketch.ts`)
  is not due where `drawing-pdf` is off in the file's home workspace: the
  reader's state is read before every gate that leads to spend, so no
  parser job and no vision call is paid, and nothing is written.
- A file that a reader that is off left with no database is so on purpose,
  not a fault. The health check counts it under `file_db_missing`, and its
  hint and `file_sql` say so; `pipeline_list` shows where a pipeline is off.
  `dwg-reindex` is the operator's own pick and does not read the off list:
  it builds such a file too.
- A Transformer that is off: its tabs are not written in that
  workspace (`runAfterPipelines`). A switch-off that lands between the
  queueing of a Site tags job (the one run on demand after a busy parser)
  and its run does not stop that one job: it was queued while the pipeline
  was on. This is accepted.
- Off removes nothing that is there. A database or a tab that exists stays
  as it is. Switching a pipeline on again reads nothing by itself: a person
  runs it on the folder (`pipeline_run`).
- Test on one file (`pipeline_test`) does not read the off list: an Admin
  tests on a file of his pick.
- The Admin task `pipeline-reread` does not read the off list: it reads
  again only files the pipeline already wrote (the same files as the tool
  `pipeline_reread`), so it never writes a pipeline's first result into a
  workspace where it is off.

It holds no rights check of its own. The Admin check is the route's policy and
the tool's scope (area `settings`). The table holds no secret and grants no
right. It runs on the system pool, and in a scope on the narrow role: the
workspace role holds no read of it. The table has no trigger.

The off list is a column, not a `workspace_resources` row. A built-in's id
is in the code, so SQL cannot check it, and a pipeline writes only into the
file's own database. The workspace screen does not list pipelines.

### The runs of a pipeline

A run is one write of a pipeline's result into one file's database: a
reader's build that wrote (`built`), or a Transformer's patch that
wrote (`patched`). An upload, a sketch read's rebuild, a run on demand, a
re-read of the older files and the `pipeline-reread` task all count: they go
through the same two write spots of `packages/content/src/file-database.ts`,
`writeRowsOrWord` for a reader and `patchDatabaseAt` for a Transformer. A
skip, a word with no rows, a failure and a test do not count.

The count is stored, because it cannot be worked out later: a second run
writes over the first. `pipeline_state` has two columns for it, `runs`
(from 0) and `last_run_at` (null until the first run). `countPipelineRun`
(`packages/content/src/pipeline-state.ts`) adds one in one upsert, and
touches no other column: `options`, `off_in`, `updated_by` and
`updated_at` still say who changed the settings last. It runs where the
build runs, in a scope on the narrow role (the two columns are in the
table's `NARROW_WRITES` line: counters, no right, no spend, no guard). The
two write spots call it after the write, in a try and catch: a failed count
is logged and never fails or undoes a build or a patch.

So a box now has a `pipeline_state` row for each pipeline that ran, also
with no option set. Such a row reads as the defaults of the code.

### Rollback

The revert, `packages/db/rollback/0373_pipeline_state.revert.sql`, keeps the
table and its rows (the options and the count of runs) and takes the
migration off the ledger. An older image
never reads the table, so nothing must be done before the image is pinned
back.

`0375_pipeline_state_off_in` renames the column `workspaces` to `off_in`
and sets every list to `NULL` in the same step: an old allow list must
never be read as an off list. It runs only while the column is named
`workspaces`, so a second run changes nothing. Its revert,
`packages/db/rollback/0375_pipeline_state_off_in.revert.sql`, MUST run
before an image older than it is pinned: it clears every off list (the
older image would read it as an allow list), gives the column its old name
back and takes 0375 off the ledger. The options and the count of runs are
kept.

On a box that runs the v0.604 image, the migration 0375 and the new image go
together: for the short time between them the old image cannot read the
state, and a file uploaded in that window gets no database until a person
runs the pipeline on it (`pipeline_run`). This is accepted.

## The set: the route and the tool

`PATCH /api/pipelines/:id` changes one pipeline, and the MCP tool
`pipeline_set` does the same: both call `setPipeline`
(`packages/tools/src/pipelines.ts`), which calls `setPipelineState`. The body
is a `PipelineSetBody` (`@mantle/client-types`): `options`, `offIn`, or
both. The tool takes `id`, `options` and `off_in`. It takes `offIn` as the
same thing, the name an agent sees in `pipeline_list`; both sent and
different is refused with a sentence, and the sentence for a bad list names
the field that was sent.

- `options` names only the options to change. The others keep their value.
  Each value is checked by `checkOptions`; a refusal is a 400 with its
  sentence, and nothing is stored.
- `offIn` (the tool's `off_in`) replaces the list of the workspaces the
  pipeline is off in. `[]` switches it on everywhere. A router refuses it.
  The ids are checked: a uuid, a workspace of this brain, not archived, at
  most 200.
- `workspaces`, the allow list before milestone WO, is refused with one
  sentence that names `offIn`: sent as it was, an old list would switch the
  pipeline off where it was meant to run. The field stays in the type for
  older clients.
- The route refuses any other field of the body. An unknown id is a 404.

The answer is the pipeline's row, as in the list, with no counts (`files`
and `older` are null). A set stores the change only. It starts no run and
reads no file again: the next upload uses it.

The list shows the state of each pipeline: `kind` (`reader`, `after` or
`router`),
`offIn` (the workspaces it is off in; empty for a router), `workspaces`
(always `all`, kept for older clients), `after` (the shape a Transformer
reads), `tabs`, and `options` (each with its spec and the value in force).
The state is read on the system pool beside the counts, on every call. It is
never kept: the 30 seconds of the counts do not hold it, so a set is in the
next list.

Only an Admin with the settings area changes a pipeline. The route's policy
(area `settings`) is the one check; the handler asks nothing again. The
tool's scope is the same area, and it is `systemWhole`: it reads and writes
`pipeline_state` and reads `workspaces` only, and its `id` names no item.
The tool is MCP only: no tool group holds it in phase 2. An API key acts as
its login as the login is now. It reaches the tool only with every area, a
login that has the settings area, and the tool named on the key
(`peerRisky`). A linked brain acts as its login in the same way.

It is not a person-only act: it spends nothing, starts nothing, and loosens
no gate. An Admin who sets a bad option changes the box's own tabs, not
another login's rights.

## Test on one file

`POST /api/pipelines/:id/test` tests one pipeline on one file, and the MCP
tool `pipeline_test` does the same: both call `testPipeline`
(`packages/tools/src/pipeline-test.ts`). The body is a `PipelineTestBody`
(`fileId`, and `options` to try); the tool takes `id`, `file_id` and
`options`. The answer is a `PipelineTestResult`: the status, the time, each
tab with its row count, its columns and its first 5 rows (a cell is cut at
200 characters, as a drawing's row can hold its SVG), the shapes, the
warnings, the calls it would make (`file_tabs_write`), and a fixed word
when there is no result. The answer is bounded: at most 20 tabs and 100
columns a tab, a tab or column name cut at 100 characters, with a warning
when tabs or columns are left out.

**Nothing is written**: no database, no row, no stamp, no word. The test
calls no writer of a file's database and does not set the state.

- A reader reads the file's bytes and calls `parseFileSheets` with no
  decider. A PDF the rules leave unsure gives `unsure`, and no model is
  asked.
- A Transformer reads the file's database at its own bytes, read
  only (else the word `no-database`), checks the match rule on its real
  tabs (else `no-match`), and runs its code. A test reads no off list: an
  Admin tests on a file of his pick. Its code runs through `afterSheetsOf`
  (`file-database.ts`), the one function the patch of a real run calls too:
  one parser job, in the parser scope with no failure ledger, so a busy
  parser is `busy` and a failed job `failed`, and nothing is written.
- An Agent runs its one step on the file's bytes, in one parser job, and the
  core checks the asks (`agentStep`, then `checkAsks`, as a real run). No
  ask is sent, so no model is asked and nothing is paid. The result has no
  tab; `asks` shows each ask it would make: its key, the worker, the field
  names, and the picture's size in bytes and its type. Asks that break a
  rule give `failed` with the reason. A file with no database is `not_mine`
  with the word `no-database`, as a real run skips it.
- `options` are checked by `checkOptions`, then used over the saved ones,
  so an Admin tries a value before the save.
- A file of an extension the pipeline does not read is `not_mine` with the
  word `no-match`; an XML that is not a plan, or a PDF that is a document,
  is `not_mine`.
- A file `file_sql` refuses (`fileDataRefusal`, one of four: not a table
  type, no checksum, an email attachment seen below Admin, or a private
  file, set to stay out of the brain) is `not_mine` with the refusal's word
  (`not-table-type`, `no-sha`, `email-attachment`, `private`), and nothing
  of it is read, as a real build skips it.
- The parser has one slot. A test waits for it as an interactive call and
  gives `busy` when it does not get it. `busy` is no failure. A test counts
  no failure against the bytes: its exchanges use a ledger that keeps
  nothing.

An unknown id or a file the caller cannot read is a 404; a refused option is
a 400 with its sentence. Only an Admin with the settings area tests. The
route's policy (area `settings`) is the check; it is a POST that only
computes (`effect: read`). The file row is read in the caller's scope on
both doors: the route runs on the system pool, as an area route does, so it
runs the test in the login's own scope (`withViewer`), where the tool runs
already. A file of a workspace the Admin is not in is a 404 on the route and
a refusal of the tool.
The tool's scope is the same area, and it is not `systemWhole`. The tool is
MCP only: no tool group holds it in phase 2. It is not a person-only act: it
writes nothing and asks no model.

## Transformers (`after` in the code)

A Transformer reads the tabs of a reader's database and adds tabs of
its own. It never reads the file again, it asks no model, and it runs in
this process. Its manifest has `match.after` (the shape it reads) and
`produces.tabs` (the tabs it writes, and no other). It is never the reader
of an extension: the registry's `readerFor` gives readers only, and it adds
nothing to `dbExts`.

**The match rule.** A Transformer runs on a file when the extension is
in `match.ext`, and the real tabs of the file's database carry the shape
`match.after` (`afterMatches`, on the tabs, never on the stamp). So it works
on a database with no stamp. A spreadsheet with a sheet named `Texts` is not
a match: its extension is not in the list.

**The chain at upload.** When a reader built a database
(`buildFileDatabase`), each Transformer runs in the order of
the box's list (the registry's `after`), with two checks: it is not off in the file's home
workspace (`pipelineOffHere`), and the match rule holds. Its options are the ones in force
(`pipelineStateOf`). An error is logged and never fails the build: the
reader's database stands, and the stamp has no entry for that pipeline. The
sketch read builds a PDF's database again, so the chain runs there too. The
Table a box makes from the same sheets is made from the parse result, which
the chain does not change.

**The patch: the one way to add a tab.** A file database is written whole,
so a Transformer writes through a patch (`patchDocFile` in
`packages/tabledb/src/engine.ts`, `patchFileDatabase` in
`file-database.ts`):

1. Note the database's inode, size and mtime, before the pipeline reads
   its tabs. Then copy the database to a build file beside it.
2. In the copy, remove each tab of `produces.tabs` that is there: its search
   shadow, its view, its rows and its lines in the tab lists.
3. Make the new tabs and their rows, with their search shadows, with the
   functions a whole write uses. A new tab takes the id and the place of
   the old tab of its name, so the same input gives the same content.
4. Set the stamp key `pipelines_after`, and only it.
5. Checkpoint and DELETE journal mode in the copy. Compare the inode, size
   and mtime again; then remove the old file's sidecars and rename the copy
   over it.

A failure at any step removes the build file and leaves the database as it
was. When the compare differs, a write landed during the patch (a sketch
read rebuilt the PDF's database, say): the patch throws and the new
database stays as it is, with no entry for the pipeline, so a later reread
takes the file. Every other tab, every row a model paid for (the PDF kind answer, the
sketch-read rows), the search shadows and the four keys of phase 1 are the
same after a patch. The row checks of a build hold for a patch too (the
bytes are the row's, the file is not private, a name of older bytes goes):
one function, `writeUnderRow`, holds them for both.

**The stamp.** `pipelines_after` lists the Transformers that wrote
tabs, joined by `,`. An entry is `id@version`, with `#hash` when the
options are not all the defaults: `site-tags@1.0.0#0a1b2c3d`. A patch
replaces its own entry and keeps the others. `afterIsCurrent` says whether a
database has a current entry: there, not of a lower version, and with the
same options. `readerIsCurrent` says the same for the reader's stamp, with
`pipeline_options`. Both are in `packages/files/src/pipelines/stamp.ts`, with
`stampOfMeta`, the one reader of the stamp's keys.

**Off.** Switching a Transformer off in a workspace removes no tab.
A person removes the tab with a read of the file again.

**Read again on demand.** `pipeline-reread --pipeline=site-tags` takes the
same files as the tool `pipeline_reread`, by the one definition of "older"
(`pipelineReadOf`): a database with an entry of the pipeline that is not
current, and patches them. A file the pipeline never patched is not older:
the task counts it as `never patched` and leaves it, and `pipeline_run` on
its folder gives it its tabs where the pipeline is on. The task does not
read the off list: the person who runs the task picked the files, and it
takes only files the pipeline already wrote. The caps and the dry run are
as for a reader. It runs on a PDF too: the patch keeps every row.

## Site tags

The first Transformer, `site-tags`. It reads the `Texts` tab of a CAD
or PDF drawing's database (the shape `texts-v1`: a `Texts` tab with a `Text`
column) and adds the tab `Site tags`: one row for each tag, by the tag
grammar of `packages/files/src/pdf-tags.ts`. A list (`P-1A/B`) gives one row
for each item.

| Column    | Value                                                        |
| --------- | ------------------------------------------------------------ |
| `Tag`     | the tag, line number or equipment tag, upper case            |
| `Key`     | its letters and digits only, the join form                   |
| `Raw`     | the token as written                                         |
| `Type`    | `instrument`, `line` or `equipment`                          |
| `Unit`    | the unit or area part, or empty                              |
| `Letters` | the instrument code, the equipment type, or a line's service |
| `Number`  | the loop number, the equipment number, or a line's serial    |
| `Page`    | the text's page (a PDF), or empty                            |
| `Layer`   | the text's layer (a CAD drawing), or empty                   |
| `X`, `Y`  | the text's place (a CAD drawing), or empty                   |

It is on in every workspace, as every pipeline is, until a System user
switches it off in one. It calls no model. The cost: each build of a CAD drawing or
a PDF reads `pipeline_state` once for it, also with no row, and runs one
parser job (below).

**Options.** Four word lists steer the grammar. A word is only looked up;
no pattern is built from a word.

| Option             | Words that                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `equipment_types`  | are always equipment type letters, also when they read as an ISA code: `EA-101`                                                                  |
| `instrument_codes` | are more device codes that are instruments, beside the ISA letters                                                                               |
| `not_tags`         | are never a tag, as an instrument code or an equipment type                                                                                      |
| `line_services`    | are service codes: a token of 3 to 7 dash parts, with one of these and a serial of 3 digits or more, is a line number with no size: `P-1001-A1A` |

With every list empty, the grammar is the one the PDF reader uses. The PDF
reader calls it with no profile, so its rows do not change.

**A code in a table is not a tag (`site-tags` 1.0.1, 2026-11-17).** The
shape `texts-v1` has one more column it reads when it is there: `Region`.
A PDF word whose region is `table` (a code in a column of codes, by the PDF
reader's rule in "The PDF set as packages") gives no tag row; a line number
in it still gives its row. A CAD drawing has no such column, so its rows do
not change. The grammar also has one more word that is never an
instrument code: `SCH`, the pipe schedule (`SCH160`), on every material
list. The options stay the second lever: `not_tags` for a site's own
words.

**Bounds.** A drawing's texts are outside input. The brain reads at most
500,000 rows of `Texts` from the database, one page of rows at a time, into
the body of the job, up to 64 MB, and then sends it; a text is cut at 4,096
characters. The step reads the body line by line: the texts of one run hold
at most 16,000,000 characters, and the tab holds at most 100,000 rows. Past a bound the rest is not read, and
a warning in the log says so. On a desktop the largest made-up cases take
about one second.

**Where it runs.** Site tags is a package (`pkg/site-tags/`, since MV2): one
parser job `pipelineRun` for each run, with `needs.timeMs` 120,000 (the time
of the light parser jobs). Its body is the rows of `Texts`, which the core
reads from the database (`afterBodyOf`). A drawing with no `Texts` tab, or
one with no row, costs no job. The cost: before the move a run took
milliseconds in the brain's process; now it is one parser job for each
drawing in a workspace it is not off in, and it waits for a parser slot as
any job. Measured on a
workstation, the median of 7: a small drawing went from 1 to 3 ms to about
40 ms (the job's start); the largest made-up tab (503,500 rows of `Texts`,
500,000 read, 20,956 tags) went from 842 ms to 1,481 ms. Its body was 14 MB,
far under the parser's upload cap (512 MB).

**A busy parser at upload.** If the parser is busy or down when a drawing
is built, Site tags writes nothing at first: the reader's database stands,
with no `Site tags` tab and no `pipelines_after` entry. One run on demand of
Site tags on that file is then queued (`notifyPipelineRun`, the Run
button's job), and it waits in the extract queue behind the uploads. That
run sends no other. If it fails too, the Run button on the file or its
folder (`pipeline_run`) reads it. A failure of the
job itself (`failed`, `too_large`, `timeout`) queues no run.
A crash of the parser (a hard kill: the connection is reset, which reads as
`crashed`) queues no run either, because a crash may be the file's fault;
`pipeline_run` on the folder gives the tabs to the files that have no entry,
where Site tags is on. `pipeline-reread` does not take them: they were never
patched.

## Links

The second Transformer, `links` (`pkg/links/`). It reads a PDF's database
(the shape `pages-v1`: a `Pages` tab with a `Page` column; also `Page text`,
`Tables` with every table tab it names, `Tags` and `Lines` when they are
there) and adds two tabs. It runs after the book reader (`pdf-pages`) and
after the drawing reader (`drawing-pdf`): both write `Pages`. It asks no
model and calls no paid service.

| Tab          | Columns                                      | One row for            |
| ------------ | -------------------------------------------- | ---------------------- |
| `Links`      | `from_id`, `to_id`, `kind`, `page`, `source` | one link               |
| `Link nodes` | `id`, `kind`, `label`, `page`, `text`        | one thing a link names |

Ids are text made by the builder, never by SQL and never from a number's
printed form: `page:12`, `table:<tab>`, `row:<tab>#7` (the 7th row as the
tab lists it), `code:<code>`, `tag:<tag>`, `line:<line>`, `mat:<number>`. A tab
name keeps its spaces and brackets. The id and kind columns are of type
`select`, so the writer indexes them (`createTab`); `page` is a number. Only
`label` is in the search shadow (`ftsSkipColumns`): ids, kinds, sources and
a row's text, which its own tab holds, are not. `source` names the rule, the
tab and the row a link came from (`code: SPEC K2 ITEMS p2-3 #5`).

**The generic rules**, for every file of pages or tables:

| Kind            | From and to                                                                                                                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HAS_PAGE`      | the file (`file`) to each page                                                                                                                                                                                  |
| `TABLE_ON_PAGE` | a table to each page its `Tables` row spans                                                                                                                                                                     |
| `HAS_ROW`       | a table to each row, with the row's page                                                                                                                                                                        |
| `NAMES_CODE`    | a row or a page to a code: the cells of a code column (a header with `code`, or a part, stock or catalogue number; or a column of no header whose cells are codes), then the same codes in any row or page text |
| `NAMES_TAG`     | a page or row to a tag: a drawing's `Tags` rows, a book's tag column by the tag grammar (`pdf-tags.ts`)                                                                                                         |
| `NAMES_LINE`    | the same for line numbers (`Lines`, a line number column)                                                                                                                                                       |

The tag grammar does not run on a book's running text: there it reads
grades and codes (`WP-11`) as tags.

**Rule packs.** A pack is a file of the package (`piping-spec.ts`, listed in
`packs.ts`): data and small functions for one kind of document. It switches
itself on by a count of its own patterns, with no setting and no model. A
second pack (drawings) is one more file and changes no other.

The piping specification pack is on when 3 or more pages, and at least 5 %
of the pages with text, carry a class header in their top lines
(`Piping Specification No: K2`, `LINE CLASS: K2U`, the code on a line next
to the header, an older title box whose last label is `CLASS`). Its kinds:
`CLASS_PAGE` (a page between two pages of one class is that class; a class
read once from a title box alone is dropped), `CLASS_TABLE`, `CLASS_ROW`,
`CLASS_CODE`, `CLASS_MATERIAL`, `NAMES_MATERIAL` (a row to an ASTM or API
specification number only, such as `mat:A193`, also in text with no spaces;
the grade stays in the row's text, so a grade question adds
`text LIKE '%B7M%'` on the row's node), `IN_GROUP` (an
item row to the group header row above it, `****BOLTING****`; a table
whose title, less its numbered lead words and its page mark, is exactly a
group name of the book starts in that group, up to its own first header
row; a group from a title holds for that table only), `HAS_RATING`
and `HAS_BASE_MATERIAL` (each fact from the first page of the class that
states it), and for an addendum page `ADDENDUM_PAGE`, `CHANGES_CLASS`,
`HAS_CHANGE`, `ADDENDUM_ROW`, `ADDENDUM_CODE` and `ADDENDUM_MATERIAL`. A row
on an addendum page links to the addendum, never to the class: an addendum
only changes a class. An addendum's id carries its current revision, the
one before `SUPERSEDES`. A class's node has its facts as JSON in `text`
(service, rating, face, material, corrosion allowance, temperatures; the
temperatures as `-20/400 °F`, with a unit only when their line states one;
from a limits line, or else from the class's `Temperature Range` lines when
they state one and the same range).

**Honesty.** A link set can be confidently incomplete. The nodes of kind
`coverage` say so, for a reader to ask: what the two tabs are; each kind
with its count; the pages with no text (unread scans), with their list; the
page texts cut at the cell cap before the read; tables the body did not
hold; the cut of the body, with the core's warnings (`coverage:input-cut`);
whether each pack is on; and for the piping pack, the pages with text
and no class, and how many classes have each fact. A Transformer cannot set
the file's description, so the lines are rows:
`SELECT label FROM "Link nodes" WHERE kind = 'coverage'`. The tool
`file_sql` with no `sql` gives them, the kinds with their counts and a few
statements with ids of the file ([file-ingestion.md](file-ingestion.md),
"File databases", a file of many tabs).

**Known limits.** No link names a page by a reference such as "see page 7":
in a book of many specifications that number is the page of one class's own
sheets, not of the book. A material link names the specification number, not
the grade. In text with no spaces, an item code that ends in a letter and a
three digit number (`XYA802`) also gives a material link (`mat:A802`).
Rules read what the Reader wrote: a chart row that the Reader merged with a
list of codes links those codes to that chart row; a group header line that
the Reader made a table's title gives its group only when the title is
exactly a group name of the book: a title the scan misread, or one that is
not a group name, leaves the rows the group before it (a wrong group); a
group from a header row runs on into the next tables of its class, but a
group from a title does not, so the rows of a later table with no header
line and no group title get no group, though they may be of that group; text that the
scan read wrongly (a letter for a slash, a colon in a number) gives no link
or a wrong one; a page text cut at the cell cap is read only to the cut.

**Rebuild.** The links are derived: a run again replaces the two tabs, and
the same tabs give the same rows. A read again of the file rebuilds them
after the Reader. The Reader's tabs are never changed (the patch replaces
only `produces.tabs`). A Transformer does not run again when an Agent adds
its tab later (`Page text`): a person's run of `links` on the file, or a
read again, picks it up. Existing files get links on a new upload and on a
person's read again; nothing runs by itself at a roll.

**Bounds.** The body holds at most 500,000 rows of a tab and 64 MB in all,
a cell cut at 4,096 characters; that is the one cut of the input, and
`coverage:input-cut` says so. Links cuts nothing of its own: a node keeps
its whole text, and a table's pages run to its last page in the file. The tabs hold at most 400,000 links and
200,000 nodes; past them the rest is not written, and a coverage node and a
warning say so. Measured on a workstation on a real book of 1,000 pages and
2,436 tables (a 112 MB database): body 1.3 s, rules 0.4 s, patch 2.5 to
2.8 s (the patch copies the file), about 65,000 links and 23,000 nodes, the
step's answer 9 MB, the file 140 MB after (+24 %), 410 MB peak memory for
all three in one process. The made-up spec of the tests (10 pages): about
20 ms in all.

## Agents

An Agent asks a model about a file and writes the answers to one tab of the
file's database. It is the one role whose run costs money. The first one is
`iso-title-block`: it reads the title block of a piping isometric that is a
TIF scan, an SMF raster or an HP-GL plot, into the tab `Title block`.

In the manifest an Agent is a pipeline, not a router, with `needs.workers`
(`roleOf`). It has `input: 'file'` and one tab in
`produces.tabs`, and may have a second: its list tab (see "The list part of
an ask" below). It has no `match.after`: it matches by extension only. Its
tab lives in the database a Reader made, so a file with no database is
skipped (`no-database`).

**An Agent needs a Reader's database.** `iso-title-block` reads `.tif`,
`.tiff`, `.smf` and `.000`. The built-in Reader `drawing-raster` reads
these extensions (see "The raster drawing reader"): it makes the database,
with the tab `Drawing`, and the Agent then adds its tab to it. The Agent
makes no database of its own. A file the Reader does not take (a photo
TIF, a `.000` that is no HP-GL/2 plot) has no database, and every run of
the Agent on it is skipped `no-database`: nothing is asked and nothing is
written. This is on purpose.

**Why `input: 'file'`.** The step gets the file's bytes and cuts its
pictures from them. It does this BEFORE any paid call, in one parser job
with no model. So a file the step cannot read costs nothing.

**The order of a run** (`runAgentOnFile`,
`packages/content/src/file-database.ts`):

1. One parser job on the file's bytes. The step returns its asks and the
   pictures it cut (`agentStep`). The core checks the asks (`checkAsks`,
   `packages/content/src/pipeline-agent.ts`): a bad ask ends the run, and
   nothing is paid.
2. The core answers each ask: from the Agent's tab when the hash of its
   input is there, else with one paid call.
3. The core writes the rows, with one patch.

There is no parser job after a paid call. No code of the pipeline runs after
a paid call: the step cannot see an answer, change it, or ask again.

**A rule for a step: fewer asks replace rows.** The core writes the rows of
the asks a step returns, and the tab gets no others. So a step that leaves
out an ask it meant to make (a picture it could not draw) loses the paid
row of that ask. Such a step ends `failed` instead: nothing is asked or
written. `pdf-sheet-read` does. `iso-title-block` does not yet: a picture
its helper did not write is left out (an open point).

**The ask.** A step asks with a call of this shape:

```
{ call: 'worker', worker: 'vision', key, input: { picture, fields } }
```

`key` names the ask in the file (one row of the tab). `picture` is the name
of a picture the step wrote: a PNG, JPEG or WebP of 10 MB at most. `fields`
are 1 to 24 names, each with an optional hint; every ask of one step names
the same fields. The step gives fields, never free text: the core writes
the question (`askQuestionOf`) and a fixed system text. The model has no
tool, and its answer is data. `vision` is the only worker an Agent may ask
now.

**The tab is the store.** Its columns are `Key`, one for each field,
`Model`, and `Input hash`. The input hash is the sha256 of the picture's
bytes, the question and the pipeline's version. An ask whose hash is in the
tab is not made again: its row is taken. So a second run of the same file
pays nothing, and a new version of the pipeline asks again. There is no
other table and no cache.

**A stopped run.** A guard that says no, a missing worker or a failed call
stops the calls: no ask after it is made. The run writes the rows it paid
for and sets no stamp entry in `pipelines_after`, so the file shows as not
done; a run again pays only for what is missing. An ask with no answer
keeps its older row of the same key, so a failed run never loses older
data. The entry is set only when every ask has its answer. A throw inside
a paid ask is such a stop too (`failed`): the answers paid before it in the
run are written. A run that stopped before any paid call does not write the
tab again: the older rows stay exactly as they are, and only the entry goes
out.

**A Reader's new read keeps the Agents' tabs.** When a Reader builds the
file's database again, the tab of an Agent stays, with its rows and hashes.
It goes into the Reader's one write, after the Reader's tabs. The Reader's
stamp names the Reader's tabs only.

**The guards and the caps.** They are in the one place an ask becomes a
paid call (`pipelineAskOf`, `server/api/src/agent/extract/pipeline-ask.ts`),
read at the time of the spend:

- The off list: the pipeline is not off in the file's home workspace
  (`pipeline_set` with `off_in`, as for every pipeline).
- Model work is allowed for the file (`llmWorkAllowed`).
- The day cap: the paid asks of all Agents of the box in 24 hours are below
  `MANTLE_PIPELINE_ASKS_PER_DAY` (20,000 by default, the owner's number of
  2026-11-16; 0: no Agent may ask).
- The cap of a file: the manifest's `needs.workers` is the most asks of
  each worker for one file (`iso-title-block`: 2). `checkAsks` holds it
  before any call.

Each "no" stops the run with a word: `off`, `no_llm_work`, `day_cap`,
`no_worker`. Two of the stops are waits, not ends (owner decision
2026-11-19: the provider is the cap, no limit of the brain's own drops
work):

- **The provider's "not now"**: a rate limit (429), no credit (402, or a 429
  or 403 that says so) or a busy provider (503, 529) on an ask answers
  `provider_rate_limit`, `provider_quota` or `provider_overloaded`. The run
  stops there (no more calls into a refusal) and keeps the rows it paid for.
  Such a refused call is no step of the day count.
- **The day cap** (`day_cap`, below).

The run job then sends the same run again later
(`server/api/src/agent/extract-queue.ts`, point 7): after the provider's
gap (1, 2, 4 ... minutes, then hourly; a longer Retry-After of the
provider is honoured), or when the day cap has room (`pipelineAsksFreeAt`:
the moment the oldest ask that fills the 24-hour window leaves it, never
sooner than five minutes). The run again asks only what its tab does not
hold (by the hash), so nothing is paid twice. While it waits, the file's
status says `job: waiting` and the processing answer's `wait` says why
and until when (docs/files.md). Every other stop (`off`, `no_llm_work`,
`no_worker`, a failed ask) ends the run as before: nothing asks again by
itself.

**The day cap.** It paces; it never drops. A cap of 0 is still "no Agent
may ask" and is no wait: the run stops. It is easy to take away: delete the
two `day_cap` checks in `server/api/src/agent/extract/pipeline-ask.ts`, the
cap reader in `packages/content/src/pipeline-asks.ts` and the env number;
the defer code then never runs. Recommendation (2026-11-19): keep it as a
pace for now, at a high number: the provider's limits stop a runaway only
at the account's credit, and the cap is the one place a box's own number
bounds a day of Agent spend (20,000 asks are about $40 to $80 of vision
calls at today's prices) without dropping a page.

**The spend.** Each paid ask is one trace step named `pipeline_ask`, with
`use: pipeline_ask` in its meta, in the trace of the run. The PDF router's
decider asks (`decide_pdf_kind`, `use: pdf_kind`: its one ask of a file and
its page asks, "Page types") count in the same cap; past it, a page keeps
its rules type (`rules: day cap`) and is not deferred. The adapter
writes the cost on it (`docs/spend-recording.md`). The day count reads these
steps (`pipelineAsksToday`, `packages/content/src/pipeline-asks.ts`): there
is no second counter. Two runs at the same time can pass the cap by the few
asks in flight.

**How it starts.** At upload, and on demand (owner, 2026-11-16: the
extraction of data is the most critical part, and engineers use it as
extracted). When the build of an upload writes a file's database, the core queues
ONE run for each Agent that reads the file type and is not off in the
file's home workspace (`queueAgentRuns`,
`packages/content/src/file-database.ts`). So the fields are there after an
upload with no command. The run is the job of `pipeline_run`: a job of its
own, after the build, so the file's text and search do not wait for the
asks, and the order of a run above holds. On demand: a person with the Run
button, or an agent with `pipeline_run` and `apply` (see "Run on demand").

The start at upload needs a Reader for the file type. For `.tif`, `.tiff`,
`.smf` and `.000` it is the built-in `drawing-raster`, on every box. A file
it takes gets its database, and the run is queued. A file it does not take
(a photo TIF) gets no database, so no run is queued and no field is read
(see "An Agent needs a Reader's database" above).

There is no loop and no retry. An Agent's run starts no build, so it never
queues itself. The run job is tried once, but for a wait (the provider's
"not now", the day cap), which sends the same run again later: work that
was already asked for. No timer and no sweep starts a run. Only the build of an upload queues a run: the extract's database
pass, when the bytes have no database yet. So the first extract of an older
file that has no database queues one too, one time. A Reader's run on demand, a
read again and the maintenance tasks queue none: they keep the Agents' tabs
over their write and start no model work. A new version of a file is new
bytes: one run, and it pays.

A bulk upload is paced by the day cap. With the default cap of 20,000 and
two asks a file (`iso-title-block`), the first 10,000 files of a day get their fields
(the sheet read asks four times for a one-page drawing: 5,000). Each file after them
is ingested as every file is, its run stops at `day_cap` (one parser job,
no call), and its run waits in the queue until the cap has room; then it
asks. A failed ask (not a wait) is the same as before: the file stays
ingested, what was paid is kept, and a run on demand fills the rest.

An Agent may ask the box's AI workers only (now: `vision`). It never calls
an agent with tools, such as the responder. The dry run of one Agent gives `asksMax` before
`apply`. `pipeline_list` shows the day's asks and the cap; `pipeline_test`
shows what one file would ask, and asks nothing.

**What is not built.**

- Own Agents: an own pipeline with `needs.workers` is refused at install.
- Other workers than `vision`.
- A full agent run with tools.
- A read again of the whole box: `pipeline_reread` and the two tasks
  refuse an Agent.

**What is not covered.**

- A process killed in the middle of a run loses the answers of that one
  file, one time: they were paid for and not yet written. The next run asks
  them again. A file that changed, turned private or lost its database
  during the run loses them the same way. A throw in the middle of a run
  stops the run and keeps what was paid.
- The input hash is of the picture's bytes. A new parser image can cut the
  same sheet into other bytes (a new version of an image library). A run
  after such an update asks again for every file, under the day cap.
- A Reader's read that ends in a word instead of rows drops the tab with
  the rest of the database. The next run of the Agent asks again.
- An answer the model gave as prose with no JSON is a failed ask. It was
  paid, and it is not stored. A run again asks again; the day cap is the
  bound.
- The day count is a count of attempts, not of good answers: an ask to a
  vision worker whose key is broken counts too.
- A file's traces go when the file is deleted, and its asks leave the day
  count with them.
- A Reader that writes a tab with the Agent's tab name owns that tab: the
  Agent's rows are then not kept over a new read. The built-in
  `drawing-raster` writes the tab `Drawing` only.
- A run that fails before any ask (the parser busy, a lost notify) is not
  tried again. `pipeline_run` on the file or the folder fills the tab.
- A file in a workspace with no assistant, on a box with no vision worker,
  or past the day cap still costs one parser job a file, and no call.
- When the provider fails (no credits), each file makes one failed call,
  and that call counts in the day count.
- A copy of a file is asked again, and so is a file switched to private and
  back: its database is new, so no answered row is there to take.

## The PDF sheet read

The second built-in Agent, `pdf-sheet-read` (owner's word, 2026-11-17: "One
Agent, list answer"). It reads a PDF drawing page by page into two tabs:
`Title block` (the fields) and `Sheet list` (the tags, line numbers and
sheet numbers on the sheet). The package is
`packages/files/src/pipelines/pkg/pdf-sheet-read/step.ts`.

**Which files.** The extension `pdf`, and the kind the PDF router stored in
the file's database: `scan`, `isometric`, `unsure` or `other_drawing`. The
core gives the step that kind (`request.kind`, read from the File tab by
`storedPdfOf`, for a file type that has a router). A file of any other kind
(a P&ID with a text layer, a document) is `not_mine`: one parser job, no
call. The Reader `drawing-pdf` makes the database; a PDF with no database
is skipped `no-database`, as for every Agent.

**The pictures.** The step draws them in the parser's pdfjs child
(`job.pdfPictures`, the same child as the Reader's pictures; no PyMuPDF), with
no model:

| Ask                       | Picture                                        | Fields | List |
| ------------------------- | ---------------------------------------------- | ------ | ---- |
| `page-1-title-block`      | the title block corner of page 1, 300 DPI      | yes    | no   |
| `page-1`                  | page 1, whole, 200 DPI, 4800 px at most        | yes    | yes  |
| `page-1-half-1`, `half-2` | the two halves of page 1, as the whole page    | yes    | yes  |
| `page-2` and on           | each page after it: whole, then its two halves | yes    | yes  |

The asks go in this order: the corner, the whole of each page, then the
halves of each page. A failed ask stops the asks after it, and the list of
a dense page is the ask most likely to fail. The step counts the pages of
the file and reads the size of each on paper (pdfjs, in the job, nothing
drawn), so it draws only pages that are there. It draws all the pictures in
one call of the child, page by page (each page whole, page 1's corner, then
the page's halves), so the images of a page are decoded one time.

**The halves.** A half is 55 percent of the page across its long side
(`HALF`): left and right of a wide page, top and bottom of a tall one. The
two overlap by a tenth of the page, so a mark on the cut is whole in one of
them. Why: a vision model reads a picture at a fixed budget of its own (the
box's model on dev reads each picture for about 1,100 tokens, whatever its
size), so a half gives it each mark at about twice the area. Two bench runs
on 10 site drawings (2026-11-17, the same question as the Agent's) read with
the halves, against the whole page alone: 7 and 8 of 9 values on one
hand-drawn scan (5), 15 of 15 on another (12), 5 and 7 of 9 on a CAD
isometric (3 and 5), 20 and 22 of 40 on a dense flow diagram (1), and 7 of 7
on the sheet that is one large image (5 and 6); no file read fewer. A
grid-paper sketch: 9 of 12 identifiers in both runs (7). A page gives the same identifier up to
three times in the Sheet list, one row for each picture (its `Key` says
which); the text for search has each line one time.

The corner is the box of the Reader's options in force
(`title_block_width_mm`, `title_block_height_mm`, "The title block box").
The core gives the step the Reader's options as its state
(`state.readerOptions`), so a site that set its box gets the same crop with
no option of the Agent. A picture is a PNG, or a JPEG (quality 90) when the
PNG is past 5 MB (`PageWindow.maxBytes`, `packages/files/src/rasterize.ts`),
each under the 10 MB of an ask. The pictures of a run stay in the parser's
budget of an answer (`PIPELINE_PICTURES_MAX_BYTES` in the contract, the same as the parser's `PARSER_PICTURES_BUDGET_BYTES`, 64 MB): a picture still
past 5 MB, or past what is left of the budget, is left out, with a warning.
A site drawing gives pictures of less than 1 MB, so the budget is a bound,
not a cut.

**A blank picture is never asked.** A picture with nothing drawn on it
(every pixel white: `RenderedWindow.blank`) is left out, with a warning: the
model would answer for a white page. An empty page gives no ask; a run of
blank pictures only asks nothing and writes no row.

**A sheet that is one large image.** A CAD sheet exported as one picture at
40 dots a millimetre is about 100 M pixels on A4 (11880 x 8400), past the
75 M that pdfjs decodes elsewhere in the box (`PDF_MAX_IMAGE_PIXELS`): there
the image is dropped, and the page draws white. Before this, the Agent sent
that white page to the model, and its list came back empty. The pictures of
pages of this Agent decode an image up to `PDF_WINDOW_MAX_IMAGE_PIXELS` (100
M, `packages/files/src/pdf-open.ts`; each of its windows says
`largeImages`): they are drawn in the parser's pictures child, a process the
job can kill. The Reader's eye and pieces, and every other open, keep 75 M.
`renderPdfWindows` keeps a page for the windows of it one after the other,
so the image is decoded one time for the page, not for each half. Bench
(2026-11-17, the parser image of this build under a 2 GB limit, the whole
job through the parser service): such a sheet gave its 4 pictures with a
peak of 1,486 MB for the container, in 18.4 s, none blank. That bench had
no CPU limit. A box gave the parser one CPU, and there the garbage
collector, which ran beside the job, fell behind the decode: the child
passed 2 GB and the kernel killed it, every time (dev, v0.702.1: "Page 1
could not be drawn."). Each job now runs its collector in step
(`BUN_JSC_useConcurrentGC=0`, `jobEnv` in `server/parser/src/proc.ts`):
with one CPU the child alone peaks at about 1.4 GB, in the same time.
`scripts/probe-parser-large-image.sh <parser image>` holds it: a made-up
sheet of one 99.8 M pixel image, two jobs sent at once to the image under
the old limits (2 GB, one CPU; the defaults are 3 GB and 2 CPUs since),
both ok, no memory kill. The other 19 PDFs
of the set (1 to 6 pages, 3 to 19 asks): at most 512 MB and 4.6 s a file;
a dense flow diagram 2.1 s. So a run of 10 such large-image pages would be
about 180 s; the child has about 215 s (the job's 240 s, less the 20 s kept
for the answer and the job's start). Its memory was measured on one such
page only: a page lets go of its images before the next is drawn. Past the
time or the memory the run fails and says which page; the remedy is the
option `pages`, on the box, so a last remedy. The model then read 7 of the 7
values of that sheet.
An image past 100 M still draws white, and its picture is blank: never
asked. A kill of the child for memory loses its picture and those after it:
the run fails, and says which page.

**A picture that is not drawn.** When a picture of a page that is there
(the page whole, a half, the corner) is not drawn (the time ran out, the
child was stopped, pdfjs cannot draw it), or the file does not open, the
step ends `failed`: nothing is asked and nothing is
written, so the paid rows of a run before stay as they are. The trace says
which page. A page pdfjs can never draw keeps the Agent off that file until
an Admin lowers the option `pages`. That option is on the box: it cuts the
later pages of every file on their next run, so it is a last remedy.

Why the whole page and its halves, and no more tiles: in the P0 score of 20
site PDFs, the old whole-page read (144 DPI; about 110 on an A0 under its
pixel cap) found 24 of 28 line numbers, and the sketch read in pieces found
6 of 28. 28 of the 29 pages of that set (pages 1 to 10) are A4 or A3: at 200
DPI they are 2,370 to 3,402 pixels long, under the cap of 4,800. The one A0
page gets 108 DPI whole, as the old read, and about 145 in a half. The two
hand-drawn scans of the set are 200 DPI scans: a sharper picture of them
holds nothing more; a half holds the same pixels for a model that reads
each picture at a fixed budget.

**The fields.** Drawing number, Title, Revision, Date, Sheet, Line number,
Unit or area, Project, Drawn by, Checked by: the same on every site.

**Options** (on the box, `pipeline_set`):

| Option        | Type   | Default | What it does                                                                                                                                                                      |
| ------------- | ------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `more_fields` | words  | none    | More fields of this site, one word each, 14 at most; an `_` is a space (`PAINT_SYSTEM` is the field `PAINT SYSTEM`). A word that names a field already, in any case, is left out. |
| `pages`       | number | 10      | The pages read, from page 1, 1 to 10.                                                                                                                                             |

A new value changes the question or the pictures, so the next run asks
again for each file it runs on.

**The cap.** `needs.workers` is `vision: 31`: each page has three asks (the
whole page and its two halves), page 1 one more (its corner), 10 pages at
most. An ask the provider failed is tried one time more (below), so a file
makes 62 calls at the very most; the day cap counts asks. Cost on dev (v0.702.0): about 600 to 1,000 micro USD an ask, so about
3,500 a one-page drawing. The day cap of the box holds all the asks,
as for every Agent. It runs at upload and on demand, as every Agent
("How it starts" above).

**The sketch read stays.** The sketch read of a scan PDF
(`server/api/src/agent/extract/pdf-sketch.ts`) writes its rows in the
Reader's tabs, the sheet read writes its own two tabs.

**One call more when the provider fails.** The sketch read and the ask of an
Agent call the vision worker with `tries: 2` (`runVisionWorker`,
`packages/runtime/src/agent/attachments.ts`): a call that failed with no
answer in time, a dropped line or a 5xx is made one time more; a refusal
(4xx: a key, a rate limit) is not. Both stop at their first failed call, so on
dev one slow answer (60 s, no answer) lost 23 of the 112 pieces of a flow
diagram, and four of its tags. A second failure stops the read as before.
At most one paid call more for each picture.

## The list part of an ask

An ask may want, beside its fields, ONE list: the identifiers on its
picture. The step asks for it with `list: true` in the ask's input, and may
name the page of the picture:

```
{ call: 'worker', worker: 'vision', key, input: { picture, fields, list: true, page } }
```

- **The question.** The core writes it, with its own fixed system text
  (`ASK_LIST_SYSTEM_TEXT`, `askQuestionOf(fields, true)`,
  `packages/content/src/pipeline-agent.ts`). The model has no tool. It
  answers one JSON object: `fields` (the values) and `list` (items, each a
  `text` and a `class`).
- **The check** (`askListOf`): the answer is data. An item is an object with
  a text (one line, trimmed, 120 characters at most) and a class: `tag`,
  `line number`, `sheet` or `other`; any other class is `other`. An item
  with no text is dropped, and so is the same text and class a second time.
  400 items an ask at most (`PIPELINE_ASK_LIST_MAX`). A page is a whole
  number from 1 to 10,000.
- **The answer cap.** An ask with the list part may answer 12,000 tokens;
  an ask with no list part 1,500, as before (`pipeline-ask.ts`), but for
  an Agent of page text (`produces.pages`), which asks with 12,000 too. The
  question asks for one line of JSON, `fields` first. An answer the cap
  cut is not lost: the `fields` object when it is whole, and each whole
  item before the cut, are read (`cutAnswerOf`), each part as JSON on its
  own; the trace step of the ask says `cut`. A model that wrote the fields
  at the top, with no `fields` key, is read there.
- **The tab.** An Agent with a list part has a second tab in
  `produces.tabs`; a list part from an Agent with one tab is refused before
  any call (`checkAsks`). One row for each item: `Key` (the ask),
  `Page` (a number), `Text`, `Class`, `Input hash` (the hash of the ask).
- **The store.** The input hash of a list ask has the list part in it; an
  ask with no list part hashes as before, so the rows of `iso-title-block`
  stay good. The first tab is the store: an ask whose hash is there takes
  its row, and its list rows by the same hash, and pays nothing. A stopped
  ask keeps its older row and the list rows of that row's hash. Both tabs
  are written in the one patch, and a Reader's new read keeps both.
- **Equal pictures.** Two asks of one run with the same input (two equal
  pages) make one call: the second takes the first's answer. A stored hash
  gives the list rows of one key only, so a run again never adds them up.
- **Field names.** SQLite takes a column name with no regard to case: a
  field may not take `Key`, `Model` or `Input hash`, nor another field's
  name, in any case (`checkAsks`).

## The fields in the file's text

After a run wrote an Agent's tabs, their text goes on the file node,
`data.agent_text`, one text for each Agent by its id (owner's yes,
2026-11-16; `server/api/src/agent/extract/agent-text.ts`). `search_tsv`
takes it first in the file's long text (the first 90,000 characters, the
Agents' text before the file's, migration 0388), so a plain search finds a drawing by a line number, a tag
or a title block value. `file_sql` reads the same values
from the tabs. This holds for every Agent, `iso-title-block` too.

The same text is in the file's passages (`content_chunks`), so a search of
the passages finds it too: `writeRetrievalChunks`
(`server/api/src/agent/extract/index-writes.ts`) adds the text of the
file's Agents after the passages of its own text, in passages of their own
under the heading `Read by the Agents`, read from the node at the write
(`agentTextNow`, by Agent id). An extract writes them so. A run that
changed the text (the same text again writes nothing) builds the file's
passages again from its stored text (`data.text`); the passages of the body
do not move, so their vectors come from the embed cache and only the new
text is embedded (with `chunk_windows` on, the windows of every passage are
embedded again: they have no cache). `data.text` holds the first 1,000,000
characters of a file's text: the passages of a longer file end there after
such a build, until its next extract. A run with the same text builds
nothing: a file read by version 1.0.0 gets the Agent passages at its next
extract or at a run that changes the text. The extract and the run of one file never run at the same
time (the extract queue serialises the jobs of a node). A file with no
stored text (a cost-guard index, `indexLocalOnly`; a scan its extract read
nothing from) keeps the Agent text in the node's text only: its passages
are not built from the Agent text alone, so the passages of its local body
stay.

- The text (`agentTextOf`): the name of each tab, then one line a row,
  `column: value` for each cell with a value; no key, model, hash or page;
  no line two times; 64,000 characters at most.
- One write, with no model and no announcement: an UPDATE of a node's data
  starts no extract, and `updated_at` stays (`mantle.keep_updated_at`). It
  writes only while the node holds the bytes the tabs were read from.
- An OCR rescan keeps the key: the bytes and their tabs do not change, and
  the re-extract queues no Agent run.
- A switch to the name-only mode strips the key, and a switch back does not
  write it again (the database is there, so no Agent run is queued). A
  `pipeline_run` of the Agent on the file or the folder writes it again,
  and pays nothing: every ask is a hit of its hash.
- `agent_text` is a byte key of the extractor's (migration 0377,
  `BYTE_DERIVED_DATA_KEYS`): new bytes drop it, the name-only mode strips it
  with `text`, and a file in that mode gets none. A person's write cannot set
  it.
- A failed write is a warning of the run: the tabs stand.
- A run that wrote no tab (a stop before any paid call) does not change the
  text. A run whose tabs have no row takes that Agent's text out, from the
  passages too.

## Run on demand

Pipelines phase 2. A member picks a file or a folder and a built-in
pipeline, and the box runs it on each file. The Run button calls one of two
routes, `POST /api/files/files/:id/run` and `POST /api/files/folders/:id/run`,
and an agent calls the MCP tool `pipeline_run` with `file_id` or `folder_id`.
All three call `runPipelines` (`packages/tools/src/pipeline-run.ts`). The body
is a `PipelineRunBody` and the answer a `PipelineRunAnswer`
(`@mantle/client-types`).

**What a run is.** For a reader, the file's database is built again from its
bytes with `buildFileDatabase`, with no parse result and no decider, so no
model is asked; the `after` chain then runs as at upload. For a
Transformer, the run is the patch (`patchFileDatabase`). For an Agent, the
run is the one that asks a model (`runAgentOnFile`; see "Agents" above).
Nothing else of the file changes: no summary, no extract. An Agent run that
changed the text of its tabs builds the file's passages again ("The fields
in the file's text"); no other run touches a passage or an embedding.

**The dry run comes first.** With no `apply` the answer lists `choices`: each
pipeline that can run on the files, with the count it would take, and
`refused` when it may not run. The choice of an Agent has `asksMax`: the
files it would take times the most asks for one file (`asksMaxOf`). It is
the most a run of these files can ask a model; a file asked before pays
nothing again. `asksMax` is null for every other pipeline. With `apply: true` and one `pipeline`, each
file it takes is queued. `skipped` counts the files the named pipeline does
not take, by word. It is given when one `pipeline` is named, on a dry run
too:

| Word           | Why                                                                    |
| -------------- | ---------------------------------------------------------------------- |
| `no-match`     | the extension, or for a Transformer the tabs, do not fit               |
| `no-database`  | a Transformer or an Agent needs the file's database, and there is none |
| `not-attached` | the pipeline is off in the file's home workspace                       |
| `no-sha`       | the file's row has no checksum                                         |
| `private`      | the file stays out of the brain                                        |

The word `pdf` stays in the type `PipelineRunSkip` of the published contract,
and `refused` stays in a choice, always null since MV5.

**The reader of a PDF drawing runs** (since MV5): a read again keeps the
stored kind and the decider's answer, and asks no model. It is one read,
the job, and one conditional write (in `buildFileDatabase`; see "The PDF
set" below): a PDF whose database holds a sketch read is skipped (`sketch`),
one whose word is the decider's `no-rows` too (`not-drawing`), and a read
that would change a database that changed meanwhile, or is poorer, writes
nothing (`kept`). The dry run does not look into the database, so it can count a file
that the run then skips. Site tags on a PDF runs: the patch keeps every row.

**Two checks.** Rights: the edit of the named file or folder, asked once by
`runPipelines` before anything (`assertItemRight`), for the routes and the
tool alike. A route's `item` declaration and a tool's `itemArgs` are no check
at run time (`docs/actors.md`, sections 10 and 11): a write asks it itself, as
`process_extraction` does. A member who may put new bytes into the folder by
hand may run its reader again. Cost: the busy check
and the cap. `runPipelines` makes no model call and no check of a spend: it
only queues. The checks of an Agent's spend are in the job, at the time of
each paid call (see "Agents" above). With more than `EXTRACT_BUSY_JOBS` (50) extract jobs waiting, the answer is `busy: true` and nothing is queued
(`extractQueueBusy` in `packages/db/src/provider-alerts.ts`, the rule of
`scripts/box-maintain.sh`). One call looks at most `limit` files (100 by
default, at most 1000) in id order; `next` is the last id when there are
more, and goes in `after`. The files of a folder are read in the caller's
scope.

**The signal and the job.** The web side cannot send a queue job: it sends a
`pipeline_run` notify for each file (`notifyPipelineRun`,
`packages/db/src/content-changed.ts`). The api listens on that channel beside
`node_ingested` and sends one job on the extract queue for each notify
(`enqueuePipelineRun`): its data is `{ nodeId, run }` and its singleton key
`<pipeline>:<node>`, so a second notify while the first job waits sends no
second job. A reader's run of a drawing goes on to the heavy lane, and one of
a book to the book lane, by the rule an extract follows; an `after` run stays
on the main queue. The job
(`server/api/src/agent/extract/pipeline-run.ts`) writes one trace of kind
`pipeline_run` (migration 0374) with one step, `file_database`, with the
result. It is not an `extractor_run`, so the readers that look for an extract
(the sweep's missed-extract clause, the integrity checks, the landed view,
`ocr-rescan`) never take a run for one. Its data holds `source: 'run'`. An
upload's read of the database, which runs before the extract's trace opens,
writes a trace of the same kind with `source: 'upload'` (`inOwnTrace`,
`server/api/src/agent/extract/trace.ts`), opened before the read and only
when no trace is open: its steps (`file_database`, `auto_table`, and the
decider's `decide_pdf_kind` with its cost) are in it, and the file's id and
fixed words, never its name. So the database read alone never makes a
file look extracted to the sweep. The picture pass runs there too, before
the extract is admitted, and its steps (`extract_images`, for a CAD file,
for a PDF or a workbook with picture candidates, and for a file whose bytes
will not load) go to a trace of the same kind with `source: 'upload'` and
`pass: 'embedded_images'` (`stepInOwnTrace`) when no trace is open. It
opened an `extractor_run` before, and the sweep took such a file as
extracted before its extract ran. The pass itself is model-free; only the
order of the traces changed, not the work or the paid calls.
A dead extract job is still tried again by the queue (5 tries, then the dead
letter queue, which is driven again at a start). A failure is that step's
error and changes nothing. A run job is tried once: it is sent with
`retryLimit: 0`, so a run that passes its time budget, or that an api
restart cuts off, fails and is
not run again by itself, and a run is never re-driven from the dead letters.
The stamp in the Data view shows what ran; run again what did not. A Reader's
or a Transformer's job does not check the off list again (an Agent's ask
does): a file that moves, or a workspace the
pipeline is switched off in, between the call and the job is still run
once.

**What sends a run.** `pipeline_run` and its two routes, and
`pipeline_reread` and its route, notify. So does the build of an upload:
the `after` chain, once, when the parser was busy or unavailable
(model-free), and one run for each Agent of the file type ("Agents").
Nothing else does. The
listener sends a job only for a notify. No cron, no trigger and no sweep at
boot takes a run. A notify sent while the api is down is lost, and the answer
said "queued": the stamp in the Data view shows what ran, so run again what
did not.

It is not a person-only act, an Agent's run too (the owner's word): the
dry run comes first and says the most a run can ask, and the day cap bounds
what all runs of a day can spend. The tool is MCP
only: no tool group holds it in phase 2, so a member's in-brain assistant
cannot run a pipeline yet. The Run button works for the person. An older
server has no run route (404).

## Read the older files again

Pipelines phase 2. When a pipeline has a newer version, or its options
changed, the files it read before are `older`. An Admin reads them again:
`POST /api/pipelines/:id/reread`, and the MCP tool `pipeline_reread` with
`id`, both call `rereadPipeline` (`packages/tools/src/pipeline-reread.ts`).
The body is a `PipelineRereadBody` (`apply`, `limit`, `after`); the answer
is M5's `PipelineRunAnswer`, with one choice, this pipeline, so both Run
dialogs of the client read one shape.

**No Agent.** The re-read refuses an Agent with one sentence that names
`pipeline_run` on a folder, as it refuses a router: one check on the role.
Each file of an Agent can ask a model, so a walk over the whole box is the
largest way to spend, and it is not built. The tasks `pipeline-reread` and
`pipeline-compare` refuse it the same way.

**Which files.** The ones `older` counts: `pipelineReadOf` decides, on each
file's stamp, with the options in force. For a Transformer, a file
that HAS its entry and whose entry is not current; a file that never got
its tabs is not older, and a member runs it with the Run button.

**The walk.** The file ids with a database, in id order, after `after`.
One call looks at no more than `PIPELINE_SCAN_MAX` (5,000) ids and takes no
more than `limit` older files (100 by default, at most 1000, M5's
constants). When it stops at either while ids are left, `next` is the last
id it looked at, also when it found fewer than `limit`: every call is
bounded, and "Run the next" goes on. The file rows are read on the system
pool after the settings area check (`areaSystem`), as the counts are: the
files of every workspace.

**Two numbers.** The dry run's `choices[0].files` is the older files found
in this page. The list's `older` stays the count of the look, which stops at
the first 5,000 ids and then sets `countsPartial`. On a box past the cap the
two differ: the list counts the first 5,000, the re-read reaches every file
a page at a time.

**The dry run comes first.** With no `apply`, nothing is sent; the dry run
walks and says `busy` too. With `apply` on a busy queue the call walks
nothing: `busy: true`, `queued: 0`, and `next` is the `after` that came in,
so the next call takes the page this one did not queue. With `apply`,
the busy check of M5 (`extractQueueBusy`) first, then one
`notifyPipelineRun` for each file it takes. The job is M5's, unchanged: a
reader rebuilds with no model, a Transformer patches. `skipped` counts
the older files it does not take: `private`, and `no-sha` (the row now
names other bytes, or none). `queued` is the rest. A PDF drawing is read
again with its stored kind and no model; the run skips one with a sketch
read (`sketch`), one whose word is `no-rows` (`not-drawing`), and one it
would make poorer or that changed meanwhile (`kept`), though the dry run
counted it.

**Two checks.** The Admin check is the route's policy (area `settings`) and
the tool's scope (area `settings`); the handler asks nothing again. Cost:
the busy check before any notify, and the cap. No model is asked, so there
is no check for spend. The tool is not `systemWhole`, as `pipeline_list`:
it runs in the caller's scope, and only its walk of the file rows goes to
the system pool (a `systemWhole` tool touches no item table there, which
the W7a sweep holds). It is MCP only: no tool group holds it in phase 2. It
is not a person-only act: every re-read is model-free and capped (an Agent
is refused), and the dry run comes first.

**Nothing starts by itself.** A new version or a changed option starts no
re-read: no trigger, no cron, no sweep, no retry. Only this tool and route,
the tool and routes of the run on demand, and the `pipeline-reread` task
send work.

## The runner of packaged pipelines

The move-over, step MV0. A built-in can be a package: a folder of our own
code in the image. The parser runs one step of it as one job. The runner is
there, so each move is small. The readers that have moved: `plan-mspdi`
(MV1, below), `plot-dwf` (MV4, below), `sheet` (MV3, below),
`drawing-cad` (MV6, below), and the PDF set, `pdf-router` and
`drawing-pdf` (MV5, below).

**The package folder.** `packages/files/src/pipelines/pkg/<id>/`. Its entry
is `step.ts`, which exports one function, `step(request, job)`. The manifest
stays in `BUILTIN_PIPELINES`. A package's manifest is made with `pkg()`:
it sets `runtime: 'bun'` and `entry: 'step.ts'`.
`runtime` and `entry` are not in the version pin, so a move gives no new
version and no file becomes older.

**The package index.** `pkg/index.ts` holds one static map, id to loader
(`PIPELINE_PACKAGES`). The job looks the id up in it. An id that is not a
key is `bad_request`; no path is built from a request. Two checks hold the
index. A test (`builtin.test.ts`): each `bun` built-in has a key, and each
key is such a built-in. The parser's boot smoke loads every step once, so a
step that does not load fails the image in CI. There is no fallback: at run
time a package that does not load is a `failed` job, counted as below.

**The job.** `pipelineRun` (`/pipeline/run`), with 240 s at most, the time
of the largest reader job. A pipeline with a lower `needs.timeMs` is killed
by the parser SERVER at that time, `timeout`, counted as any timeout: the
server finds the manifest by the pipeline id of the request
(`parserJobTimeoutMs`, `server/parser/src/main.ts`). The brain does not keep
the number: it waits what the 240 s job waits (420 s), a backstop only. Every moved pipeline sets `needs.timeMs` to the deadline of
the job it ran in before (`plan-mspdi`: 120 s, the `grid` job's). `needs` is
not in the version pin. A note on the move-over design: it said the job
itself stops a pipeline at its time. That cannot work: a step such as the
plan reader is synchronous, so no timer in the job fires before it ends.
The server's kill is the one place the time is kept. The body is the file's bytes. The options are
`{ id, request }`. The job builds the job handle (`StepJob`), calls the step,
checks its result, and writes `{ ok: true, result, pictures }`. The code is
`server/parser/src/pipeline-job.ts`.

**The job handle.** `bytes()`, `dir` (the job's folder, the only place a
step may write), `deadline`, `tabRows(tab)` for a Transformer, and the
native helpers of the parser: `pdfEye`, `pdfPictures`, `pdfPagePieces`,
`cadRender`, `dwfRender`. A step that does not need a helper does not touch
it. A picture a write call names is a file in `dir`; the job sends its bytes,
under the picture budget.

**The check of a result.** One function, `checkStepResult`
(`pipelines/step-check.ts`). The job runs it on the JSON form of the
result, the very text it writes to `out.json`, and the client runs it
again. So a number that is not finite, or a cell left undefined, is `null`,
as it was on the old path, whose answer was JSON too; a result that JSON
cannot hold is refused. The status is one of four words; at most 64
calls; a write call has whole tabs, each cell text, a finite number, a
checkbox or empty; `state` is 256 KB at most; `kind` is 64 characters at
most; every other field (`warnings`, `counts`, the write's `description`,
`text`, `pictures` and the rest) is absent or of its type. A result that
fails it is a `failed` job. A failed job is counted like the failure of any
parser job (the failure count, below), and the file gets its word
`unreadable` after the second count.

**The loop.** `runPackaged` (`packages/content/src/pipeline-runner.ts`)
runs the steps to the end: step 1, then, while a step asks AI workers, the
asks, and the next step with the `answers` and the `state`. A router has 2
steps at most, a pipeline 4. A step that still asks on its last step is a
failure. The caller gives an `ask` function, or none. With none the run is
model-free (`request.asks` is false), and an ask gets `refused`. The asks
of one worker are capped by `needs.workers` in the manifest. The core may
give the first step a `state` (`opts.state`): the one way it hands a step
facts it holds (the PDF reader's stored decision, below). The state is data
from the core; the result is checked as every one.

**Nothing is written by the loop.** It gives back the input of the write
call. `readSheets` (`file-database.ts`) is the one place that picks: every
built-in is a `bun` one now, and runs the loop. A write is the
sheets; `not_mine` is that reader's answer with no name (`not-plan`, or
`not-drawing` for a PDF); `ok` with no write is no rows. A `failed` step is
a failed job, counted like any parser job's failure, and the file gets its
word `unreadable` after the second count. Any other end (`unsure`) is the
word `unreadable` at once. Neither writes over a stored database. The write
spot does not change. So "Test on one file", "Run" and the compare run the same loop.

**The failure count.** A failure of `pipelineRun` counts against the
pipeline at its version and the bytes: its key is
`pipelineRun:<id>@<version>:<sha256>` (`parserFailureKey`). The sha256 is
the file's, as the step's request names it, so a Reader's job on the
router's page facts (a new body on every read, a clock value in it) counts
on its file as a job on the bytes does. A body with no file named (an
`after` pipeline's tabs input) is keyed on its own sha256. Two pipelines on
the same bytes count apart, and the second counted failure of one is final
for that version, as for every job. A new version gets its own tries: its
key starts at zero, so a file whose read was final is sent again at the
next read of its bytes, and is final again after one failure the parser
calls final, or two counted ones. This change of the key's form did the
same once for every file whose read was final under the old key
(`pipelineRun:<id>:<sha256>`), not only after a roll that raised a version.

That try is parser time, with one exception. The PDF router's two steps
share one key (same pipeline, same bytes), so a PDF whose step 2 failed
twice is no longer refused before step 1. If a person re-extracts such a
file, step 1 runs again and the decider can be asked again: one ask, two if
the extract retries. Nothing starts that by itself.

**The input of a Transformer.** It never gets the file. Its body is
the tabs of the shape it reads, in JSON Lines (`pipelines/tabs-body.ts`):
one head line for each tab, `{"tab":"Texts","columns":[...]}`, then one
line for each row, a JSON array in the order of the columns. The core
writes it (`afterBodyOf`), with the row cap of 500,000, the one cell cap
`AFTER_CELL_MAX_CHARS` (4,096 characters, in `pipelines/shapes.ts`, the cap
Site tags uses too) and a budget of 64 MB for the whole body
(`AFTER_BODY_MAX_BYTES`; the largest honest body is 10 to 14 MB), and adds
the warning "Only the first N texts were read." when it cuts (or "The tab X
was not read: the input was full."). A cut body ends in one more line,
`{"cut":[...]}`, with those warnings (`bodyCutLine`), so the step can say
what it did not get; it is past the budget, as it is a few lines. It builds the
body from Buffer chunks, so the brain holds it about once. The step reads it with
`job.tabRows(tab)`, line by line.

**The test-only package.** `pkg/test-echo/` is not in the index of the
image. The parser adds it only when `PARSER_TEST_PIPELINES` is 1, which the
tests set (`packages/content/src/pipeline-runner.test.ts`).

## The plan reader as a package

`plan-mspdi` is the first reader that moved (MV1). Its folder is
`pkg/plan-mspdi/`: `step.ts`, and the reader `mspdi.ts` with its tests. The
step gives the tabs Tasks, Resources and Assignments and the description
of a plan, in one write call. The sniffs (`mspdi-sniff.ts`, the first 8 KB
only) are kit, and the core runs them on the bytes in hand before any job,
in `parseFileSheets`, as the old adapter did: a root that is not Project is
`not-plan` (no name), a Project root that fails the full sniff is the word
`no-rows`. So an XML that is not a plan costs no parser job on any caller:
the upload, `dwg-reindex`, "Test on one file", "Run" on a folder and the
compare. The step keeps the same two answers for a run that reaches it
directly (`not_mine`, and `ok` with no tabs, which the write spot makes
`no-rows`). The text for search stays on the `text` job, which imports
`renderMspdiText` from the package folder. The parser's `grid` job no
longer reads XML. The rows, the stamp and the version did not change: the
golden files of the old path (`pkg/plan-mspdi/golden/`) hold it.

## The DWF reader as a package

`plot-dwf` moved in MV4. Its folder is `pkg/plot-dwf/`: `step.ts`, and the
container reader `dwf.ts`. The step reads the bytes in hand: a file that is
not a DWF by its magic (usually a renamed DWFx), and a DWF with no 2D
sheets, are `ok` with no tabs (the word `no-rows`), as before; else the tabs
Sheets, Layers and Labels and the description of a DWF database, in one
write call. A DWF that cannot be opened fails the job, as the old `grid` job
failed. The old path sent every `.dwf` to the parser, so each read is one
parser job before and after. The text for search stays on the `text` job,
which imports `parseDwf` from the package folder. The sheet pictures stay on
the `images` job, in `packages/files/src/dwf-images.ts` (with the renderer of
the CAD tier): that part of the old `dwf.ts` stayed out of the package
because it uses the picture code and the config, which are not kit. The
manifest's `needs.timeMs` is 120 s, the deadline of the old `grid` job. A DWF
is still a heavy file: the lane comes from the extension
(`extractWeightOfExt`), so one DWF extract at a time, as before. The parser's
`grid` job no longer reads DWF. The rows, the stamp and the version did not
change: the golden files of the old path (`pkg/plot-dwf/golden/`) hold it.

## The CAD reader as a package

`drawing-cad` moved in MV6: one pipeline for DWG, DXF and DGN. Its folder is
`pkg/drawing-cad/`: `step.ts`, the reader of the CAD tier's reply
(`cad-reply.ts`) and the builder of the tabs, the description and the text
digest (`cad.ts`), with its tests. The Python CAD tier stays where it is, as
kit; the step starts it through `job.cadRender`. The sniffs (`cad-sniff.ts`)
are kit: the step and the core both ask them.

CAD is the one reader whose three passes share one read (the database, the
text for search, the picture). The step runs the CAD tier ONCE and returns
the tabs, the description, the digest (`text`) and the model space picture
(`pictures`, `model.png` in the job's folder) in one write call, with the
facts the readings of `dwg-reindex` ask (`dgn`, `dgn_data_reader`,
`dgn_data_error`, `dgn_v7`, `dwg`, `symbols`, each 1 or 0) in `counts`, and
a render that failed as its one warning. The brain keeps that one result in
the one memo of a Reader's run (`packages/files/src/reader-memo.ts`, through
`cadRun` in `packages/files/src/dwg.ts`; two runs in a queue of CAD's own,
and a failure kept for the rest of the extract's scope), the memo every
Reader that gives text or pictures shares (section "Text and pictures from
every Reader"). No run of an own Reader pushes a drawing's run out between
its passes. The database pass (`parseFileSheets`), the text
pass (`parseCadFile`), the picture pass (`extractCadFileImages`), the
explanation of a missing picture and the readings all take it from there,
so a drawing still costs one heavy job. The render dial `DWG_RENDER_DPI` is
read by the brain and sent as the option `dpi`; it is no manifest option.

Bytes that are not the format their extension names are no read: the core
answers them in `parseFileSheets` (no tabs, as the old adapter gave), and
the text and picture passes give `''` and no picture, all with no job. The
step gives the same for a run that reaches it directly. A drawing the CAD
tier cannot read fails the job, as the old `dwgRender` job failed.

The Table of `dwg-reindex --table` (no Symbols, Placements or Shapes) is a
run with the option `symbols: false` (`cadTableWorkbook`): a run of its own,
in a mode that builds only that Table. The crops of the image check (the job
`dwgCrop`, used by `dwg_render` and `circuit_verify`) stay on their route.
The manifest's `needs.timeMs` is 240 s, the deadline of the old `dwgRender`
job, and a drawing is still a heavy file (one at a time). The parser job
`dwgRender` and its route `/dwg/render` are gone. The rows, the stamp and the
version did not change: the golden files of the old path
(`pkg/drawing-cad/golden/`) hold it, with the CAD tier's recorded reply to
each fixture (`pkg/drawing-cad/fixtures/replies/`) for the compare in
process. The compare through a real parser with the CAD tier
(`packages/content/src/pipeline-golden-drawing-cad.parser.test.ts`) runs
only on the workstation, in the parser image built from the branch, with the
test file mounted and `PARSER_TESTS_REQUIRE_CAD=1`, or wherever
`PARSER_PYTHON` names a CAD tier. CI does not run it: the image has no test
files, and the lanes have no `PARSER_PYTHON`, so there it is skipped. CI's
probes of the parser image send the sample DWG and the made-up DGN through
the package in a `pipelineRun` job. The render of the sample DWG is other
PNG bytes on every run, on the old path too, so for that one drawing the
compare checks the picture's provenance and form, not its bytes.

## The raster drawing reader

`drawing-raster` reads scanned and plotted drawings with no model: a 1-bit TIF
(`.tif`, `.tiff`), an Imagenation SMF raster (`.smf`, gzip or not, with one
TIFF inside) and an HP-GL/2 plot (`.000`). It is the one built-in in
Python: its code is `server/parser/cad/drawing_raster.py`, in the CAD tier's
folder, and its manifest says `runtime: 'python'` and `entry:
'drawing_raster.py'`. The parser runs it as it runs an own Python step
(`pythonStep`), from that folder by the entry's name
(`builtinPythonEntry`); it has no key in the Bun package index.
`builtin.test.ts` holds that the file is there, and so does the parser's
boot smoke (`pythonBuiltinsThere`). Its tests are
`server/parser/cad/tests/test_drawing_raster.py`, in CI's CAD tier lane, on
files they make up.

One write call gives the tab `Drawing` (Key, Value: the format, the title
the file names with its parts and the sheet number in brackets, the size in
pixels and mm, the dpi, the compression, the layers of an SMF, the plot name
and pen widths of a plot), a description, a short `text`, and the pictures:
the whole sheet (`page_px`, 2,800 px by default) and three crops where a
title block sits (`crops`, on by default). A picture under 200 px is
scaled up, 4 times at most; a thinner sliver gives no picture. Every
file it takes gets a database, so an Agent of these types runs at upload.
Its manifest says `produces.table: false`: the upload makes no automatic
Table of the Drawing tab. Any Reader may say so. Its run is kept in the one
memo of a Reader's run, as an own Reader's is (any built-in that says
`produces.text` or `produces.pictures`, `packagedSheets`), so its three
passes cost one parser job.

A 1-bit raster stays packed in memory: libtiff reads it strip by strip
into a bit buffer (the image installs `libtiff6` by name; on a dev host the
copy in Pillow's wheel). A plot of 1.36 gigapixels peaks at about 340 MB. A
raster past 2.5 gigapixels, or an SMF past 64 MB, fails with a sentence.

What it does NOT take is `not_mine`, so the file takes the path it took
before: a TIFF that is not 1 bit (a photo, colour or gray), a tiled TIFF,
bytes that are not a TIFF; an SMF with another magic; a `.000` that is not
HP-GL/2 (no `ESC%nB`, no `IN;` or `BP` at its start, or nothing ezdxf can
plot; PCL's `ESC%-12345X` is no match). A `not_mine` writes nothing: the
only cost is its parser job. For an `.smf` or a `.000` that path is the
default text of a file no reader takes (docs/parser.md, "A file no reader
takes"); for a `.tif` it is the core's image read, below.

**A `.tif` and the core's image read.** A `.tif` is an image to the core,
which sends it raw to the vision worker. When the box's Reader of the type
takes the file and gives text (`readerTakes`,
`server/api/src/agent/extract/load-body.ts`), the raw read is skipped: the
Reader's text is the file's text and its pictures are read by vision, one
call each. A photo `.tif` (`not_mine`) is read raw, as before.

## Site tags as a package

`site-tags` is the first Transformer that moved (MV2). Its folder is
`pkg/site-tags/`: `step.ts`, and `site-tags.ts` with its tests. The grammar
`pdf-tags.ts` is kit. The step reads the rows of `Texts` with
`job.tabRows('Texts')`, builds the tab `Site tags`, and returns it in one
write call with its warnings. The core (`afterSheetsOf`) adds the warning of
the row cap. Every caller goes through `afterSheetsOf`: the patch at upload,
the run on demand on a file or a folder, `pipeline-reread`, the Test and
`pipeline-compare`. Each checks the match rule first, and `afterSheetsOf`
asks no job for a `Texts` tab with no row. The fixed set is nine made-up
databases as JSON (`pkg/site-tags/fixtures/`), each read with the defaults
and with one set of options; the golden files hold the rows, the warnings
and the `pipelines_after` entry the old path gave.

## The mail reader

The built-in Reader `mail` (`packages/files/src/pipelines/pkg/mail/`, 1.0.0,
2026-11-24, ingestion program item A1) reads an email file: `.eml` (one RFC
822 message, mailparser 3.13.0, MIT, the pin of server/sync), `.mbox` (split
on the `From ` line that starts each message; a body line `>From ` loses
one `>`, mboxrd; each part read as an `.eml`) and an Outlook `.msg` (an OLE2
compound file, @kenjiuno/msgreader 1.29.0, Apache-2.0; an RTF-only body is
unpacked with @kenjiuno/decompressrtf 0.1.4, BSD-2-Clause, and read by
anydoc). All three run on Bun in the parser job `pipelineRun`; no model is
asked.

One step, one write: the tab `Mail` (a row a message: `Message`, `From`,
`To`, `Cc`, `Bcc`, `Date`, `Subject`, `Attachments`), the description of a mail
database, and `text`. The core has no text route for these types
(`parserRouteForExt` is `none`), so the Reader's text is the file's text
(see "Text and pictures from every Reader"): each message's header lines,
its whole body (plain; else HTML through the markup reader, which is kit for
it; else RTF through anydoc, kit too), and its attachments by name, type and
size. A mailbox has a heading `## Message N` before each message.
`produces.table: false`: no automatic Table.

Attachments are named, never read (docs/files.md, 8f): the detail cut
`mail_attachments`; their bytes are drained as the message is parsed
(mailparser's stream), never kept. The cut `mail_messages` (`read` of
`total` messages read in full, the file `partial`) says what was not read:
the answer cap (40 MB of JSON in UTF-8, `MAIL_ANSWER_MAX_BYTES`, under the
96 MB wire), the time cap (150 s, `MAIL_READ_MAX_MS`, under `needs.timeMs`
of 240 s, so a huge mailbox ends in part rather than killed whole), a
message of a mailbox mailparser refuses (its headers kept, and any
attachment names read before the refusal; the others are read), an Outlook
message past the same bounds (a header past 1 MB, more than 1,000
attachments), and an RTF body whose header claims
more than its bytes or that is past 2 MB packed (not unpacked: the unpacker
reads to that header's size and unpacks up to 8 times). A body is never
measured past the budget in characters, so no huge string is stringified.
An empty file: a write with no tabs (the word `no-rows`) and no text, so it
keeps the default text. The bytes choose the reader: OLE2 is
an Outlook message whatever the name, anything else RFC 822. An OLE2 file
the reader cannot read, or a single message mailparser refuses, throws, and
the file gets `document_unreadable`.

Files that were uploaded before this Reader have the default text (their
name). They are read again by a re-extract, a person's act, per box (the
program's Q3): `pipeline_reread` keeps a file's text and so does not give
them their text.

## The spreadsheet reader as a package

`sheet` moved in MV3, so that the read of a spreadsheet is a pipeline: the
place where a site can later read an Excel file into something that is not
a table. Its folder `pkg/sheet/` holds only `step.ts`. The engine
(`sheet-grid.ts`, `sheet-read.ts`, `sheet-to-grid.ts`, `legacy-sheet.ts`) is
kit: the Table import routes, the Table tools, pasted text and the text read
call it as before, and the parser's `grid` job stays for them. The step calls
`readSpreadsheetGrid(bytes, ext)` and returns one write call. Its
`needs.timeMs` is 120 s, the deadline the `grid` job has.

One change of path: a CSV's database read is a parser job now, as for every
package. Before the move it was read in the brain's process. The rows are
the same (both ways use `parseDelimited`), and a CSV the engine cannot read
(a stray quote) is a failed job, the word `unreadable` at once, as before.
So a CSV's database read depends on the parser now, as a workbook's always
did. With the parser busy or down, the extract of a CSV waits and retries
(the client's busy waits, then the extract's own retries) and can end in the
dead letter queue, where before a CSV made no parser call. A run on demand
and a Test on a CSV can answer `busy`.
A long file is read in part, never refused whole (the ingest
program, 2026-11-23). The early cap on delimited text in the core is gone. The
step keeps the first rows of the file, in order, up to the import ceiling
(`TABLE_IMPORT_MAX_ROWS`, 2,000,000) and the read budget
(`MANTLE_FILE_DB_CSV_MAX_MB` of cell text, a cell counting its text plus 3
for its quotes and comma in the answer), with one keeper (`RowKeeper`,
`packages/files/src/sheet-to-grid.ts`). The rows past the stop are counted,
not kept, and the write says the cut (`readCuts`: `database_rows` or
`database_size`, the rows kept of all the rows); the extract says it on the
file and makes no Table of a cut read. A CSV is read as a stream, in 4 MB
slices of its bytes. A workbook past the size check of `sheet-read.ts`
(32 MB of sheet XML) is read with exceljs's stream reader, the zip given to
it with the workbook part first (`streamWorkbookRows`); under it the
whole-workbook reader stays, as it fills merged cells and the stream does
not. A by-hand import gives no keeper: it reads whole or refuses, as before.
The budget is for the parser job's memory and answer (96 MB) and the
brain's one write: a 55 MB CSV took about 2 GB in the parser job when the
whole grid was kept. `.xlsm` is not in the reader's match list. The golden
files of the old path (`pkg/sheet/golden/`) hold the rows and the stamp;
`over-cap.csv` has no golden file now, its case says the head and the cut.
A read for a file's database (`request.spill`, 2026-11-24) keeps every row
of a long file instead: past the read budget its rows go to the rows file of
the job (`PIPELINE_ROWS_FILE`, `out.rows`, one JSON line a row), the write
names those tabs (`spilled`: each tab's index, rows and the place of its
columns in the raw rows), and the parser sends the file after the JSON
(`x-parser-rows-length`). Only a run with `spill` may spill; a step that
spills unasked is refused. See docs/file-ingestion.md, "A long sheet".

## The PDF set as packages

`pdf-router` and `drawing-pdf` moved in MV5. The packages hold only their
`step.ts`; the four files of the PDF set (`pdf-kind.ts`, `pdf-rows.ts`,
`pdf-drawing-sheets.ts`, `pdf-sketch.ts`) are kit, because the core reads a
PDF's File tab and the decider's state with them too. The page facts are
read with `readPdfDrawingInJob` (kit, `pdf-drawing.ts`): the job's eye, its
picture child, and the page budgets the old `pdfDrawing` job had. The
router's job reads them and hands them on (see "Two jobs, one read" in "The
router"); the reader reads them itself only on a read again with the stored
kind, or when the router left them out.
Both have `needs.timeMs` 240 s, the old jobs' deadline. `parsePdfDrawing`
is gone. The parser jobs `pdfDrawing` and `pdfPieces` stay as the reader's
kit jobs, for the sketch read only (below), as `dwgCrop` stays for CAD.

**The router.** Step 1 reads the page facts and names the kind by the rules.
A file the rules leave `unsure`, in a run that may ask, returns one call to
the worker `decider`: its input is the decider's state (`pdfKindAskFrom`:
counts and the text sample). The core checks it (`pdfKindAskOf`, the one
check of what leaves the box for the decider; it keeps a copy of the seven
fields only), asks (`askPdfKind`, with the cost guard), and keeps the
answer. Step 2 takes the answer and names the kind by the one rule
(`decidedKind`). So an unsure file the decider is asked about is three jobs
and one read: the router's two (the second reads nothing) and the reader's,
which takes the facts of the first.

**The decider's accepted repeat.** The decider is one small call, made
before the reader's job. When that job then fails (the parser busy or
down), the extract fails and the queue tries it again, and the router asks
again. That is accepted, as the cost of the router and the reader being two
jobs: at most one decider call for each try of the extract queue in a round
(its tries are the bound; nothing else starts one). The retry is not stopped
there: the file needs its database.

**The decision in the File tab.** The File tab keeps the decider's answer,
confidence, mode and model, a shadow answer too. The core puts them in the
reader's first `state` (`packages/content/src/pdf-read.ts`): on an upload
from its own ask, on a read again from the stored File tab. The reader
writes the File tab from `request.kind` plus that state. The kind came from
the decider when the decider's answer may be used and is that kind.

**A read again: one read, the job, one conditional write.** A run on
demand and a re-read call `buildFileDatabase` with no `parsed`. For a PDF
that is three things, in that one place. `dwg-reindex --pdf` is not in it:
it parses first and passes `parsed`, and makes its own check before its
parse, as before (a file with a database or a word is not taken; with
`--again`, a PDF's `no-rows` is still left).

1. ONE read of the stored state of these bytes, before the job
   (`pdfReadAgainOf`). It fails closed. The file is skipped when its
   database has a sketch read (`sketch`); when it has no database and its
   word is `no-rows` (`not-drawing`); and when the state cannot be read: no
   stat, no word, or a database whose File tab cannot be read (`kept`). Else
   it gives the stored kind and decision, the stored rules kind and count of
   pages not read whole, and the stat of the database.
2. The reader's job, with the stored kind and decision: the router does not
   run and no model is asked. A PDF with no database and no word runs the
   router with no ask, so an unsure file stays unsure.
3. ONE conditional write. It is refused when the database changed since the
   read (the stat compared right before the rename, the pattern a patch has)
   and, when a database is stored, when the new read is not better sheets:
   it failed or gave a word (a failure, `too-large`, `no-rows`), or it is
   poorer than the stored one (`pdfReadPoorer`, the rule of the sketch read:
   another rules kind, or more pages not read whole; and rows past the
   import cap, whose write keeps only the first rows). Then nothing is written,
   no word either, and the answer is `skipped` with the word `kept`.

Why any `no-rows` of a PDF is kept: a drawing read always has its File tab,
so for a PDF that word comes from the decider's "document" of an older read
(the answer is no longer used, so no read gives the word now), but the word
holds no source. A word that cannot be told apart is taken on the safe side.
The dry runs of `pipeline_run` and `pipeline_reread` do not look into the
database, so a dry run can count a file the run then skips.

**The sketch read is a core path that uses the reader's kit.** It has no
package, no step and no row of its own. The core starts it at the extract's
spot when it is due, as before (`sketchIngestPdfNode`,
`server/api/src/agent/extract/pdf-sketch.ts`: a sketch kind in the File
tab, no `Vision read` (or one that left scan pages not read, on a node
whose text a person's read again dropped), the cost guard, a vision
worker). It reads the page
facts again (the kit job `pdfDrawing`), and a read poorer than the first
(`pdfReadPoorer`) asks nothing and writes nothing. Else it has the scan
pages cut into pieces (the kit job `pdfPieces`: 300 DPI, then OpenCV), 10
pages a job, each batch asked before the next is cut, and makes one vision
call a packed picture (every scan page, up to 500 a file, within half of the
extract's time budget; a page not read is stated in `Pages` and `File`, and
the file is read in part: docs/file-ingestion.md, 3b); a call that does not
run stops the calls after it. The rows and the text of the scan are made in its
own process, and the one write is `buildFileDatabase` with `parsed`. The
Transformers of that build run only after the write, with `Vision read`
set.

Why the order, and why not steps: money. The page facts come before the
first vision call, and after the last one there is only code in this
process and the write. A parser that reads poorer stops the read before
anything is paid. The pieces of a later batch are cut after paid calls:
every paid answer is kept as it comes (the answer cache, migration 0392), so
a parser busy there only makes the extract try again, and the try again
pays for none of the pictures read. As steps of `drawing-pdf`,
the join was a parser job after up to 40 paid calls: when it failed,
nothing was written, `Vision read` was never set, and the next try paid
again, with each retry of the queue. The runner keeps no paid answer.

**A rule of the contract, for own pipelines (phase 3):** a pipeline must not
have a parser step after a paid call. The runner does not keep paid
answers: a step that fails after a paid call makes the next try pay again.
A paid call goes in the last step that asks, and what follows it runs in
the core.

**The cost.** A PDF is read one time: the router's job reads the page
facts, the reader's job builds the tabs from them. A drawing is still two
jobs, so the start of a job and the step module load are paid two times;
the second job reads no page. This is the bound of the move-over design
(risk 4): the facts as a second body, one addition to the wire. The sketch
read's jobs are as before the move.

### P3: the Reader fixes of 2026-11-17 (`drawing-pdf` 1.1.0)

A spot check of the PDFs of one site and the P0 score (20 PDFs, 151
values by eye) found faults of the Reader and the Router. All of these
rules ask no model.

- **A code in a table is not a tag.** Item codes of a material list, a
  schedule or a line class sheet were read as instrument and equipment tags
  (P0: 72 false rows in Tags and 72 in Site tags on a fresh upload). The
  rule (`codeColumns` and `tableCells`, `packages/files/src/pdf-rows.ts`)
  looks only at codes (a word with a token that has a letter and a digit,
  such as `LG-41` or `F22`, or one the grammar reads), two checks: a code whose left edge lines up with those of
  other codes (1 mm buckets, so edges up to 2 mm apart join), stacked on 4
  lines or more, each gap at most 1.5 times the taller box. Tags on a
  drawing are spread out; a list of codes is close; a call-out or a note is
  words under a tag, not codes, so its tag stays. Such a word has `Region`
  `table` in Texts; a tag's shape there gives no Tags row and is counted in
  Pages (`In a table`, beside `Rejected tag-like`). A line number in a
  table is still a row. A word in the title block corner keeps its region
  and its tags. The same rule runs on the pieces of the sketch read (Source
  `ocr`), on their boxes, so the rows of that read gain it with no change
  of its calls or prompt. A bubble (a code with its number under it) is not
  checked: a column of bubbles is common on a P&ID.
- **Every page of a drawing has its rows.** A typed page gave no rows, so
  a 44-page document left `unsure` had Texts on 4 pages. Now every page of
  a file that gets a database has its rows, a typed page too, inside the
  file's row cap. A `document` has none (its words are the file's text),
  and the router gives no facts for it.
- **Segments.** A drawn page with no text layer (`vector_no_text`: its text,
  if any, is strokes) has its lines and curves as the tab `Segments` (Page,
  Kind `line` or `curve`, X1 Y1 X2 Y2 in the frame of the boxes, Width mm,
  Colour, Dashed). They have a cap of their own (`DRAWING_MAX_SEGMENTS`,
  250,000 a file, note `segments_not_listed` past it), so they never push
  the words of a later page out.
- **Vision text** in the File tab: `sketch read` when the sketch read ran;
  `node text only` when the file's node holds the text of an older
  whole-page vision read (`data.vision_model`) and no tab holds it; else
  empty. `Vision read` stays the record of the sketch read. The core tells
  the reader on a read again (`nodeVision` in the reader's state,
  `pdfNodeVisionOf`).
- **The kind rules 2**: see "The router".
- **The summary.** The extract gives the extractor the kind of a PDF file
  as a fact, outside the fence (`pdfKindFactOf`,
  `server/api/src/agent/extract/model.ts`): one sentence of the kind, such
  as "A piping isometric.", and not for `unsure`. A summary had called an
  isometric a P&ID.

**Old files.** A re-read (`pipeline_reread`, no model, cost 0) takes every
older PDF database: the new version makes them older. A stored kind from
older rules, and not from a used decider answer, is named again by the
router with no ask (`reroute` of `pdfReadAgainOf`); a stored answer that was
not used (a shadow or weak one) stays in the File tab beside the new kind.
A kind from a used decider answer is kept. The rule of a
poorer read (`pdfReadPoorer`) lets a read again name a new kind when its
File tab states newer rules. The sketch read states no version, so for it
another kind is always poorer: a paid read never runs on a database whose
older rules name another kind; a re-read comes first. What a re-read does
NOT do: a file whose new kind is `document` keeps its older database (a
read again never removes one; the answer is `not-drawing`, and each
re-read routes it again, at cost 0); a file with a sketch read is skipped,
as before (`sketch`), so its `ocr` rows keep their false tags until a new
upload. The summary is made again only by a new extract.

**The score, the kit run on the 20 P0 PDFs** (the router and the reader of
the build, the sketch pieces of the fresh upload replayed with no model;
numbers only): kind right 14 → 16 of 20; values found in the file
database 50 → 50 of 151; Tags rows 251 → 186, false 72 → 10; Site tags
rows 239 → 174, false 72 → 10; Tags rows on the list 11 → 11. The flow
diagram with a sample list (not counted as false) went 168 → 165 rows: two
stainless steel grades and one code not on its sample. The score on a box
needs a roll.

## The same-result proof of a move

A move of a reader to a package changes where its code lives, never a row.
Two checks prove it, and no third.

1. **The golden files.** Before the move, the old path runs on the fixed
   set: made-up files in `pkg/<id>/fixtures/`. For each file, the
   `ParsedFile` it gave goes to `pkg/<id>/golden/<file>.json`, written by
   `goldenOf` (`packages/content/src/pipeline-golden.ts`): canonical JSON
   with the keys sorted. A file over 256 KB as JSON is stored as its sha256
   and its counts (each tab's name, columns and rows). After the move, the
   compare test runs the step in its own process (`inProcessStepJob`,
   `@mantle/files/pipelines/test-job`), maps the result as `readSheets` does
   (`parsedFileOfRun`), and compares with the golden file. It also checks
   the stamp. `packages/content/src/pipeline-golden.test.ts` is the model,
   on the test-only package.
2. **`pipeline-compare` on real files** (below), on dev and on a client box.

A difference is a stop. Do not change a golden file to make a test pass.

## The kit

The kit check is a guard against accidents by our own developers, not a
border: packages are our own code in our own image. The border against a
hostile file is the parser jail and `checkStepResult` on the brain side.
Accepted, with no rule in the check: a symlink under `pkg/`, a native or
extensionless file, `createRequire`, an aliased `require`, `eval`.

A step may import its own folder, the contract, and the kit. Nothing else
of the repo. The list is `pipelines/kit.ts` (`PIPELINE_KIT` is 1), and one
test holds it: `kit.test.ts` reads the import lines of every file under
`pkg/` and fails on one that is not on the list. A name that is not the
repo, such as `node:fs` or an npm package, is not checked. An `@mantle/`
name is refused: a step imports the kit by its path. So is a relative
import of a test file (`./x.test`), since the check never reads tests.

| Kit part        | Files                                                                        |
| --------------- | ---------------------------------------------------------------------------- |
| Sheet engine    | `sheet-read.ts`, `sheet-grid.ts`, `sheet-to-grid.ts`, `legacy-sheet.ts`      |
| PDF page reader | `pdf-open.ts`, `pdf-primitives.ts`, `pdf-drawing.ts`, `pdf-drawing-score.ts` |
| PDF set         | `pdf-kind.ts`, `pdf-rows.ts`, `pdf-drawing-sheets.ts`, `pdf-sketch.ts`       |
| Tag grammar     | `pdf-tags.ts`                                                                |
| Shapes          | `pipelines/shapes.ts`                                                        |
| Plan check      | `mspdi-sniff.ts`                                                             |
| Limits          | `read-limit.ts`, `zip-guard.ts`, `limits.ts`                                 |
| Read in part    | `read-cut.ts`, `read-cut-sink.ts` (docs/files.md, "Read in part")            |
| Types           | `sheet-to-grid.ts`, `pipelines/contract.ts`                                  |

The native helpers are kit too, but a step reaches them through the job
handle. The rule for a file: if two packages need it, or a package and the
core, it is kit and stays where it is. If only one reader uses it, it moves
into that package's folder with `git mv`.

## Compare a pipeline with what it wrote

`pipeline-compare` is a maintenance task (`pnpm -C server/web
pipeline:compare --pipeline=<id>`; the code is
`server/web/lib/maintenance/pipeline-compare.ts`). It is the same-result
proof on real files. For each file that has a database of the pipeline, it
runs the pipeline now with no write, and compares with the stored database:
the tab names, the columns of each tab, the row count of each tab, and one
hash of each tab's rows.

- Read-only and model-free. The fresh rows go to a scratch file through the
  same writer as a build, so both sides are read the same way: by the stored
  column names, so a repeated header (two columns named `Rating`) reads as
  its two columns. A parser failure counts against nothing.
- A PDF gets its stored kind and the decider's answer back (`pdfStored`), as
  a read again does: the router does not run and no model is asked. A PDF
  with a sketch read is not compared, nor one with no stored kind
  (`no-stored-kind`): its run would need the router.
- A database of an older version or of other options is not compared, for
  a reader and for a Transformer's tabs alike.
- `--older` compares a reader's database written before stamps too (no
  stamp at all, and the pipeline is the reader of its extension: the
  version `pipelineReadOf` gives is null), against a run now with the box's
  options. It is counted in its own words: `to compare (before stamps)`,
  `equal (before stamps)`, `different (before stamps) <kind>`. A stamp of an
  older version or of other options stays `older`: its rows may differ by
  design. A Transformer's tabs have no form before stamps, so it changes
  nothing for them.
- A reader's side leaves out the tabs a Transformer patched in: the
  reader never makes them.
- A clock column is hashed as null on both sides: `Read ms` of a PDF
  drawing's `Pages` tab, the time a page took to read. The list is one
  constant, `CLOCK_COLUMNS` (`packages/files/src/pdf-drawing-sheets.ts`),
  which the golden tests use too.
- A dry run with the count first, at most `--limit` files a run (100, at
  most 1,000), `--after=<id>` to go on, and no run while the extract queue
  is busy.
- The output is counts only: equal, different by kind (`tabs`, `columns`,
  `rows`, `hash`), and not compared by reason.

It has no route and no tool. One maintain run at a time on a box.

## Own pipelines

An Admin, or the Admin's agent through MCP, installs a pipeline of their
own: a package that reads a file type the box cannot read, so every new
upload of that type gets its database (phase 3, P3-1). Pipelines are an
Admin feature: the settings area is THE check for add, change and remove.
There is no confirm, no review, no signature and no scan of the code. An
Admin who installs a package installs it as a library.

**What an own pipeline is, in phase 3.** A Reader (no router, no claimed
kinds, no `match.after`), at upload, in TypeScript on Bun or in Python, for
an extension no other Reader reads, with no AI worker and no tool but the
write (the one manifest check, section "The registry"). It asks no model: a
Reader's run gets no `ask`, so a worker call is answered `refused`. It may
give the file's text and pictures too (P3-2, section "Text and pictures
from every Reader").

**The package.** One JSON value, `{ files: { path: text | { base64 } } }`:
`pipeline.json` is the manifest (text), `entry` names the step. At most 200
files and 5 MB of bytes on disk (`PIPELINE_PACKAGE_MAX_BYTES`): the install
is one JSON body, and the web route's ceiling is 8 MB, so 5 MB of binary files
(6.7 MB of base64) still fit. Text is sent as JSON text, and its escapes
count against the ceiling: a package of text near 5 MB whose escapes take
its JSON past 8 MB gets a plain 413 on the web route, and installs through
MCP (`/api/mcp`, a ceiling of 128 MB). A text file
holds no NUL character (Postgres keeps none in a jsonb text): send such a
file as `{ "base64": ... }`. Every path passes the one path rule
(`badNewPath`): relative, no `..`, no `.` part, no backslash. A file is
written `0644`; a file under `bin/` is `0755`, so a ready-built program can
run. A native part (a Python `.so`, a program in `bin/`) is built for one
CPU type and, for Python, for the parser's Python: build it in a sandbox of
the box. A part of the wrong type fails to load: the test shows the
loader's sentence, and at upload it is a `failed` job.

**The templates.** `docs/pipeline-template/` holds a made-up "LX-9 data
logger" Reader for `.lx9`, in Bun (`bun/`, with `mantle-pipeline.d.ts`, the
contract's types, which `packages/files/src/pipelines/template.test.ts`
holds to the contract) and in Python (`python/`), with `sample.lx9`.
`scripts/probe-own-python-pipeline.sh <parser image>` runs the Python one
in a built parser image from a read-only mount, as a box does: run it on
every round that builds the image, with
`scripts/probe-parser-large-image.sh <parser image>` (the pictures of a
page that is one very large image, under 2 GB and one CPU, stricter than
the defaults).

**A Bun step** exports `step(request, job)`, as a built-in's: it gets the
job handle (`bytes()`, `dir`, `deadline`, and the parser's native helpers).
It may import its own files and `node:` modules. A bare import of an npm
name fails to load: the job starts with `--no-install`, so Bun never tries
to fetch it (and the parser has no route out). A package that needs a
library carries it in its tree. An import of the image's own code by its
absolute path loads today and breaks on any release: it is not promised.

**A Python step** is started by the job as a child in the job's own process
group, with the parser's Python (the venv of the image, `/opt/cad`, with
numpy, OpenCV, ezdxf, matplotlib, and Pillow, which matplotlib brings; the
image's libtiff reads a 1-bit TIFF strip by strip), the job's folder as its one argument
and its working folder. It reads `request.json` and `in.bin` there and
writes `result.json`: the same `status` and `calls` as a Bun step. Its
environment is the child's (no setting of the parser), with no bytecode
written. One job, one result check (`checkStepResult`), one failure count,
for both languages.

**Install.** `pipeline_install { files }` (`POST /api/pipelines`) checks,
in order: the curated switch, the mount, the package, the id (never a
built-in's) and the extensions (none another Reader reads), and the
version. A version names one package: a higher version replaces the one
installed (its options that still fit the new spec, its off list and its
count stay); the same version with the same files writes the folder only
when it is not on disk, and nothing else; the same version with other files, or a lower one, is
refused. Web writes the folder `<id>/<version>/` (a temporary folder
`<id>/.tmp-<uuid>`, then one rename), then the row
(`pipeline_state.package`, migration 0376) in one upsert at the full-route
spot `pipeline-package`, then removes every other name in `<id>/` but the
version before: the version before stays, so a job sent with it before the
install still finds its code, and a temporary folder a crash left goes. The
same version with the same files writes the folder only when it is not on
disk; when it is, the install changes nothing and says so. A live folder
is never swapped. An install and a remove of one id hold one advisory lock on the
id for their whole run (`underPackageLock`): two of one id run one after
the other, so a version never names two packages. The answer carries one line: "This runs code on files
of this box. You install it as you would a library." An install starts no
run: new uploads use it; for the files that are there, use `pipeline_run`.

**Test a draft.** `pipeline_test { id, file_id, files }` checks the draft
as an install does, writes it to `.drafts/<id>.<word>/` on the mount, in
place, as nothing reads it before the test sends its job (the
word the test's own, so two tests of one id never share a folder; the
parser gets the word and builds the path by the same one path function,
which checks its form), runs it in place of the installed one on one file
with nothing written, and removes the draft folder when the test ends. The
registry of the box never sees a draft, so no upload runs one, and an own
manifest may not carry the key `draft`.

**Read and remove.** `pipeline_get { id }` (`GET
/api/pipelines/:id/package`) gives the package of an own pipeline, to read
or change it; a built-in is refused, with where its code is.
`pipeline_remove { id }` (`DELETE /api/pipelines/:id`), under the lock of
the id: the row's delete, then the folder `<id>/` renamed in one step to
`.removed-<id>`, then that folder removed, then the id's drafts; the row's
delete commits last. A crash leaves the whole folder or none of it: none
with the row still there is the not-on-disk problem below, and one install
of the same files or one remove fixes it; a `.removed-<id>` a crash left
goes at the next remove of the id. A row whose id a built-in
has now keeps its row with the package cleared, so the built-in keeps its
options and off list. A remove again finds no
row and removes the folder of a half-done remove. The databases it wrote
stay, with their stamp, as off removes nothing that is there. A new upload
of its type gets no database, as before the install.

**Where the package lives.** The row is the one store, and it is in the
Postgres dump with every other row. The folder is a copy for the parser,
written by web alone: `${MANTLE_DATA_DIR}/pipelines` on the host,
`/data/pipelines` in web, and `/pipelines` in the parser, mounted read-only
(`MANTLE_PIPELINES_DIR`; on a dev host both default to the repo root's
`data/pipelines`, which web does not make: run `mkdir data/pipelines` once
in the clone, or the install refuses as on a box with no mount). No other service mounts it: they read a manifest from
its row. The parser builds a folder from three checked words only, the
id, the version and a test's draft word, and reads `pipeline.json` there with one check: its id and
version are the ones asked. A built-in id never reads the mount. A folder
that is not there is a `bad_request`, never counted. A row whose folder is
gone (a restore of Postgres alone) has the problem "The files of this
package are not on disk. Install it again with the same files.": the
registry gives it (`boxPipelines` with the disk's answer, which web, the
one process with the folder, gives), so the list, `pipeline_run`,
`pipeline_reread` and `pipeline_test` show the same problem and queue
nothing. A process with no folder asks no disk. An install of the same
files writes the folder again.

**A box whose compose file lacks the mount.** Web never makes the root
itself: the install refuses with "This box has no pipelines folder: its
compose file lacks the mount." Add the two volume lines and the two
`MANTLE_PIPELINES_DIR` lines of `docker-compose.yml` (web and parser), then
recreate the two containers.

**`noexec`.** A bind mount takes the mount options of the host's data disk.
If that disk is mounted `noexec`, a native part fails to load with the
loader's sentence; a pure Bun or Python package still runs. Check it with
`findmnt -no OPTIONS -T "$MANTLE_DATA_DIR"` on the host.

**The curated switch.** `MANTLE_PIPELINES=curated` (the box `.env`): the
install refuses with "This box runs curated pipelines only.", and every own
row is in `problems` with the same sentence and runs nothing
(`ownPipelinesAllowed`, `packages/config/src/features.ts`).

**The failure key** has the version (`pipelineRun:<id>@<version>:<sha256>`):
the second failure of version 1.0.0 is final for 1.0.0, and a fixed 1.0.1
gets its own tries.

**What the border is.** The parser container as it is: no secret, no route
out, a read-only root, one tmpfs, the time, memory and process bounds, and
the clean check after every job. Phase 3 adds one read-only mount that holds
packages only. A package can read the image's code (public), the other
packages on the mount (the Admins' own), and call the web port on the inner
network with no session, as any file read can: accepted, by the trust rule.

## Page windows

A book of 1,679 scanned pages (two files of 347 MB and 249 MB) is read by a
pipeline, not by the core's PDF read (task 8d40932a; Jason, 2026-11-18: "go
with B, add local OCR"). Five platform parts make that work for any Reader
and Agent; the built-ins on them (the router's kind `book`, the Reader
`pdf-pages`, the Agent `pdf-page-read`) are their own step.

**P1, the windows.** A pipeline that says `needs.window: { pages, mb }` (1 to
500 pages, 1 to 64 MB; a `.pdf` pipeline only) reads a PDF one window at a
time: each window a PDF of at most `pages` pages and `mb` MB of the
original, cut by qpdf in the parser (the job `pdfSplit`, docs/parser.md
"Page windows"). Every file, whatever its size: there is no size threshold
and no second path for a small book (Jason's word: 50 pages or 50 MB,
whichever comes first, `PIPELINE_WINDOW_DEFAULT`). Each window is one parser
job of the step, with the window's PDF as its body and three more fields in
the request: `pageFrom`, `pageTo` (1-based, both in) and `pagesTotal`. The
request's `file` is still the original file. A page a step names (a `Page`
cell, an ask's `page`, a `page-<N>` key) is a page of the ORIGINAL file: page
`i` of the window is page `pageFrom + i - 1`. The `state` of window 1 is the
core's; of each later window, the `state` the window before returned (a
table that runs over the edge hands its open table on). A Reader's windows
merge into one write (`mergeWindowWrite`): a tab an earlier window wrote
gets the later rows after its own, by column name (a column the first
window's tab lacks is left out, with a warning); a new tab is added; the
texts join with a blank line; the pictures add up, each window's renamed
`w<first page>-<name>`; the last description stands. A window the parser
cannot cut or the step cannot read is left out with a warning and the run
goes on from the last good state; the database's `_meta` keeps `pages_read`
and `pages_total`, so the file's status says `partial` with the pages read.
`not_mine` on window 1 is the run's answer. A busy parser fails the run, and
the extract tries again. A window job (the cut, the step) that fails is
tried once more in place before it is left out: a first timeout or crash
of one window never loses the book (its failure count is the window's
own).

A step's job handle has `pdfPageCount()` (qpdf, no pdfjs), so a router names
a file past the 256 MB pdfjs opens.

**P2, the Reader's text stands.** A Reader that claims a router's kinds and
says `produces.text` (`readerStandsOver`) stands over the core's PDF read:
for a PDF its database was written by such a Reader, the extract reads no text
of its own, runs no native read, no sketch read and no OCR, and stamps no
`document_unreadable` (server/api/src/agent/extract/load-body.ts). The
Reader's text is the file's text: from the run of this extract's database
pass, kept for the extract (`routedReaderRun`, no second job), else, for a
Reader that says `produces.pages`, from its pages in the database. The pages
it read are stamped as the scan OCR stamps them (`ocr`). A Reader that gave
no text leaves the file to the core's read, as before. A run of page
headings and no words is no text of the Reader's own (every page scanned or
blank: a one-page scan the book reader left to its Agent): the Reader still
stands, with the Agent's text of its pages when the database holds it, else
with no text, so the extract ends `body_too_short` and the core reads no page
the Agent reads (no page is paid twice). The Agent's run that paid for a
page of such a file sends its extract once more (`extractAgain`,
server/api/src/agent/extract/pipeline-run.ts), and the Agent's text is the
file's text. Two checks bound it: a paid page in the run, and the
`body_too_short` stamp, which a read with text takes off. No model is asked
for it but that one extract. The database's stamp
names that Reader, not the extension's reader. Such a Reader writes
the `File` tab (`pdf-file-v1`) with its kind: a read again of a PDF finds its
kind there, and a database with no `File` tab is kept as it is (`kept`).

**P3, page passages.** A pipeline that says `produces.pages` gives text by
page. A Reader writes the tab `Pages` (`PAGES_TAB`): one row a page, `Page`
(the page of the original file) and `Text`. An Agent keys its asks
`page-<N>` (`PAGE_ASK_KEY_PREFIX`) with the field `Text`, and its text of a
page stands over the Reader's. The file's passages are built from these, one
section `Page N` a page (`packages/content/src/page-passages.ts`,
`filePagesOf`), with no length cap and for a file with no stored text too,
so `read_section` and `search_chunks` cite the true page of the original
file. `data.text` keeps its 1 M cap. An Agent of page text puts no copy of
its tab in `data.agent_text`; its new answers build the passages again.

**P4, write in parts.** An Agent that says `needs.window` runs the money
rule window by window: one parser job gives the window's asks, the core
answers them (from the tab by hash, else one paid call), and the rows so far
are written with one patch before the next window, so a kill loses one
window's calls at most and the next run takes the written rows by their hash.
The cap of `needs.workers` holds for the whole file (an ask past it is not
made: `stopped: cap`). The stamp entry is set only when every ask of every
window has its answer.

**P5, a stored file.** `process_extraction` takes a file (its `node_id`): a
file the core could not read, or never read, is read again, and with P2 its
Reader's text stands, so a book costs only the summary and the embedding. A
file already indexed in full is skipped as before. `pipeline_run` runs a
Reader that claims kinds on a file of its type (the build names the kind).

**P6, local OCR.** qpdf, Tesseract with its English data, pdfplumber and
pypdfium2 are in the parser image (docs/parser.md, "Page windows").

### A book read again

A book's read can run for hours (up to 8, docs/embeddings.md "Drawings and
books have their own lanes"). Its database is written once, after the last
window, so before the stage a book that expired, or whose run a restart cut,
was read again from window 1. Now a Reader's windowed run in a real read (an
upload's extract, a run on demand, a read again: the build of a file, never a
Test or a compare) keeps each page window as it ends, and a run tried again
takes the windows kept and reads on from the first one that is not
(`packages/content/src/window-stage.ts`, `runWindowed`). A book stopped after
window 3 of 6 starts again at window 4, with no cut and no step of windows 1
to 3, and its result is the one a read in one go gives: a window given up is
kept as given up, with its warning.

- **Where.** In the folder of the file's database, beside it:
  `.file-dbs/<file id>.<sha16>.stage-<run16>-<first page>.json`, one file a
  window (`@mantle/files` file-dbs.ts). Each holds what its window gave the
  run: its pages, and either the step's result (the rows, text, warnings,
  counts, the state for the next window, its pictures) or the words of a
  window given up. It is no database: the lists of the folder never show it.
- **The key.** The file's id, the sha256 of the bytes read (checked whole
  inside each file), and the run: the Reader's id and version, the options,
  the kind the router named, the state of window 1 and the window's size. New
  bytes, another Reader version or other options take no kept window.
- **Gone.** At the end of the build of those bytes (`buildFileDatabase`,
  whatever it writes); with every name of the file on a delete or a turn to
  private (`removeFileDbNames`); and when its bytes change (the next extract
  removes the stage of other bytes, `removeOtherWindowStages`, as does the
  next build, `removeOtherFileDbNames`). Nothing else removes it and no timer
  runs.
- **Money.** The Reader's step asks no model, so no paid call is kept or
  made again here. An Agent's paid rows were already written window by window
  (P4) and are taken by their hash on its next run.

## The book reader

The built-ins on the page windows (M3 of the large-PDF plan, dev-brain page
4ff4d4e5): the router's kind `book`, the Reader `pdf-pages` and the Agent
`pdf-page-read`. None of them asks a model but the Agent, and the Agent asks
only for the pages OCR could not read well.

**The kind `book`** (`bookOf`, `packages/files/src/pdf-kind.ts`;
`PDF_KIND_RULES_VERSION` 5). Every office PDF is a book, whatever its size
(Jason, 2026-11-19): typed or scanned, of 1 page or 1,679. The router names a
PDF a book, with no ask, when the file is past the 256 MB pdfjs opens; when it
has more than 20 pages (`job.pdfPageCount`, qpdf) and of its first 20 pages,
read as every page is, 80% or more are on office paper (A4, Letter, A3; a
fold-out sheet makes no drawing set), none is a P&ID or an isometric, 80%
or more are scans or typed text, and its ruled scans (page kind `scan`) are
a fifth of them at most or tables (the rule below), so a scanned drawing set
on A4 or A3 paper stays a drawing; when the page rules name it a `document`;
and when it has 20 pages or fewer, read whole, with the same office rule and
typed or scanned text pages (page kind `document`) but for a few (75%,
`DOCUMENT_MIN_SHARE`), or its ruled scans are tables: on A4 paper, every one
the eye looked at with no slanted long lines (`TABLE_SLANT_MAX`, 0.005; an
isometric sketch has 0.02 and more) and 150 areas of text or more
(`TABLE_MIN_TEXT_AREAS`; the made-up spec table page has 267, a page of prose
about 70), so a table-heavy scanned spec is a book. A long file whose first
20 pages fail that sample (damaged pages, drawn tables with a text layer up
front) is a book too when all its pages, read whole, pass the long-file rule
(rules 5, 2026-11-20, `pdf-router` 1.2.1): a spec book of 682 pages was
named a drawing by its ruled scans before. A file stored under older rules
(its File tab's `Rules version` below 5, with no decider answer used) is
routed again on its next read, with no ask. The router names `document` no more: no PDF is left
to the core's own text read and its scan read (the Scan reader, every page,
docs/ai-workers.md "Scanned PDFs outside a book", runs only for a PDF whose
Reader gave no text). A book hands the Reader no facts:
the Reader reads the file, window by window.

What stays a drawing: a P&ID, an isometric (by its lines, or by the eye of a
scanned page), another drawing, a file of large sheets, a short scan whose
pages are all ruled (kind `scan`: a scanned sketch, a ruled form), a long
scan whose ruled pages are more than a fifth and not tables, and a file
the rules leave `unsure`. They keep `drawing-pdf` and `pdf-sheet-read`
exactly as before. An ambiguous scan, short or long, some text pages and
some ruled ones (`bookUnsureOf`: a spec table or a drawing form? the lines
cannot tell; a long file of letters and filled forms),
is put to the decider once where the run may ask: its `table` or `document`
makes it a book, a drawing kind keeps it a drawing, and with no ask it stays
the drawing reader's. An `unsure` file the decider calls a `table` (rows of
data: an invoice, a list) is a book too, read with its Tables tab; its
`document` makes an unsure file a book only when its pages are office paper
(A4, Letter or A3: a typed manual whose first pages hold charts); an unsure
file on drawing sheets keeps its database and the drawing reader.
Who claims what: `pdf-pages` claims `book`; `drawing-pdf` every other kind
the router names (`pid`, `pfd`, `isometric`, `equipment_drawing`,
`datasheet`, `scan`, `other_drawing`, `table` by an older read, `unsure`);
`document` is claimed by none. A stored kind from older rules is named again
with no ask on a read again, as for every rules version.

**The Reader `pdf-pages`** (Python, `server/parser/cad/pdf_pages.py`; a
window of 50 pages or 50 MB a job). For each page:

- `text`: its text layer (pdfplumber) holds 40 or more characters that are
  not spaces (the option `text_min_chars`), or fewer on a page with no
  picture over half of it that draws fewer than 10 lines, boxes and curves
  (a section divider, a title page: a typed page is never sent to a model);
- else the page is a scan, and the book reader runs no local OCR on it
  (1.3.0, owner decision 2026-11-19: "quality is of too much importance,
  let's hit the worker always"). It is drawn at 150 dpi (pypdfium2) only to
  see its shape (`page_bands`: the ink bands of ten vertical strips, after a
  3 px median), and marked `vision` for the Agent with the column `Why`
  `scan` and its `Lines` (its text lines by those bands, the free evidence
  of the Scan reader's check). A page pdfium cannot draw is `vision`, Why
  `failed`;
- `blank`: no text layer and no ink, or under 0.1% ink and no line of text
  (a speck, a stamp): no paid ask for a white page.

G1, a book's page pictures: ONE owner, the Agent `pdf-page-read`, in its
own run. The book reader writes no picture (1.2.0): it marks the pages in
its tab `Pages`, the record every later step reads. For each marked page,
window by window (only the windows that hold a page to read are cut), the
Agent's run does three things in one job, with no hand-over to another:

- **render**: the Agent's step draws the page in the parser's pdfjs child
  (200 dpi, a PNG, or a JPEG past 4 MB), with no model;
- **read**: the core answers the page's ask, from the tab `Page text` by the
  hash of the picture when it is there, else with one paid call. A page of
  Why `scan` is cut as a one-page PDF too (`job.pdfPage`, qpdf; the PDFs
  take what the pictures leave of the answer's budget, and a page whose PDF
  cannot be sent is not asked: unread, with a warning) and read by the Scan
  reader alone, with its `Lines` from the tab `Pages`
  (server/api/src/agent/extract/pipeline-ask.ts): a read the check judges
  good is the page's text; a read judged bad is a row with no text (the page
  stays unread, and a run again pays nothing for it); a page the engine
  finds mostly a figure (a picture and under 40 characters) goes on to one
  vision call, its description; with no Scan reader on the brain the page
  is skipped with no stop, unread, and the run is not done. No local OCR
  and no vision backup. The row's `Model` says which:
  `scan_reader:mistral-ocr` or the vision model. Any other marked page
  (Why `failed`, or a book read by an older reader) is read by vision;
- **save**: the core writes the page's text row, then saves the page's
  picture as one of the book's pictures (a part of the book, in its pictures
  folder, `data.bookPage` the page, `data.sourceSha256` the bytes) with that
  text as its description (`bookPagePicturesFor`,
  server/api/src/agent/extract/images.ts;
  packages/content/src/book-page-pictures.ts). A page picture never takes a
  vision call of its own (`load-body.ts`).

A page with a saved picture of these bytes that holds its text, and its
text row, is done: a run again neither draws nor asks it (the step gets the
done pages as `state.donePages`; its option `pages` still counts every
marked page from the first, so a run again reaches no further). A page whose
picture was not saved is drawn again, and its ask is answered from the tab
by hash: no second paid call. A page that could not be drawn, read (a
failed ask, the day cap) or saved stays not done, and is never saved as an
empty picture. The count is from what is saved and what is marked, never
from a run's memory: `data.images.pages = { kept, found }`, found the
pages marked `vision`, kept those with a page picture of these bytes. The
extract stamps it (so a book whose Agent has not run yet shows its marked
pages as not read), and every run of the Agent stamps it again; the book
shows `partial` until every marked page is read. The next run of the Agent
(a person's `pipeline_run`, or an upload of new bytes) reads what is left;
no timer or sweep starts one.

The core's picture pass reads a book's own pictures (figures, photos) like
any PDF's. On a page marked `vision` it leaves out the pictures that
together are painted over half the page or more (the sum of their
`pageCover`, at `IMAGE_PAGE_COVER` or more: the page's scan, whole or in
strips; withoutVisionPageScans): that page's picture is the Agent's, so no
page is pictured or read by vision twice. Every other picture is kept, a
figure on a vision page too (a picture whose cover is not known counts as
none), and its count is `data.images.embedded`. `data.images.kept` and
`found` are the sums of the two parts (extraction-status.ts,
picturesStampOf).

A window whose text layer pdfminer cannot parse is drawn page by page, and
its pages are marked for the Scan reader. The tab `Pages` holds one row a
page: `Page` (of the original file), `Paper`, `Method`, `Why`, `Chars`,
`Lines`, `Text`. The text is the pages with a `## Page N` line before each
(a scanned page has no text of its own: the Agent's stands for it). The tab
`File` holds the kind `book`, the rules version and the page count, written
by the first window read (a lost window 1 does not lose the kind).
`produces.table: false`: the upload makes no Table of these tabs.

**Tables** (the brief, section 4), of the typed pages: pdfplumber's
`find_tables`. A scanned page's tables are in its Scan reader text (one
row a line, cells split by `|`), not in tabs (1.3.0: no local OCR).
A page with no ruled lines: a run of three or more rows of
three or more word groups whose left edges fall in the same columns (a
whitespace table). A table runs on over the next page (one tab) when the
table before ran to the bottom of its page (no word under it but the
footer), it is the first table of the next page, and its header is the same
(OCR's two reads of one header are 80% alike or more), or it has no header
and the same column edges (within 2% of the page width). A new title over it
(a line in larger type than the table's own, `TITLE_SCALE`) starts a new
table though its header is the same: a spec book has one spec a page, each
with the same columns. A new table's first row is its header when it reads
as one (letters, under 15% digits, no sentence); else its columns are
`Column N` and every row is data, so the run on of a table that did not join
loses no row. Over a window edge the open table goes on through the
step's `state` (`{ open, totals }`, a few KB): the next window writes its
rows to the same tab, and the window that closes it writes its row of
`Tables`; a window lost in between ends it.

A table's tab is named by its nearest heading above it and its pages
(`SPEC X1 REV 0 p12-14`, `Table p7` with no heading; a table still open at the
end of a window is `SPEC X1 REV 0 p48 on`), cut to 48 characters of heading; a second of
a name gets ` (2)`. Every row starts with the column `Page`, the page of the
original file it came from. The tab `Tables` indexes them: `Tab`, `Title`,
`Pages`, `Rows`, `Columns`, `Method` (`text`), `Quality`, `Note`. Quality
is `ok` (every row fills the header's columns, under 10% of the cells
empty) or `partial` with a note that says which (`12 of 40 rows do not fill
the header's 6 columns`). The description of the database says how many
are partial. Libraries: MIT, Apache-2.0 or BSD only; no Camelot
(Ghostscript), Tabula or PyMuPDF.

**The Agent `pdf-page-read`** (`./pkg/pdf-page-read`). It claims the kind
`book` (`match.kind`: `runAgentOnFile` cuts no window and runs no job on a
PDF of another kind, or on a book with no page left to vision) and reads in
windows of 15 pages (P4), so its pictures (4 MB at most each) stay under
the 64 MB of one answer; a window past it fails, and its stored rows stay. The core gives its step the
pages the Reader marked `vision` (`state.visionPages`, read from the tab
`Pages` by `bookVisionPagesOf`, `packages/content/src/book-pages.ts`), so a
typed page is never asked, and of them the scanned pages
(`state.scanPages`, Why `scan`, `bookScanPagesOf`), which it sends as
one-page PDFs for the Scan reader. One ask a page, keyed `page-<N>`,
with the one field `Text`; its text stands over the Reader's for the
page's passage (P3). An Agent that says `produces.pages` asks with the token
cap of a list ask (12,000) and keeps up to 60,000 characters of a page
(`PAGE_TEXT_ANSWER_MAX_CHARS`), not a cell's 4,096: a dense page's JSON cut
at 1,500 tokens would be a failed ask that stops the run. The option `pages`
(10,000, every marked page) is the most marked pages of a file it reads, from
the first; a marked page past it is said in a warning. Only the windows that
hold a marked page are cut (`pdfWindowsAt`): each starts at the first marked
page past the window before, so one vision page in a 1,679-page book is one
cut, not 112. The box's day cap bounds a run. A
marked page that cannot be drawn ends the window `failed` (no ask); a blank
picture is not read.

How each page of a book was read is counted live from its database
(`bookPageMethodsOf`, packages/content/src/book-pages.ts): `text`, `ocr`,
`blank`, `scanReader`, `vision` and `unread` (marked for the Agent, with no
text: its run has not read it, the brain has no Scan reader, or the Scan
reader's read was judged bad). The file's processing details carry it
(`bookPages`, `file_processing`), with `noScanReader` when pages are
unread and the brain has no Scan reader: the reason.

**Tests** (made-up PDFs only). `server/parser/cad/tests/test_pdf_pages.py`
draws a book (`tests/book_pdfs.py`): prose, a table over three pages with
its header on each, a table over two pages with its header on the first
only, a table with no ruled lines, a figure and a blank page, as a scan and
as a text twin. The scan: every page with ink is the Scan reader's (Why
`scan`, with its lines), the blank page is blank, no tab and no picture, and
the reader runs no OCR. The twin: every page is `text`, nothing is asked or
drawn, the cells are exact. Two windows carry a table over their edge. The
paid ask's chain (Scan reader, figure to vision, a bad read unread, no
Scan reader skipped) is in server/api/src/agent/extract/pipeline-ask.test.ts.

## Text and pictures from every Reader

The owner's decision of 2026-11-15 ("pick 1"): the `text` and `pictures`
fields of the one write call are open to every Reader. An own Reader can
give the text and the pictures of a special document, with tabs or with
none. The built-in document readers (anydoc, mammoth, the PDF text and the
others in `packages/files/src/read-document.ts`) stay in the core.

**One run, three passes.** A Reader's run gives at most tabs, `text` and
`pictures`, and it runs once for the bytes in an extract: `readerRun`
(`packages/content/src/pipeline-runner.ts`) keeps it in the one memo of a
Reader's run (`packages/files/src/reader-memo.ts`), keyed by the pipeline's
id and version, the sha256 of the bytes, the extension and the hash of the
options; the CAD reader keeps its run there too (`cadRun`). The memo has
two queues, oldest out first: two runs of the built-in `drawing-cad`, and
two runs of all the other Readers (`READER_MEMO_MAX`), so the runs of one
never push the other's out; a failure is kept for the rest of the extract it failed in, and its
error is given back as it was thrown. The database pass runs first and
makes the run; the picture pass and the text pass take it from the memo,
so a file costs one parser job at upload. A re-extract of a file that has
its database runs the Reader once, for the text.

**Where the core has a reader, the core's stands.** One rule for each pass,
asked in one place (`readerPassOf`, `packages/content/src/reader-passes.ts`):

- The text: the Reader's `text` is the file's text when its manifest says
  `produces.text` and the core has no text route for the extension
  (`parserRouteForExt(ext) === 'none'`; `readerGivesText`). It goes in
  through `parseDocumentBytes` (`packages/files/src/parse.ts`), which the
  extract (`server/api/src/agent/extract/load-body.ts`) and the chat
  attachment helper (`packages/runtime/src/agent/attachments.ts`) call with
  the Reader. With the text in hand the extract goes on as for any
  document: summary, chunks, embedding, under their own gates and costs.
  With no text the file gets the default text (its name, type and size,
  and for an archive its entry names: docs/parser.md, "A file no reader
  takes"). The web chat takes such a file as a document.
- The pictures: the Reader's `pictures` are the file's when its manifest
  says `produces.pictures` and the core reads no pictures of the extension
  (`server/api/src/agent/extract/images.ts`). They go through the same gate
  and the same cap (`max_embedded_images_per_doc`, 30 by default) as a
  `.docx`'s, and only for new bytes, as the parser's newer picture formats:
  every picture kept is a vision call when it is indexed.
- The off list holds every pass: a Reader that is off in the file's home
  workspace gives no tabs, no text and no pictures by itself
  (`pipelineOffHere`).

**A file of text and no tabs** has no database. Its word file
(`<file id>.<sha16>.none`, `packages/files/src/file-dbs.ts`) holds the word
`no-rows` and, as a second line, the stamp of the Reader as JSON; every
reader of the word reads the first line only. The run counts. The list's
counts read that stamp, so `files` and `older` count such a file for its
Reader. `pipeline_reread` and the task `pipeline-reread` skip it with the
word `text`: a re-read rebuilds a database and keeps a file's text,
summary and chunks, so new text needs a re-extract of the file, which makes
a new summary: a person's act.

**`pipeline_test`** gives `textLength`, the length of the text a Reader
whose text is the file's gave; with no tabs, that text is the whole result
(`ok`).

**The list's `problemCode`.** Beside the `problem` sentence of an own row,
a fixed word: `not-on-disk` (send its package again with
`pipeline_install`: "Write the files again"), `curated-only`, `builtin-id`,
`ext-taken`, `manifest`. The sentences stay as they are.

**Cost.** An own Reader asks no model. What its text and pictures cost
downstream is the core's, as for any document. No model call, trigger or
timer is added, and nothing reads a file again by itself. An own Reader
cannot be the Reader of the file types the Agent `iso-title-block` reads
(tif, tiff, smf, 000): the built-in `drawing-raster` has them, so an own
row for one of them is a problem (`ext-taken`) and runs nothing (see "The
registry").

**The templates** (`docs/pipeline-template/`, made up): the LX-9 Readers in
Bun and in Python give a short `text` beside their tabs; `qnote/` is a
Reader of a made-up field note (`.qnote`) that gives its text and no tabs.
