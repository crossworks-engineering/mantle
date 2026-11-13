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
reader of a file's database, and each extension has exactly one built-in.
`FILE_DB_EXTS` is the union of their extensions.

| id            | Extensions     | Weight | Shapes it promises         |
| ------------- | -------------- | ------ | -------------------------- |
| `sheet`       | xlsx, xls, csv | light  | none                       |
| `plan-mspdi`  | xml            | light  | none                       |
| `drawing-pdf` | pdf            | light  | `pdf-file-v1`              |
| `plot-dwf`    | dwf            | heavy  | none                       |
| `drawing-cad` | dwg, dxf, dgn  | heavy  | `drawing-v1`, `circuit-v1` |

Each one runs in the core (`runtime: 'core'`), at upload, behind its adapter
in `ADAPTERS` (`packages/content/src/file-database.ts`). The special cases
stay where they were: the CSV cap before any read, the XML root check, a PDF
that is a document, and a PDF in the data files list only when asked.

## Shapes

`packages/files/src/pipelines/shapes.ts` lists the known tab shapes: the
tabs and columns a tool reads. A tab or column is needed only when its tool
fails without it today; the rest is read when it is there. `shapesOf` names
the shapes a list of tabs carries.

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

A row says what the pipeline reads and promises, and two counts: `files`,
the files with a database it read, and `older`, those read at an older
version or before stamps. The counts come from one look at the folder of
databases. The file rows are read in the caller's scope, and each stamp is
read from its database's `_meta`. A file counts when its database at its
own bytes is there; a database built before stamps counts for the built-in
of its extension. The look stops at 5,000 files and then sets
`countsPartial`. With no files mount in the process, the counts are null.
The answer holds numbers only: no file name, no id, and never a tab.

Only an Admin with the settings area sees it. The route's policy (area
`settings`) is the check, and the tool's scope is the same area. The tool
is MCP only: no tool group holds it in phase 1. It runs in the caller's
scope, not on the system pool, because it reads file rows. An API key
reaches the tool only with every area and a login that has the settings
area; no key reaches the route, as keys reach only `/api/v1` and
`/api/mcp`.

## The Data view

The files routes (`GET /api/files/files` and `GET /api/files/files/:id`)
give each file row `dataView`: whether Files shows its Data view.
`withDataView` (`packages/files/src/file-data.ts`) decides it by the rule
of `file_sql` and the Data files list: a table type; an XML only with a
name at its bytes; a PDF only with a database. So a PDF drawing has a Data
view and a PDF document has none, and the client holds no list of its own.

The Data view's first answer (`POST /api/files/files/:id/database` with no
`sql`) carries `readBy`: the pipeline's id and version from the stamp, or
null for a database built before stamps.
