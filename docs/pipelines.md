# Pipelines

A pipeline reads a file and writes the file's database: the read-only SQLite
that `file_sql` reads (`packages/content/src/file-database.ts`). In phase 1
the only pipelines are the readers built into the core. Their code did not
move. New are one lookup that picks the reader, and a stamp in every
database that says which reader wrote it.

The same bytes give the same tabs as before the registry.

## The contract

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
because it is in this list. `builtinForExt` is the one place that picks the
reader of a file's database, and each extension has exactly one reader.
`FILE_DB_EXTS` is the union of the readers' extensions. The list also holds
one `after` pipeline, `site-tags` (see "After pipelines" below): it reads a
reader's database, and is no reader.

| id            | Extensions     | Weight | Shapes it promises         |
| ------------- | -------------- | ------ | -------------------------- |
| `sheet`       | xlsx, xls, csv | light  | none                       |
| `plan-mspdi`  | xml            | light  | none                       |
| `drawing-pdf` | pdf            | light  | `pdf-file-v1`              |
| `plot-dwf`    | dwf            | heavy  | none                       |
| `drawing-cad` | dwg, dxf, dgn  | heavy  | `drawing-v1`, `circuit-v1` |

Each built-in has a `description` (`PipelineManifest.description`): one or
two plain sentences on what it reads and what it writes, 1 to 300
characters (`PIPELINE_DESCRIPTION_MAX`; `builtin.test.ts` holds it). It is
not in the version pin: it says nothing about the rows, as an option's
`help` does not. A router, when a later phase brings one, uses the same
field. The rule for phase 3: a pipeline or a router added through MCP with
no description is refused.

Each one runs in the core (`runtime: 'core'`), at upload, behind its adapter
in `ADAPTERS` (`packages/content/src/file-database.ts`). The special cases
stay where they were: the CSV cap before any read, the XML root check, a PDF
that is a document, and a PDF in the data files list only when asked.

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
row for each built-in, and `countsPartial`.

A row says what the pipeline reads and promises, its `description`, and
two counts: `files`,
the files with a database it read, and `older`, those that are not current
with the options in force: read at an older version, before stamps, or with
other options (`readerIsCurrent`). For an `after` pipeline, `files` are the
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
with no stamp). For an `after` pipeline they are the versions of its entries
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
- `parserPdfDrawing` sends a side of the box only when it is not the default.
  A box with the defaults sends `{}`, as before. The parser's job reads the
  box from its options; a side left out is the default.
- With a changed box, a parser older than this release ignores the side it
  does not know and reads with the default box, while the stamp still carries
  the hash of the changed box. That can happen only in the minute of the roll
  that brings this option; if such a file matters, a person reads it again.
- A caller that parses before the build passes the options too, read by
  `readerOptionsOf` (`packages/content/src/file-database.ts`, which asks for
  no state for a reader with no options): the extract
  (`server/api/src/agent/extract/auto-table.ts`) and `dwg-reindex --pdf`
  (`server/web/lib/maintenance/dwg-reindex.ts`). The sketch read
  (`server/api/src/agent/extract/pdf-sketch.ts`) reads the state itself. Their
  stamp carries the hash.
- The kind of a file does not change with the box: the corner text the
  kind's sample reads has its own fixed corner (`kindSample`,
  `packages/files/src/pdf-kind.ts`).
- The option works for every new upload. A PDF read before keeps its rows:
  a re-read of `drawing-pdf` stays refused (`pdf`) until the owner decides how
  a PDF is read again.

### The stamp keys of phase 2

The stamp keeps the four keys of phase 1. Two more are written only when they
are not empty:

| Key                | Value                                                         |
| ------------------ | ------------------------------------------------------------- |
| `pipeline_options` | the options hash of the reader, when not all are defaults     |
| `pipelines_after`  | the `after` pipelines that wrote tabs, `id@version#hash`, `,` |

So a box with the defaults writes the phase 1 stamp, key for key. An older
image reads a database with the new keys with no error: it asks for its four
keys by name.

### The state of a pipeline

The table `pipeline_state` (migration `0373_pipeline_state`, schema
`packages/db/src/schema/pipeline-state.ts`) has one row per pipeline a box
changed or that ran: its options, its attach list, who set it last, and its
count of runs. `NULL` in
`workspaces` is the default of the code.

The defaults of the code are `defaultState` in
`packages/files/src/pipelines/builtin.ts`:

- A reader is used in every workspace. In phase 2 a reader has options only.
- An `after` pipeline is attached to no workspace. It does nothing until an
  Admin attaches it to a workspace.

