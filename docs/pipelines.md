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
model. An Agent reads tabs, asks a model, and adds its own tabs; none is
built. In the code and in the data a Transformer is `after`: the manifest
field `match.after`, the stamp key `pipelines_after`, the word
`kind: 'after'`.

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
one Transformer, `site-tags` (see "Transformers" below): it reads a
reader's database, and is no reader. And it holds one router, `pdf-router`
(see "The router" below): it names the kind of a PDF, and is no reader
either.

| id            | Extensions     | Weight | Shapes it promises         | Runs    |
| ------------- | -------------- | ------ | -------------------------- | ------- |
| `sheet`       | xlsx, xls, csv | light  | none                       | package |
| `plan-mspdi`  | xml            | light  | none                       | package |
| `pdf-router`  | pdf (a router) | light  | none                       | package |
| `drawing-pdf` | pdf            | light  | `pdf-file-v1`              | package |
| `plot-dwf`    | dwf            | heavy  | none                       | package |
| `drawing-cad` | dwg, dxf, dgn  | heavy  | `drawing-v1`, `circuit-v1` | package |
| `site-tags`   | after a reader | light  | none                       | package |

Each built-in has a `description` (`PipelineManifest.description`): one or
two plain sentences on what it reads and what it writes, 1 to 300
characters (`PIPELINE_DESCRIPTION_MAX`; `builtin.test.ts` holds it). It is
not in the version pin: it says nothing about the rows, as an option's
`help` does not. The router `pdf-router` uses the same field. The rule for
phase 3: a pipeline or a router added through MCP with no description is
refused.

Each one runs at upload. Since MV5 and MV6 every built-in is a package; a
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
the one manifest check on it each time. A built-in always wins an id or an
extension. An own row that fails the check, clashes, or sits on a curated
box is in `problems` with its sentence: it is in `all` and `byId`, so the
list shows it and the Admin can remove it, and in nothing that runs
(`readerFor`, `dbExts`, `acted`). A row whose id a built-in took is in
`problems` only: its id is the built-in's.

**Not consumers, on purpose.** The parser: its index is the image's
(`server/parser/src/pipeline-index.ts`). The CAD memo (`cadRun`,
`packages/files/src/dwg.ts`) takes the id and version of its job from the
built-in `drawing-cad`: a built-in always wins its id and its extensions,
and the memo also serves the text pass, which has no box in hand. The
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
reads the file. A router writes no tabs. It has no database and no options.
It is never run by itself: it runs only inside the read of a file, and its
runs are counted there (see "The runs" below).

In this step there is one router, `pdf-router`, built in. Its manifest has
`router: true` and `match.ext` pdf. Its rules are the PDF kind rules of
`packages/files/src/pdf-kind.ts`. They did not change, and no file's kind
changed.

**The kinds.** The router can name ten kinds (`produces.kinds`, the list
`PDF_KINDS`). The rules name six: `pid`, `isometric`, `scan`,
`other_drawing`, `document` and `unsure`. For an unsure file the decider may
also answer `pfd`, `equipment_drawing`, `datasheet` and `table`. Those four
carry the flag `decider`: only the decider's answer names them.

**The ask.** The manifest states it: `needs.workers` is `{ decider: 1 }`.
An unsure PDF asks the decider at most once, at upload, as before. No new
model call, and no new spend.

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

