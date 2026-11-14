# Options and the state of a pipeline

Pipelines phase 2. This page joins `docs/pipelines.md` at merge time, as its
section "Options and the state of a pipeline".

A pipeline can have options. Its manifest declares them. A box keeps only what
an Admin changed, in one table. A box that never sets anything behaves as
before: no row means the defaults of the code.

## Options

`PipelineManifest.options` (`packages/files/src/pipelines/contract.ts`) names
each option and its spec. There are three types:

| Type     | Value           | Its bounds                                             |
| -------- | --------------- | ------------------------------------------------------ |
| `number` | a number        | `min` to `max`                                         |
| `bool`   | yes or no       | none                                                   |
| `words`  | a list of words | at most `maxItems` (200), each at most `maxChars` (16) |

A word is upper case, 1 to `maxChars` characters of `A-Z`, `0-9`, `.`, `_`,
`/` and `-`, and starts with a letter or a digit. The check makes a word upper
case and removes doubles.

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

## The stamp

The stamp keeps the four keys of phase 1. Two more are written only when they
are not empty:

| Key                | Value                                                         |
| ------------------ | ------------------------------------------------------------- |
| `pipeline_options` | the options hash of the reader, when not all are defaults     |
| `pipelines_after`  | the `after` pipelines that wrote tabs, `id@version#hash`, `,` |

So a box with the defaults writes the phase 1 stamp, key for key. An older
image reads a database with the new keys with no error: it asks for its four
keys by name.

## The state of a pipeline

The table `pipeline_state` (migration `0373_pipeline_state`, schema
`packages/db/src/schema/pipeline-state.ts`) has one row per pipeline a box
changed: on or off, its options, its attach list, who set it last. `NULL` in
`enabled` or `workspaces` is the default of the code. `position` has no write
in phase 2: each file type has one reader, so there is nothing to rank.

The defaults of the code are `defaultState` in
`packages/files/src/pipelines/builtin.ts`:

- A reader is on, in every workspace. In phase 2 a reader cannot be turned off
  or detached; it has options only.
- An `after` pipeline is on, in no workspace. It does nothing until an Admin
  attaches it to a workspace.

`packages/content/src/pipeline-state.ts` is the one reader and the one writer
of the table. Nothing else reads it.

- `pipelineStateOf(ownerId, manifest)` gives `on`, `workspaces`, `options` and
  `optionsHash`: the row over the defaults, with `effectiveOptions`. A reader
  always gives `on: true` and `workspaces: 'all'`.
- `setPipelineState(ownerId, loginId, manifest, change)` checks the options
  with `checkOptions`, then writes one upsert. The options merge into the
  stored ones, so a change of one keeps the others. It refuses `on` and
  `workspaces` for a reader ("A reader is on in every workspace."), and a
  workspace that is not a workspace of this brain.

It holds no rights check of its own. The Admin check is the route's policy and
the tool's scope (area `settings`). The table holds no secret and grants no
right. It runs on the system pool, and in a scope on the narrow role: the
workspace role holds no read of it.

On the narrow role `enabled` only goes off, on an update or an insert: the
table carries the enable class guard of migrations 0324 and 0325
(`mantle_narrow_one_way('off:enabled')`), as `gateway_services` does. So in
an Admin's request a pipeline can be switched off, and a switch back on is
refused there (42501). The turn-on runs at a full-route spot, as every
turn-on of the repo does. The route and the tool (M2) choose that spot.

The attach list is a column, not a `workspace_resources` row. A built-in's id
is in the code, so SQL cannot check it, and a pipeline writes only into the
file's own database. The workspace screen does not list pipelines.

## Rollback

The revert, `packages/db/rollback/0373_pipeline_state.revert.sql`, keeps the
table and its rows and takes the migration off the ledger. An older image
never reads the table, so nothing must be done before the image is pinned
back.