Off is attached to no workspace. There is no On switch: an Admin takes every
workspace out of the list.

`packages/content/src/pipeline-state.ts` is the one reader and the one writer
of the table. Nothing else reads it.

- `pipelineStateOf(ownerId, manifest)` gives `workspaces`, `options` and
  `optionsHash`: the row over the defaults, with `effectiveOptions`. A reader
  always gives `workspaces: 'all'`.
- `setPipelineState(ownerId, loginId, manifest, change)` checks the options
  with `checkOptions`, then writes one upsert. The options merge into the
  stored ones, so a change of one keeps the others. It refuses `workspaces`
  for a reader ("A reader is used in every workspace."), and a workspace that
  is not a workspace of this brain or is archived. Ids are kept lower case.

It holds no rights check of its own. The Admin check is the route's policy and
the tool's scope (area `settings`). The table holds no secret and grants no
right. It runs on the system pool, and in a scope on the narrow role: the
workspace role holds no read of it. The table has no trigger.

The attach list is a column, not a `workspace_resources` row. A built-in's id
is in the code, so SQL cannot check it, and a pipeline writes only into the
file's own database. The workspace screen does not list pipelines.

### The runs of a pipeline

A run is one write of a pipeline's result into one file's database: a
reader's build that wrote (`built`), or an `after` pipeline's patch that
wrote (`patched`). An upload, a sketch read's rebuild, a run on demand, a
re-read of the older files and the `pipeline-reread` task all count: they go
through the same two write spots of `packages/content/src/file-database.ts`,
`writeRowsOrWord` for a reader and `patchDatabaseAt` for an `after`
pipeline. A skip, a word with no rows, a failure and a test do not count.

The count is stored, because it cannot be worked out later: a second run
writes over the first. `pipeline_state` has two columns for it, `runs`
(from 0) and `last_run_at` (null until the first run). `countPipelineRun`
(`packages/content/src/pipeline-state.ts`) adds one in one upsert, and
touches no other column: `options`, `workspaces`, `updated_by` and
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

## The set: the route and the tool

`PATCH /api/pipelines/:id` changes one pipeline, and the MCP tool
`pipeline_set` does the same: both call `setPipeline`
(`packages/tools/src/pipelines.ts`), which calls `setPipelineState`. The body
is a `PipelineSetBody` (`@mantle/client-types`): `options`, `workspaces`, or
both. The tool takes `id`, `options` and `workspaces`.

- `options` names only the options to change. The others keep their value.
  Each value is checked by `checkOptions`; a refusal is a 400 with its
  sentence, and nothing is stored.
- `workspaces` replaces the attach list of an `after` pipeline. `[]`
  switches it off: it then does nothing. A reader refuses it ("A reader is
  used in every workspace.").
- The route refuses any other field of the body. An unknown id is a 404.

The answer is the pipeline's row, as in the list, with no counts (`files`
and `older` are null). A set stores the change only. It starts no run and
reads no file again: the next upload uses it.