**Two jobs.** The router and the reader are packages since MV5 (see "The
PDF set" below): the router's job reads the page facts and names the kind,
then the job of the reader that claims it reads the page facts again and
writes the rows (`readRouted`, `packages/content/src/file-database.ts`). So
a PDF drawing is read two times, a document one time. The two answers for a
document stay different. A document by the rules gets no database and no name, so the
next extract reads it again, which costs no model. A document by the
decider's answer gets the word `no-rows`, so the file is not asked about
again.

**The runs.** The router counts a run where it names the kind in a real
read: an upload, `dwg-reindex --pdf`, and a run on demand or a re-read of a
PDF with no database of its bytes. A document counts too. A read again of a
PDF that has a database keeps its stored kind, so the router does not run
and counts none. A test counts none: it passes no `count` to
`parseFileSheets`. The sketch read counts none: it is the reader's run. The count is the `runs` and `last_run_at`
of the router's `pipeline_state` row, by `countPipelineRun`, as for a
pipeline. No new column. A failed count is logged and never fails the read.

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
  `titleBlockOf`. The router has no options: the box does not change a kind.
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

A pipeline is on in every workspace. An Admin can switch it off in a
workspace. A router has no switch: it is used wherever its readers are.

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

It is on in every workspace, as every pipeline is, until an Admin switches
it off in one. It calls no model. The cost: each build of a CAD drawing or
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
Transformer, the run is the patch (`patchFileDatabase`). Nothing else of the file
changes: no summary, no passage, no embedding, no extract.

**The dry run comes first.** With no `apply` the answer lists `choices`: each
pipeline that can run on the files, with the count it would take, and
`refused` when it may not run. With `apply: true` and one `pipeline`, each
file it takes is queued. `skipped` counts the files the named pipeline does
not take, by word. It is given when one `pipeline` is named, on a dry run
too:

| Word           | Why                                                        |
| -------------- | ---------------------------------------------------------- |
| `no-match`     | the extension, or for a Transformer the tabs, do not fit   |
| `no-database`  | a Transformer needs the file's database, and there is none |
| `not-attached` | the pipeline is off in the file's home workspace           |
| `no-sha`       | the file's row has no checksum                             |
| `private`      | the file stays out of the brain                            |

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
and the cap. With more than `EXTRACT_BUSY_JOBS` (50) extract jobs waiting, the answer is `busy: true` and nothing is queued
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
second job. A reader's run of a drawing goes on to the heavy lane by the rule
an extract follows; an `after` run stays on the main queue. The job
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
file look extracted to the sweep. The picture pass is older and still opens
a trace of the kind `extractor_run` before the extract (`stepInOwnTrace`),
for a CAD file, for a PDF or a workbook with picture candidates, and for a
file whose bytes will not load: for such a file the sweep
(`noExtractSinceWriteSql`) can take it as extracted before its extract ran.
A dead extract job is still tried again by the queue (5 tries, then the dead
letter queue, which is driven again at a start). A failure is that step's
error and changes nothing. A run job is tried once: it is sent with
`retryLimit: 0`, so a run that passes its time budget, or that an api
restart cuts off, fails and is
not run again by itself, and a run is never re-driven from the dead letters.
The stamp in the Data view shows what ran; run again what did not. The job
does not check the off list again: a file that moves, or a workspace the
pipeline is switched off in, between the call and the job is still run
once.

**Nothing starts by itself.** Only the tool and the two routes notify, and
the upload's `after` chain, once, when the parser was busy or unavailable
(model-free), and the
listener sends a job only for a notify. No cron, no trigger and no sweep at
boot takes a run. A notify sent while the api is down is lost, and the answer
said "queued": the stamp in the Data view shows what ran, so run again what
did not.

It is not a person-only act: every run of phase 2 is model-free and capped,
and the dry run comes first. A later run that may spend puts that parameter on
`packages/tools/src/person-only-acts.ts` in the same commit. The tool is MCP
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
is not a person-only act: every run of phase 2 is model-free and capped,
and the dry run comes first.

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
`pipelineRun:<id>@<version>:<sha256>` (`parserFailureKey`). Two pipelines on
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
the warning "Only the first N texts were read." when it cuts. It builds the
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
a memo by the hash of the bytes (`packages/files/src/dwg.ts`, `cadRun`; the
same size, two drawings, and the same rule for a failure: kept for the rest
of the extract's scope). The database pass (`parseFileSheets`), the text
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
The early cap on delimited text stays in the core (`parseFileSheets`,
`MANTLE_FILE_DB_CSV_MAX_MB`): text past it earns `too-large` with no job,
for every caller, and the upload makes no Table of it. The cap is by what
the bytes are, not by the name. The test is the engine's own,
`readsAsDelimited` (`packages/files/src/sheet-to-grid.ts`), which the step's
read takes too: bytes that are no workbook (no zip and no OLE2 magic),
under any name of the reader but `.xls`. So a CSV named `.xlsx` is held as
a `.csv` is. A real workbook is not held by it; it keeps its own limits.
Text named `.xls` is not either: the reader converts an `.xls` whatever its
bytes, text fails that conversion at once, and the word is `unreadable`.
A Table wanted lifted the cap until the MV3 audit, and the cap went by the
name until the audit after it: the grid came back as the job's answer
(96 MB cap), and a 55 MB CSV took about 2 GB in the parser job. `.xlsm` is
not in the reader's match list, before or after. The golden files of the
old path (`pkg/sheet/golden/`) hold the rows and the stamp.

## The PDF set as packages

`pdf-router` and `drawing-pdf` moved in MV5. The packages hold only their
`step.ts`; the four files of the PDF set (`pdf-kind.ts`, `pdf-rows.ts`,
`pdf-drawing-sheets.ts`, `pdf-sketch.ts`) are kit, because the core reads a
PDF's File tab and the decider's state with them too. Both steps read the
page facts with `readPdfDrawingInJob` (kit, `pdf-drawing.ts`): the job's
eye, its picture child, and the page budgets the old `pdfDrawing` job had.
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
(`decidedKind`). So an unsure file the decider is asked about is three jobs:
the router's two (the second reads nothing) and the reader's.

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
   import cap, whose write would be `too-large`). Then nothing is written,
   no word either, and the answer is `skipped` with the word `kept`.

Why any `no-rows` of a PDF is kept: a drawing read always has its File tab,
so for a PDF that word comes from the decider's "document", but the word
holds no source. A word that cannot be told apart is taken on the safe side.
The dry runs of `pipeline_run` and `pipeline_reread` do not look into the
database, so a dry run can count a file the run then skips.

**The sketch read is a core path that uses the reader's kit.** It has no
package, no step and no row of its own. The core starts it at the extract's
spot when it is due, as before (`sketchIngestPdfNode`,
`server/api/src/agent/extract/pdf-sketch.ts`: a sketch kind in the File
tab, no `Vision read`, the cost guard, a vision worker). It reads the page
facts again (the kit job `pdfDrawing`), and a read poorer than the first
(`pdfReadPoorer`) asks nothing and writes nothing. Else it has the scan
pages cut into pieces (the kit job `pdfPieces`: 300 DPI, then OpenCV), and
makes one vision call a packed picture, 40 at most; a call that does not run
stops the calls after it. The rows and the text of the scan are made in its
own process, and the one write is `buildFileDatabase` with `parsed`. The
Transformers of that build run only after the write, with `Vision read`
set.

Why the order, and why not steps: money. Every parser job comes before the
first vision call, and after the last one there is only code in this
process and the write. A parser that is busy, down, slow, or reads poorer
can stop the read only before anything is paid. As steps of `drawing-pdf`,
the join was a parser job after up to 40 paid calls: when it failed,
nothing was written, `Vision read` was never set, and the next try paid
again, with each retry of the queue. The runner keeps no paid answer.

**A rule of the contract, for own pipelines (phase 3):** a pipeline must not
have a parser step after a paid call. The runner does not keep paid
answers: a step that fails after a paid call makes the next try pay again.
A paid call goes in the last step that asks, and what follows it runs in
the core.

**The cost.** A PDF drawing is read two times now (the router's job and the
reader's); a document and a file the router cannot open one time. The step
module load is the rest. The bound, if the numbers ask for it, is in the
move-over design (risk 4). The sketch read's jobs are as before the move.

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
Reader's run gets no `ask`, so a worker call is answered `refused`. Its text
and pictures are not used yet (P3-2).

**The package.** One JSON value, `{ files: { path: text | { base64 } } }`:
`pipeline.json` is the manifest (text), `entry` names the step. At most 200
files and 5 MB of bytes on disk (`PIPELINE_PACKAGE_MAX_BYTES`): the install
is one JSON body, and the route's ceiling is 8 MB, so 5 MB of binary files
(6.7 MB of base64) still fit. Every path passes the one path rule
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

**A Bun step** exports `step(request, job)`, as a built-in's: it gets the
job handle (`bytes()`, `dir`, `deadline`, and the parser's native helpers).
It may import its own files and `node:` modules. A bare import of an npm
name fails to load: the job starts with `--no-install`, so Bun never tries
to fetch it (and the parser has no route out). A package that needs a
library carries it in its tree. An import of the image's own code by its
absolute path loads today and breaks on any release: it is not promised.

**A Python step** is started by the job as a child in the job's own process
group, with the parser's Python (the venv of the image, `/opt/cad`, with
numpy, OpenCV, ezdxf and matplotlib), the job's folder as its one argument
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
count stay); the same version with the same files writes the folder again
and nothing else; the same version with other files, or a lower one, is
refused. Web writes the folder `<id>/<version>/` (a temporary name, then
one rename), then the row (`pipeline_state.package`, migration 0376) in one
upsert at the full-route spot `pipeline-package`, then removes the folder
of the old version. The answer carries one line: "This runs code on files
of this box. You install it as you would a library." An install starts no
run: new uploads use it; for the files that are there, use `pipeline_run`.

**Test a draft.** `pipeline_test { id, file_id, files }` checks the draft
as an install does, writes it to `.drafts/<id>/` on the mount, runs it in
place of the installed one on one file with nothing written, and removes
the draft folder when the test ends. The registry of the box never sees a
draft, so no upload runs one.

**Read and remove.** `pipeline_get { id }` (`GET
/api/pipelines/:id/package`) gives the package of an own pipeline, to read
or change it; a built-in is refused, with where its code is.
`pipeline_remove { id }` (`DELETE /api/pipelines/:id`) removes the row
first, so nothing new runs it, then its folders. A remove again finds no
row and removes the folder of a half-done remove. The databases it wrote
stay, with their stamp, as off removes nothing that is there. A new upload
of its type gets no database, as before the install.

**Where the package lives.** The row is the one store, and it is in the
Postgres dump with every other row. The folder is a copy for the parser,
written by web alone: `${MANTLE_DATA_DIR}/pipelines` on the host,
`/data/pipelines` in web, and `/pipelines` in the parser, mounted read-only
(`MANTLE_PIPELINES_DIR`; on a dev host both default to the repo root's
`data/pipelines`). No other service mounts it: they read a manifest from
its row. The parser builds a folder from two checked words only, the id and
the version, and reads `pipeline.json` there with one check: its id and
version are the ones asked. A built-in id never reads the mount. A folder
that is not there is a `bad_request`, never counted. A row whose folder is
gone (a restore of Postgres alone) shows the problem "The files of this
package are not on disk. Install it again with the same files." in the
list: an install of the same files writes the folder again.

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
