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

Raise a built-in's version when the rows it writes change: a new tab or
column, a changed value, a fix that reads more of a file. Older files then
show as read by an older version, and a person can re-read them.

The version pin, `packages/files/src/pipelines/builtin.pins.json`, holds one
line for each `id@version`: a hash of the manifest's `match`, `produces` and
the shapes it promises. Its test fails when one of them changes and the
version did not. Raise the version and add a line; keep the old lines. The
pin cannot see a change deep in a reader's code: a fix that changes rows but
not the manifest needs a person to raise the version.