The list shows the state of each pipeline: `kind` (`reader` or `after`),
`workspaces` (`all` for a reader), `after` (the shape an `after` pipeline
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
- An `after` pipeline reads the file's database at its own bytes, read
  only (else the word `no-database`), checks the match rule on its real
  tabs (else `no-match`), and runs its code. It reads no attach list: an
  Admin tests before the attach. Its code runs through `afterSheetsOf`
  (`file-database.ts`), the one function the patch of a real run calls too.
- `options` are checked by `checkOptions`, then used over the saved ones,
  so an Admin tries a value before the save.
- A file of an extension the pipeline does not read is `not_mine` with the
  word `no-match`; an XML that is not a plan, or a PDF that is a document,
  is `not_mine`.
- A file `file_sql` refuses (`fileDataRefusal`: a private file, set to
  stay out of the brain, or one with no checksum) is `not_mine` with the
  refusal's word (`private`, `no-sha`), and nothing of it is read, as a
  real build skips it.
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

## After pipelines

An `after` pipeline reads the tabs of a reader's database and adds tabs of
its own. It never reads the file again, it asks no model, and it runs in
this process. Its manifest has `match.after` (the shape it reads) and
`produces.tabs` (the tabs it writes, and no other). It is never the reader
of an extension: `builtinForExt` gives readers only, and it adds nothing to
`FILE_DB_EXTS`.

**The match rule.** An `after` pipeline runs on a file when the extension is
in `match.ext`, and the real tabs of the file's database carry the shape
`match.after` (`afterMatches`, on the tabs, never on the stamp). So it works
on a database with no stamp. A spreadsheet with a sheet named `Texts` is not
a match: its extension is not in the list.

**The chain at upload.** When a reader built a database
(`buildFileDatabase`), each `after` pipeline runs in the order of
`BUILTIN_PIPELINES`, with two checks: the file's home workspace is in its
attach list, and the match rule holds. Its options are the ones in force
(`pipelineStateOf`). An error is logged and never fails the build: the
reader's database stands, and the stamp has no entry for that pipeline. The
sketch read builds a PDF's database again, so the chain runs there too. The
Table a box makes from the same sheets is made from the parse result, which
the chain does not change.

**The patch: the one way to add a tab.** A file database is written whole,
so an `after` pipeline writes through a patch (`patchDocFile` in
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

**The stamp.** `pipelines_after` lists the `after` pipelines that wrote
tabs, joined by `,`. An entry is `id@version`, with `#hash` when the
options are not all the defaults: `site-tags@1.0.0#0a1b2c3d`. A patch
replaces its own entry and keeps the others. `afterIsCurrent` says whether a
database has a current entry: there, not of a lower version, and with the
same options. `readerIsCurrent` says the same for the reader's stamp, with
`pipeline_options`. Both are in `packages/files/src/pipelines/stamp.ts`, with
`stampOfMeta`, the one reader of the stamp's keys.

**Off or detached.** Taking a workspace out of the attach list removes no
tab. A person removes the tab with a read of the file again.

**Read again on demand.** `pipeline-reread --pipeline=site-tags` takes the
files of its extensions whose database carries the shape and has no current
entry, and patches them. It ignores the attach list: the person who runs
the task picked the files. The caps and the dry run are as for a reader. It
runs on a PDF too: the patch keeps every row.

## Site tags

The first `after` pipeline, `site-tags`. It reads the `Texts` tab of a CAD
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

It is attached to no workspace until an Admin attaches it. A box that never
sets it is as before: no tab, and no new stamp key. The one cost: each
build of a CAD drawing or a PDF reads `pipeline_state` once for it, also with no
row, to learn the attach list.

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

**Bounds.** A drawing's texts are outside input. One run reads at most
500,000 rows of `Texts`, one page of rows at a time; a text is cut at 4,096
characters; the texts of one run hold at most 16,000,000 characters; and
the tab holds at most 100,000 rows. Past a bound the rest is not read, and
a warning in the log says so. On a desktop the largest made-up cases take
about one second.

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
model is asked; the `after` chain then runs as at upload. For an `after`
pipeline, the run is the patch (`patchFileDatabase`). Nothing else of the file
changes: no summary, no passage, no embedding, no extract.

**The dry run comes first.** With no `apply` the answer lists `choices`: each
pipeline that can run on the files, with the count it would take, and
`refused` when it may not run. With `apply: true` and one `pipeline`, each
file it takes is queued. `skipped` counts the files the named pipeline does
not take, by word:

| Word           | Why                                                              |
| -------------- | ---------------------------------------------------------------- |
| `no-match`     | the extension, or for an `after` pipeline the tabs, do not fit   |
| `no-database`  | an `after` pipeline needs the file's database, and there is none |
| `not-attached` | the file's home workspace is not in the pipeline's attach list   |
| `no-sha`       | the file's row has no checksum                                   |
| `private`      | the file stays out of the brain                                  |
| `pdf`          | the reader of a PDF drawing, refused for now (below)             |

**The reader of a PDF drawing is refused** with the word `pdf`, as
`pipeline-reread` refuses it: a PDF's database can hold the decider's answer
and the sketch read, both paid for with a model call, and a read with no model
would lose them. Site tags on a PDF runs: the patch keeps every row.

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
`ocr-rescan`) never take a run for one. A failure is that step's error and changes
nothing. A run job is tried once: it is sent with `retryLimit: 0`, so a run
that passes its time budget, or that an api restart cuts off, fails and is
not run again by itself, and a run is never re-driven from the dead letters.
The stamp in the Data view shows what ran; run again what did not. The job
does not check the attach list again: a file that moves, or a workspace that
is detached, between the call and the job is still patched once.

**Nothing starts by itself.** Only the tool and the two routes notify, and the
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
file's stamp, with the options in force. For an `after` pipeline, a file
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
reader rebuilds with no model, an `after` pipeline patches. `skipped` counts
the older files it does not take: `pdf` (the reader `drawing-pdf` is
refused, `PIPELINE_RUN_REFUSED`, in the dry run and with `apply`: a
model-free build would lose the rows a model paid for), `private`, and
`no-sha` (the row now names other bytes, or none). `queued` is the rest.

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
